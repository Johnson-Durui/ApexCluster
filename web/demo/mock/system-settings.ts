// Chat settings for the online demo (README.md "System endpoints"): checks a PUT /api/chat-settings body the way the server's schema does
// (src/chat/extensions/config.ts), fills the server defaults, and derives the 运行状态 services from the settings
// (simplified rules of the server's settings schema). Nothing here is stored; mock/system.ts keeps the saved copy in memory.
// The server's own refinement messages are copied verbatim; the field-level messages are written for the demo.
import type { ChatSettings, CodexMediaSetting, McpSetting, MediaSetting, ServiceCapability, SkillSetting } from '../../src/lib/chat-api';

const ID = /^[a-z][a-z0-9_-]{0,39}$/;
const TOOL = /^[A-Za-z0-9_.:-]{1,100}$/;
const ENV = /^[A-Z_][A-Z0-9_]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE = /^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9._-]+)?@sha256:[a-f0-9]{64}$/i;
const EMBEDDED_SECRET = /(?:api[-_]?key|token|secret|password|bearer|cookie)\s*[=:]/i;
const URL_CREDENTIALS = /:\/\/[^/@\s]+:[^/@\s]+@/;
const DEFAULT_WORKER = { enabled: true, url: 'http://127.0.0.1:18781' };

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const isUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 2000) return false;
  try { new URL(value); return true; } catch { return false; }
};

/** Collects issues as '<path>：<message>' and reads fields with the schema's defaults. */
class Checker {
  readonly issues: string[] = [];
  add(path: string, message: string): void { this.issues.push(path ? `${path}：${message}` : message); }

  /** Reports keys the strict schema does not allow. */
  strict(value: Obj, path: string, allowed: readonly string[]): void {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) this.add(path || '(根)', `不允许的字段 ${key}`);
  }

  bool(value: Obj, key: string, path: string, fallback: boolean): boolean {
    const raw = value[key];
    if (raw === undefined) return fallback;
    if (typeof raw !== 'boolean') { this.add(`${path}.${key}`, '必须是 true 或 false'); return fallback; }
    return raw;
  }

  int(value: Obj, key: string, path: string, min: number, max: number, fallback: number): number {
    const raw = value[key];
    if (raw === undefined) return fallback;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) { this.add(`${path}.${key}`, `必须是 ${min} 到 ${max} 之间的整数`); return fallback; }
    return raw;
  }

  text(value: Obj, key: string, path: string, pattern: RegExp | null, message: string, maxLength = 2000): string | undefined {
    const raw = value[key];
    if (typeof raw !== 'string' || !raw || raw.length > maxLength || (pattern && !pattern.test(raw))) { this.add(`${path}.${key}`, message); return undefined; }
    return raw;
  }

  optionalText(value: Obj, key: string, path: string, pattern: RegExp | null, message: string): string | undefined {
    return value[key] === undefined ? undefined : this.text(value, key, path, pattern, message);
  }

  list(value: Obj, key: string, path: string, max: number): unknown[] {
    const raw = value[key];
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) { this.add(`${path}${path ? '.' : ''}${key}`, '必须是数组'); return []; }
    if (raw.length > max) this.add(`${path}${path ? '.' : ''}${key}`, `最多 ${max} 项`);
    return raw;
  }
}

const ID_MESSAGE = '须以小写字母开头，只含小写字母、数字、_ 或 -，最长 40 个字符';
const TOOL_MESSAGE = '工具名只能含字母、数字和 _ . : -，最长 100 个字符';
const ENV_MESSAGE = '环境变量名须由大写字母、数字和下划线组成，且不能以数字开头';

function readSkill(check: Checker, raw: unknown, path: string): SkillSetting | null {
  if (!isObj(raw)) { check.add(path, '必须是对象'); return null; }
  check.strict(raw, path, ['id', 'root', 'enabled']);
  const id = check.text(raw, 'id', path, ID, ID_MESSAGE) ?? '';
  const root = check.text(raw, 'root', path, null, '根目录不能为空，最长 2000 个字符') ?? '';
  return { id, root, enabled: check.bool(raw, 'enabled', path, true) };
}

function readTools(check: Checker, raw: Obj, key: string, path: string, max: number, min: number): string[] {
  const list = check.list(raw, key, path, max);
  if (list.length < min) check.add(`${path}.${key}`, `至少 ${min} 项`);
  return list.flatMap((item, index) => {
    if (typeof item === 'string' && TOOL.test(item)) return [item];
    check.add(`${path}.${key}.${index}`, TOOL_MESSAGE);
    return [];
  });
}

function readMcp(check: Checker, raw: unknown, path: string): McpSetting | null {
  if (!isObj(raw)) { check.add(path, '必须是对象'); return null; }
  const transport = raw.transport;
  if (transport !== 'http' && transport !== 'stdio') { check.add(`${path}.transport`, '只能是 http 或 stdio'); return null; }
  const common = ['id', 'enabled', 'toolAllowlist', 'toolAccess', 'allowWrites', 'writeToolAllowlist', 'timeoutMs', 'maxOutputBytes', 'searchTool', 'transport'];
  check.strict(raw, path, transport === 'http' ? [...common, 'url', 'apiKeyEnv', 'apiKeyHeader'] : [...common, 'dockerCli', 'dockerCliSha256', 'image', 'serverArgs']);
  const toolAllowlist = readTools(check, raw, 'toolAllowlist', path, 100, 1);
  const toolAccess: Record<string, 'read' | 'write'> = {};
  if (!isObj(raw.toolAccess)) check.add(`${path}.toolAccess`, '必须是对象');
  else for (const [tool, access] of Object.entries(raw.toolAccess)) {
    if (!TOOL.test(tool) || (access !== 'read' && access !== 'write')) check.add(`${path}.toolAccess.${tool}`, '访问级别只能是 read 或 write');
    else toolAccess[tool] = access;
  }
  const item: McpSetting = {
    id: check.text(raw, 'id', path, ID, ID_MESSAGE) ?? '',
    enabled: check.bool(raw, 'enabled', path, true),
    transport,
    toolAllowlist,
    toolAccess,
    allowWrites: check.bool(raw, 'allowWrites', path, false),
    writeToolAllowlist: readTools(check, raw, 'writeToolAllowlist', path, 40, 0),
    timeoutMs: check.int(raw, 'timeoutMs', path, 1000, 60000, 30000),
    maxOutputBytes: check.int(raw, 'maxOutputBytes', path, 1024, 1024 * 1024, 256 * 1024),
  };
  const searchTool = check.optionalText(raw, 'searchTool', path, TOOL, TOOL_MESSAGE);
  if (searchTool) item.searchTool = searchTool;
  if (transport === 'http') {
    if (isUrl(raw.url)) item.url = raw.url;
    else check.add(`${path}.url`, '必须是完整的 URL');
    const apiKeyEnv = check.optionalText(raw, 'apiKeyEnv', path, ENV, ENV_MESSAGE);
    if (apiKeyEnv) item.apiKeyEnv = apiKeyEnv;
    if (raw.apiKeyHeader !== undefined) {
      if (raw.apiKeyHeader === 'Authorization' || raw.apiKeyHeader === 'x-api-key') item.apiKeyHeader = raw.apiKeyHeader;
      else check.add(`${path}.apiKeyHeader`, '只能是 Authorization 或 x-api-key');
    }
  } else {
    item.dockerCli = check.text(raw, 'dockerCli', path, null, 'Docker CLI 路径不能为空');
    item.dockerCliSha256 = check.text(raw, 'dockerCliSha256', path, SHA256, '必须是 64 位小写十六进制 SHA-256');
    item.image = check.text(raw, 'image', path, IMAGE, '必须是 name@sha256:<64 位摘要> 形式的固定镜像');
    const args = check.list(raw, 'serverArgs', path, 32);
    item.serverArgs = args.flatMap((arg, index) => {
      if (typeof arg !== 'string' || arg.length > 2000) { check.add(`${path}.serverArgs.${index}`, '必须是字符串'); return []; }
      if (EMBEDDED_SECRET.test(arg) || URL_CREDENTIALS.test(arg)) { check.add(`${path}.serverArgs.${index}`, '容器参数不能内嵌凭据'); return []; }
      return [arg];
    });
  }
  // The server's own refinements (config.ts superRefine), with its messages.
  const allowed = new Set(item.toolAllowlist);
  const writes = new Set(item.writeToolAllowlist);
  if (allowed.size !== item.toolAllowlist.length) check.add('', 'toolAllowlist包含重复工具');
  if (Object.keys(item.toolAccess).some(name => !allowed.has(name)) || item.toolAllowlist.some(name => !(name in item.toolAccess))) check.add('', 'toolAccess必须精确分类所有允许工具');
  if ([...writes].some(name => item.toolAccess[name] !== 'write') || item.toolAllowlist.some(name => item.toolAccess[name] === 'write' && !writes.has(name))) check.add('', '写工具必须同时出现在toolAccess和writeToolAllowlist');
  if (item.searchTool && (item.toolAccess[item.searchTool] !== 'read' || !allowed.has(item.searchTool))) check.add('', 'searchTool必须是已允许的只读工具');
  return item;
}

function readMedia(check: Checker, raw: unknown, path: string): MediaSetting | undefined {
  if (raw === undefined) return undefined;
  if (!isObj(raw)) { check.add(path, '必须是对象'); return undefined; }
  check.strict(raw, path, ['enabled', 'allowPaidCalls', 'endpoint', 'editEndpoint', 'model', 'apiKeyEnv', 'timeoutMs', 'maxOutputBytes']);
  const media: MediaSetting = {
    enabled: check.bool(raw, 'enabled', path, true),
    endpoint: isUrl(raw.endpoint) ? raw.endpoint : (check.add(`${path}.endpoint`, '必须是完整的 URL'), ''),
    model: check.text(raw, 'model', path, null, '模型名不能为空，最长 200 个字符', 200) ?? '',
    apiKeyEnv: check.text(raw, 'apiKeyEnv', path, ENV, ENV_MESSAGE) ?? '',
    allowPaidCalls: check.bool(raw, 'allowPaidCalls', path, false),
    timeoutMs: check.int(raw, 'timeoutMs', path, 1000, 60000, 30000),
    maxOutputBytes: check.int(raw, 'maxOutputBytes', path, 1024, 32 * 1024 * 1024, 32 * 1024 * 1024),
  };
  if (raw.editEndpoint !== undefined) {
    if (isUrl(raw.editEndpoint)) media.editEndpoint = raw.editEndpoint;
    else check.add(`${path}.editEndpoint`, '必须是完整的 URL');
  }
  return media;
}

function readCodex(check: Checker, raw: unknown, path: string): CodexMediaSetting | undefined {
  if (raw === undefined) return undefined;
  if (!isObj(raw)) { check.add(path, '必须是对象'); return undefined; }
  check.strict(raw, path, ['enabled', 'allowSubscriptionCalls', 'timeoutMs']);
  return { enabled: check.bool(raw, 'enabled', path, false), allowSubscriptionCalls: check.bool(raw, 'allowSubscriptionCalls', path, false), timeoutMs: check.int(raw, 'timeoutMs', path, 1000, 900000, 180000) };
}

/**
 * Checks a PUT body and returns the settings with the server defaults filled in, or the issues joined by '；'
 * (the server answers schema failures with 400 and the messages joined the same way, app.ts:398).
 */
export function parseSettings(body: unknown): { ok: true; settings: ChatSettings } | { ok: false; message: string } {
  const check = new Checker();
  if (!isObj(body)) return { ok: false, message: '(根)：请求体必须是 JSON 对象' };
  check.strict(body, '', ['version', 'skills', 'mcp', 'media', 'documentWorker']);
  if (body.version !== 1) check.add('version', '必须为 1');
  const skills = check.list(body, 'skills', '', 20).map((item, index) => readSkill(check, item, `skills.${index}`)).filter((item): item is SkillSetting => item !== null);
  const mcp = check.list(body, 'mcp', '', 20).map((item, index) => readMcp(check, item, `mcp.${index}`)).filter((item): item is McpSetting => item !== null);
  const media: ChatSettings['media'] = {};
  if (body.media !== undefined) {
    if (!isObj(body.media)) check.add('media', '必须是对象');
    else {
      check.strict(body.media, 'media', ['vision', 'image', 'codex']);
      const vision = readMedia(check, body.media.vision, 'media.vision');
      const image = readMedia(check, body.media.image, 'media.image');
      const codex = readCodex(check, body.media.codex, 'media.codex');
      if (vision) media.vision = vision;
      if (image) media.image = image;
      if (codex) media.codex = codex;
    }
  }
  let documentWorker = { ...DEFAULT_WORKER };
  if (body.documentWorker !== undefined) {
    if (!isObj(body.documentWorker)) check.add('documentWorker', '必须是对象');
    else {
      check.strict(body.documentWorker, 'documentWorker', ['enabled', 'url']);
      const url = body.documentWorker.url === undefined ? DEFAULT_WORKER.url : body.documentWorker.url;
      if (!isUrl(url)) check.add('documentWorker.url', '必须是完整的 URL');
      documentWorker = { enabled: check.bool(body.documentWorker, 'enabled', 'documentWorker', true), url: typeof url === 'string' ? url : DEFAULT_WORKER.url };
    }
  }
  if (new Set(skills.map(item => item.id)).size !== skills.length) check.add('', 'Skill ID重复');
  if (new Set(mcp.map(item => item.id)).size !== mcp.length) check.add('', 'MCP ID重复');
  try {
    const url = new URL(documentWorker.url);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('not local');
  } catch { check.add('', 'documentWorker只允许本机HTTP地址'); }
  if (check.issues.length) return { ok: false, message: [...new Set(check.issues)].join('；') };
  return { ok: true, settings: { version: 1, skills, mcp, media, documentWorker } };
}

// ---------------------------------------------------------------- services

/** 64 hex characters from FNV-1a over a stable JSON text (eight seeds). A stand-in for the server's sha256. */
function fingerprint(value: unknown): string {
  const text = JSON.stringify(value);
  let out = '';
  for (let seed = 0; seed < 8; seed++) {
    let hash = (0x811c9dc5 ^ Math.imul(seed + 1, 0x9e3779b1)) >>> 0;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    out += hash.toString(16).padStart(8, '0');
  }
  return out;
}

const DOCUMENT_TOOLS = ['document_read', 'document_create', 'document_convert', 'files_archive'];
const safeName = (tool: string) => tool.replace(/[^A-Za-z0-9_]/g, '_');

/**
 * The 运行状态 list for given settings, in the server's order: documents, Skills, MCP, then media. In the demo an
 * enabled, consented service is 'ready' (the real server would first probe it).
 */
export function deriveServices(settings: ChatSettings): ServiceCapability[] {
  const services: ServiceCapability[] = [{
    id: 'documents', name: '文档与Office服务', state: settings.documentWorker.enabled ? 'ready' : 'disabled', tools: [...DOCUMENT_TOOLS],
    fingerprint: fingerprint({ config: settings.documentWorker, tools: DOCUMENT_TOOLS }),
  }];
  for (const skill of settings.skills) {
    services.push({ id: `skill:${skill.id}`, name: skill.id, state: skill.enabled ? 'ready' : 'disabled', tools: ['skill_list', 'skill_read'], ...(skill.enabled ? { fingerprint: fingerprint(skill) } : {}) });
  }
  for (const item of settings.mcp) {
    services.push({ id: `mcp:${item.id}`, name: item.id, state: item.enabled ? 'ready' : 'disabled', tools: item.toolAllowlist.map(tool => `mcp_${item.id}_${safeName(tool)}`), fingerprint: fingerprint(item) });
  }
  const codex = settings.media.codex;
  if (codex?.enabled) {
    const state = codex.allowSubscriptionCalls ? 'ready' as const : 'disabled' as const;
    const reason = codex.allowSubscriptionCalls ? {} : { reason: '未明确允许本机订阅图片调用' };
    services.push({ id: 'media:vision', name: 'Codex本机图片理解', state, ...reason, tools: ['image_read'] });
    services.push({ id: 'media:image', name: 'Codex本机图片生成', state, ...reason, tools: ['image_generate'] });
    return services;
  }
  for (const [kind, tool] of [['vision', 'image_read'], ['image', 'image_generate']] as const) {
    const media = settings.media[kind];
    if (!media) services.push({ id: `media:${kind}`, name: kind, state: 'unconfigured', reason: '未配置服务', tools: [tool] });
    else if (!media.allowPaidCalls) services.push({ id: `media:${kind}`, name: kind, state: 'disabled', reason: '未明确允许独立API计费调用', tools: [tool], fingerprint: fingerprint(media) });
    else services.push({ id: `media:${kind}`, name: kind, state: media.enabled ? 'ready' : 'disabled', tools: [tool], fingerprint: fingerprint(media) });
  }
  return services;
}
