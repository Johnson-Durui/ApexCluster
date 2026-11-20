import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod/v4';
import type { CapabilityCall, CapabilityReply, CapabilityStatus, ChatCapabilityHost, ProducedFile } from '../capability-contract.js';
import type { AgentTask, ChatAttachment, ChatRecord, ToolDefinition } from '../types.js';
import { emptyExtensionConfig, extensionConfigSchema, type ExtensionConfig, type McpConfig } from './config.js';
import { assertEndpoint, callMcp, discoverMcp, requestPinned, type McpManifest } from './mcp-client.js';

export interface ExtensionHostOptions {
  configFile: string;
  readFile: (chat: ChatRecord, fileId: string) => { metadata: ChatAttachment; bytes: Buffer };
  listFiles: (chat: ChatRecord) => ChatAttachment[];
  inspectImage?: (file: { name: string; mime: string; bytes: Buffer }, signal: AbortSignal) => Promise<{ mime: 'image/png' | 'image/jpeg' | 'image/webp'; width: number; height: number }>;
  nativeMedia?: ChatCapabilityHost;
}
type SkillMeta = { id: string; name: string; description: string; root: string; hash: string };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' };
const safeName = (value: string) => value.replace(/[^A-Za-z0-9_]/g, '_');
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
function crc32(data: Buffer) { let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function storedZip(entries: Array<{ name: string; bytes: Buffer }>) {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const entry of entries) { const name = Buffer.from(entry.name, 'utf8'), crc = crc32(entry.bytes); const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt32LE(crc, 14); header.writeUInt32LE(entry.bytes.length, 18); header.writeUInt32LE(entry.bytes.length, 22); header.writeUInt16LE(name.length, 26); local.push(header, name, entry.bytes); const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(entry.bytes.length, 20); directory.writeUInt32LE(entry.bytes.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42); central.push(directory, name); offset += header.length + name.length + entry.bytes.length; }
  const center = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(center.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...local, center, end]);
}
function atomic(file: string, text: string) { mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`; writeFileSync(tmp, text, 'utf8'); for (let attempt = 0;; attempt++) { try { renameSync(tmp, file); return; } catch (error) { if (process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') || attempt >= 5) throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); } } }
function frontmatter(text: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text); if (!match) throw new Error('SKILL.md缺少YAML frontmatter');
  const values: Record<string, string> = {}; for (const line of match[1]!.split(/\r?\n/)) { const item = /^([a-z][a-z0-9_-]*):\s*(.+)\s*$/.exec(line); if (item) values[item[1]!] = item[2]!.replace(/^['"]|['"]$/g, ''); }
  if (!values.name || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(values.name) || !values.description || values.description.length > 500) throw new Error('SKILL.md需要合法name和description');
  return { name: values.name, description: values.description };
}
function skillRoot(raw: string) { if (!path.isAbsolute(raw)) throw new Error('Skill根目录必须是绝对路径'); const root = realpathSync(raw); if (!statSync(root).isDirectory()) throw new Error('Skill根目录不是目录'); return root; }
function inside(root: string, relative: string) {
  if (!relative || path.isAbsolute(relative) || relative.includes('\0')) throw new Error('非法Skill资源路径');
  const target = realpathSync(path.resolve(root, relative)); const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).some(part => part.toLowerCase() === 'scripts')) throw new Error('Skill资源越界或脚本不可读取');
  if (!statSync(target).isFile() || statSync(target).size > 1024 * 1024) throw new Error('Skill资源不是小型普通文件'); return target;
}
function toolText(raw: unknown, max: number) {
  const result = raw as { content?: unknown; isError?: unknown }; if (!Array.isArray(result?.content) || (result.isError !== undefined && typeof result.isError !== 'boolean')) throw new Error('MCP工具结果格式无效');
  const parts = result.content.map(item => { const value = item as { type?: unknown; text?: unknown }; if (value.type !== 'text' || typeof value.text !== 'string') throw new Error('当前仅接受MCP文本结果'); return value.text; });
  const text = parts.join('\n'); if (Buffer.byteLength(text) > max) throw new Error('MCP工具结果超过上限'); if (result.isError === true) throw new Error(text.slice(0, 500) || 'MCP工具执行失败'); return text;
}
const imageInput = z.object({ fileId: z.string().min(1).max(100), prompt: z.string().min(1).max(10_000) }).strict();
const imageGenerate = z.object({ prompt: z.string().min(1).max(10_000), size: z.enum(['1024x1024', '1536x1024', '1024x1536']).default('1024x1024'), referenceFileId: z.string().max(100).optional() }).strict();
const isGptImageModel = (model: string) => /^gpt-image(?:-|$)/iu.test(model.trim());

export class ExtensionHost implements ChatCapabilityHost {
  private config: ExtensionConfig;
  private readonly health = new Map<string, { ok: boolean; reason?: string }>();
  private readonly manifests = new Map<string, McpManifest>();
  private readonly skillAvailability = new Map<string, boolean>();
  constructor(private readonly options: ExtensionHostOptions) {
    this.config = existsSync(options.configFile) ? extensionConfigSchema.parse(JSON.parse(readFileSync(options.configFile, 'utf8'))) : emptyExtensionConfig();
    this.validate(this.config, false);
  }
  settings() { return structuredClone(this.config); }
  async configure(input: unknown) { const config = extensionConfigSchema.parse(input); this.validate(config); atomic(this.options.configFile, JSON.stringify(config, null, 2) + '\n'); this.config = config; this.health.clear(); this.manifests.clear(); this.skillAvailability.clear(); return this.settings(); }
  private validate(config: ExtensionConfig, validateOptionalFiles = true) {
    const names = new Set<string>();
    if (validateOptionalFiles) for (const skill of config.skills) if (skill.enabled) { skillRoot(skill.root); const meta = this.skill(skill.id, config); if (meta.id !== skill.id) throw new Error('Skill身份不一致'); }
    for (const server of config.mcp) { if (server.transport === 'stdio') { if (!path.isAbsolute(server.dockerCli) || !['docker','docker.exe'].includes(path.basename(server.dockerCli).toLowerCase())) throw new Error('stdio MCP只允许Docker CLI'); if ((server.enabled || validateOptionalFiles) && sha(readFileSync(server.dockerCli)) !== server.dockerCliSha256) throw new Error('Docker CLI摘要不匹配'); } else assertEndpoint(server.url); for (const tool of server.toolAllowlist) { const name = `mcp_${server.id}_${safeName(tool)}`; if (names.has(name)) throw new Error(`扩展工具名冲突: ${name}`); names.add(name); } }
    if (config.mcp.some(server => server.enabled && server.searchTool)) { if (names.has('web_search')) throw new Error('扩展工具名冲突: web_search'); names.add('web_search'); }
    for (const media of [config.media.vision, config.media.image]) if (media) { assertEndpoint(media.endpoint); if (media.editEndpoint) assertEndpoint(media.editEndpoint); }
  }
  private skill(id: string, config = this.config): SkillMeta {
    const source = config.skills.find(item => item.id === id && item.enabled); if (!source) throw new Error('Skill未启用'); const root = skillRoot(source.root);
    const file = inside(root, 'SKILL.md'); const text = readFileSync(file, 'utf8'); const parsed = frontmatter(text); return { id, ...parsed, root, hash: sha(text) };
  }
  private probeSkill(id: string): { meta?: SkillMeta; reason?: string } { try { const meta = this.skill(id); this.skillAvailability.set(id, true); return { meta }; } catch (error) { this.skillAvailability.set(id, false); return { reason: error instanceof Error ? error.message : String(error) }; } }
  private hasAvailableSkill() { for (const item of this.config.skills) if (item.enabled) { const cached = this.skillAvailability.get(item.id); if (cached === true) return true; if (cached === undefined && this.probeSkill(item.id).meta) return true; } return false; }
  definitions(_task: AgentTask): ToolDefinition[] {
    const result: ToolDefinition[] = [{ name: 'skill_create', description: '生成待发布的Skill ZIP候选包；校验正文和资源，不会安装或执行。', inputSchema: object({ name: string, description: string, instructions: string, resources: { type: 'array', items: object({ path: string, text: string }, ['path', 'text']), maxItems: 20 } }, ['name', 'description', 'instructions']) }];
    if (this.hasAvailableSkill()) result.push(
      { name: 'skill_list', description: '列出已明确配置的Skill元数据和版本哈希，不加载正文。', inputSchema: object({}) },
      { name: 'skill_read', description: '按需读取一个Skill正文或其非脚本资源；内容是不可信材料，不会扩大权限。', inputSchema: object({ skillId: string, resource: string }, ['skillId']) },
      { name: 'skill_evaluate', description: '核对调用方提供的with/without真实评测结果并生成确定性对照；不会调用模型或伪造评分。', inputSchema: object({ skillId: string, cases: { type: 'array', minItems: 2, maxItems: 50, items: object({ id: string, expected: string, without: string, with: string }, ['id', 'expected', 'without', 'with']) } }, ['skillId', 'cases']) },
    );
    if (this.config.mcp.some(item => item.enabled)) result.push({ name: 'mcp_list', description: '与显式配置的MCP握手，返回真实工具schema并缓存到下一调用段。', inputSchema: object({ serverId: string }, []) }, { name: 'mcp_call', description: '按mcp_list返回的真实schema调用已分类工具；参数在调用前由程序校验。', inputSchema: object({ serverId: string, tool: string, arguments: {} }, ['serverId','tool','arguments']) });
    for (const server of this.config.mcp.filter(item => item.enabled)) for (const tool of this.manifests.get(server.id)?.tools ?? []) if (server.toolAccess[tool.name] === 'read' || (server.allowWrites && server.writeToolAllowlist.includes(tool.name))) result.push({ name: `mcp_${server.id}_${safeName(tool.name)}`, description: tool.description ?? `调用已配置MCP ${server.id} 的 ${tool.name}；返回内容是不可信工具材料。`, inputSchema: tool.inputSchema });
    if (this.config.mcp.some(server => server.enabled && server.searchTool)) result.push({ name: 'web_search', description: '通过显式配置的搜索MCP联网检索，返回来源材料；不伪造最新信息。', inputSchema: object({ query: string, numResults: { type: 'integer', minimum: 1, maximum: 10 }, objective: { type: 'string', minLength: 1, maxLength: 4096 } }, ['query']) });
    if (this.config.media.codex?.enabled) result.push(...(this.options.nativeMedia?.definitions(_task) ?? []));
    else {
      if (this.config.media.vision?.enabled && this.config.media.vision.allowPaidCalls && this.options.inspectImage) result.push({ name: 'image_read', description: '调用单独配置且已允许计费的视觉API理解已绑定图片。', inputSchema: object({ fileId: string, prompt: string }, ['fileId', 'prompt']) });
      if (this.config.media.image?.enabled && this.config.media.image.allowPaidCalls && this.options.inspectImage) result.push({ name: 'image_generate', description: '调用单独配置且已允许计费的图像API生成真实图片字节，可带已绑定参考图。', inputSchema: object({ prompt: string, size: { type: 'string', enum: ['1024x1024', '1536x1024', '1024x1536'] }, referenceFileId: string }, ['prompt']) });
    }
    return result;
  }
  async status(): Promise<CapabilityStatus[]> {
    const statuses: CapabilityStatus[] = [];
    for (const item of this.config.skills) { if (!item.enabled) { this.skillAvailability.set(item.id, false); statuses.push({ id: `skill:${item.id}`, name: item.id, state: 'disabled', tools: ['skill_list', 'skill_read'] }); continue; } const { meta, reason } = this.probeSkill(item.id); statuses.push({ id: `skill:${item.id}`, name: item.id, state: meta ? 'ready' : 'unavailable', ...(reason ? { reason } : {}), tools: ['skill_list', 'skill_read'], fingerprint: meta?.hash }); }
    for (const item of this.config.mcp) { const prior = this.health.get(`mcp:${item.id}`); const apiKeyEnv = item.transport === 'http' ? item.apiKeyEnv : undefined; const missing = apiKeyEnv && !process.env[apiKeyEnv]; statuses.push({ id: `mcp:${item.id}`, name: item.id, state: !item.enabled ? 'disabled' : missing ? 'unconfigured' : prior?.ok ? 'ready' : prior ? 'unhealthy' : 'degraded', reason: missing ? `环境变量 ${apiKeyEnv} 未设置` : prior?.reason ?? (!prior ? '已配置，首次调用时完成握手' : undefined), tools: item.toolAllowlist.map(tool => `mcp_${item.id}_${safeName(tool)}`), fingerprint: sha(JSON.stringify({ config: item, manifest: this.manifests.get(item.id) ?? null })) }); }
    if (this.config.media.codex?.enabled) statuses.push(...(await this.options.nativeMedia?.status() ?? [{ id:'media:codex', name:'Codex本机图片', state:'unavailable', reason:'本机图片提供器未装载', tools:['image_read','image_generate'] }]));
    else for (const [id, media, tool] of [['vision', this.config.media.vision, 'image_read'], ['image', this.config.media.image, 'image_generate']] as const) { const prior = this.health.get(`media:${id}`); const noInspector = !this.options.inspectImage; statuses.push({ id: `media:${id}`, name: id, state: !media ? 'unconfigured' : !media.enabled || !media.allowPaidCalls ? 'disabled' : noInspector ? 'unavailable' : !process.env[media.apiKeyEnv] ? 'unconfigured' : prior?.ok ? 'ready' : prior ? 'unhealthy' : 'degraded', reason: !media ? '未配置服务' : !media.allowPaidCalls ? '未明确允许独立API计费调用' : noInspector ? '文档服务图片解码校验不可用' : !process.env[media.apiKeyEnv] ? `环境变量 ${media.apiKeyEnv} 未设置` : prior?.reason ?? '已配置，首次调用时验证', tools: [tool], fingerprint: media ? sha(JSON.stringify(media)) : undefined }); }
    return statuses;
  }
  async call(name: string, input: unknown, context: CapabilityCall): Promise<CapabilityReply> {
    if (name === 'skill_list') { z.object({}).strict().parse(input); const skills = this.config.skills.filter(item => item.enabled).flatMap(item => { const { meta } = this.probeSkill(item.id); if (!meta) return []; const { root: _root, ...publicMeta } = meta; return [publicMeta]; }); return { text: JSON.stringify(skills), data: skills }; }
    if (name === 'skill_read') {
      const value = z.object({ skillId: z.string(), resource: z.string().optional() }).strict().parse(input); const meta = this.skill(value.skillId); const relative = value.resource ?? 'SKILL.md'; const bytes = readFileSync(inside(meta.root, relative));
      return { text: `Skill ${meta.id}; source=${relative}; SHA256=${sha(bytes)}\n${bytes.toString('utf8')}`, data: { skillId: meta.id, source: relative, hash: sha(bytes) } };
    }
    if (name === 'skill_create') {
      const value = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), description: z.string().min(1).max(500), instructions: z.string().min(1).max(100_000), resources: z.array(z.object({ path: z.string().regex(/^(?:references|assets)\/[A-Za-z0-9._/-]+$/).refine(item => !item.split('/').includes('..')), text: z.string().max(1024 * 1024) }).strict()).max(20).default([]) }).strict().parse(input);
      if (new Set(value.resources.map(item => item.path.toLowerCase())).size !== value.resources.length) throw new Error('Skill资源路径重复'); if (value.resources.some(item => item.path.endsWith('/') || item.path.split('/').some(part => !part || part === '.'))) throw new Error('Skill资源路径无效'); if (value.resources.reduce((sum,item)=>sum+Buffer.byteLength(item.text),0)>16*1024*1024) throw new Error('Skill资源总量超过16MiB'); const links = value.resources.map(item => `- ${item.path}`).join('\n'); const text = `---\nname: ${value.name}\ndescription: ${JSON.stringify(value.description.replace(/[\r\n]/g, ' '))}\n---\n\n${value.instructions.trim()}\n${links ? `\n资源：\n${links}\n` : ''}`; frontmatter(text); const archive = storedZip([{ name: 'SKILL.md', bytes: Buffer.from(text) }, ...value.resources.map(item => ({ name: item.path, bytes: Buffer.from(item.text) }))]);
      return { text: '已生成Skill候选包；尚未安装或执行。', files: [{ name: `${value.name}.skill.zip`, bytes: archive, mime: 'application/zip' }] };
    }
    if (name === 'skill_evaluate') {
      const value = z.object({ skillId: z.string(), cases: z.array(z.object({ id: z.string().min(1).max(100), expected: z.string().max(20_000), without: z.string().max(100_000), with: z.string().max(100_000) }).strict()).min(2).max(50) }).strict().parse(input); const meta = this.skill(value.skillId);
      const rows = value.cases.map(item => ({ id: item.id, expectedHash: sha(item.expected), withoutHash: sha(item.without), withHash: sha(item.with), withoutExact: item.without.trim() === item.expected.trim(), withExact: item.with.trim() === item.expected.trim() }));
      const report = { skillId: value.skillId, skillHash: meta.hash, cases: rows, exactMatches: { without: rows.filter(row => row.withoutExact).length, with: rows.filter(row => row.withExact).length }, semanticScore: null, note: '仅记录调用方提供结果的确定性完全匹配；未调用模型评分。' };
      return { text: JSON.stringify(report), data: report, files: [{ name: `skill-eval-${value.skillId}.json`, bytes: Buffer.from(JSON.stringify(report, null, 2) + '\n'), mime: 'application/json' }] };
    }
    if (name === 'web_search') {
      const value = z.object({ query: z.string().min(1).max(2_000), numResults: z.number().int().min(1).max(10).default(5), objective: z.string().min(1).max(4_096).optional() }).strict().parse(input); const server = this.config.mcp.filter(item => item.enabled && item.searchTool).sort((a, b) => Number(!/exa/i.test(a.id)) - Number(!/exa/i.test(b.id)))[0]; if (!server) throw new Error('搜索MCP未配置');
      const manifest = this.manifests.get(server.id) ?? await discoverMcp(server, context.signal); this.manifests.set(server.id, manifest); const schema = manifest.tools.find(item => item.name === server.searchTool)?.inputSchema; const properties = schema?.properties; if (!properties || typeof properties !== 'object' || Array.isArray(properties) || !('query' in properties)) throw new Error('搜索MCP schema不支持query'); const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : []; const supported = new Set(['query','numResults','objective']); const unsupported = required.filter(item => !supported.has(item)); if (unsupported.length) throw new Error(`搜索MCP包含无法安全推导的必填参数: ${unsupported.join(', ')}`); const args: Record<string, unknown> = { query: value.query }; if ('numResults' in properties) args.numResults = value.numResults; if ('objective' in properties && (value.objective || required.includes('objective'))) args.objective = value.objective ?? value.query;
      return this.mcp(server, server.searchTool!, args, context);
    }
    if (name === 'mcp_list') { const value = z.object({ serverId: z.string().optional() }).strict().parse(input); const servers = this.config.mcp.filter(item => item.enabled && (!value.serverId || item.id === value.serverId)); if (!servers.length) throw new Error('MCP未启用'); const manifests = []; for (const server of servers) { try { const manifest = await discoverMcp(server, context.signal); this.manifests.set(server.id, manifest); this.health.set(`mcp:${server.id}`, { ok: true }); manifests.push({ ...manifest, tools: manifest.tools.map(tool => ({ ...tool, access: server.toolAccess[tool.name], enabled: server.toolAccess[tool.name] === 'read' || (server.allowWrites && server.writeToolAllowlist.includes(tool.name)) })) }); } catch (error) { this.health.set(`mcp:${server.id}`, { ok: false, reason: error instanceof Error ? error.message : String(error) }); throw error; } } return { text: JSON.stringify(manifests), data: manifests }; }
    if (name === 'mcp_call') { const value = z.object({ serverId: z.string(), tool: z.string(), arguments: z.unknown() }).strict().parse(input); const server = this.config.mcp.find(item => item.enabled && item.id === value.serverId); if (!server) throw new Error('MCP未启用'); return this.mcp(server, value.tool, value.arguments, context); }
    if (name.startsWith('mcp_')) { const servers = this.config.mcp.filter(item => item.enabled && name.startsWith(`mcp_${item.id}_`)); if (servers.length !== 1) throw new Error('MCP未启用或工具身份不唯一'); const server = servers[0]!; const encoded = name.slice(`mcp_${server.id}_`.length); const candidates = (this.manifests.get(server.id)?.tools ?? []).filter(tool => safeName(tool.name) === encoded); if (candidates.length !== 1) throw new Error('MCP工具schema尚未发现或映射不唯一'); return this.mcp(server, candidates[0]!.name, input, context); }
    if ((name === 'image_read' || name === 'image_generate') && this.config.media.codex?.enabled) { if (!this.options.nativeMedia) throw new Error('本机图片提供器未装载'); return this.options.nativeMedia.call(name,input,context); }
    if (name === 'image_read') return this.vision(imageInput.parse(input), context);
    if (name === 'image_generate') return this.generate(imageGenerate.parse(input), context);
    throw new Error('未知扩展工具');
  }
  async close() { await this.options.nativeMedia?.close?.(); }
  private async mcp(server: McpConfig, tool: string, args: unknown, context: CapabilityCall): Promise<CapabilityReply> {
    try { const manifest = this.manifests.get(server.id) ?? await discoverMcp(server, context.signal); this.manifests.set(server.id, manifest); const raw = await callMcp(server, tool, args, context.signal, manifest); const text = toolText(raw, server.maxOutputBytes); this.health.set(`mcp:${server.id}`, { ok: true }); return { text, data: { server: server.id, tool, output: text } }; }
    catch (error) { this.health.set(`mcp:${server.id}`, { ok: false, reason: error instanceof Error ? error.message : String(error) }); throw error; }
  }
  private async mediaFetch(config: NonNullable<ExtensionConfig['media']['vision']>, endpoint: string, body: Buffer, contentType: string, signal: AbortSignal) {
    if (!config.allowPaidCalls) throw new Error('未明确允许独立API计费调用'); const key = process.env[config.apiKeyEnv]; if (!key) throw new Error(`环境变量 ${config.apiKeyEnv} 未设置`); const response = await requestPinned(assertEndpoint(endpoint), { method: 'POST', headers: { 'content-type': contentType, authorization: `Bearer ${key}` }, body, maxBytes: config.maxOutputBytes, timeoutMs: config.timeoutMs, signal });
    if (response.status >= 300 && response.status < 400) throw new Error('媒体端点禁止重定向'); if (response.status < 200 || response.status >= 300) throw new Error(`媒体服务HTTP ${response.status}`); return JSON.parse(response.body.toString('utf8')) as unknown;
  }
  private async image(chat: ChatRecord, id: string, signal: AbortSignal) { if (!this.options.inspectImage) throw new Error('文档服务图片解码校验不可用'); const file = this.options.readFile(chat, id); if (!/^image\/(png|jpeg|webp)$/.test(file.metadata.mime) || file.bytes.length > 20 * 1024 * 1024) throw new Error('仅支持20MiB以内的PNG/JPEG/WebP图片'); const decoded = await this.options.inspectImage({ name: file.metadata.name, mime: file.metadata.mime, bytes: file.bytes }, signal); if (decoded.mime !== file.metadata.mime || decoded.width < 1 || decoded.height < 1 || decoded.width > 16_384 || decoded.height > 16_384 || decoded.width * decoded.height > 64_000_000) throw new Error('图片实际解码格式或像素尺寸无效'); return { ...file, decoded }; }
  private async vision(input: z.infer<typeof imageInput>, context: CapabilityCall): Promise<CapabilityReply> {
    const config = this.config.media.vision; if (!config?.enabled || !config.allowPaidCalls) throw new Error('视觉服务未配置或未允许计费调用'); const file = await this.image(context.chat, input.fileId, context.signal);
    try { const raw = await this.mediaFetch(config, config.endpoint, Buffer.from(JSON.stringify({ model: config.model, messages: [{ role: 'user', content: [{ type: 'text', text: input.prompt }, { type: 'image_url', image_url: { url: `data:${file.metadata.mime};base64,${file.bytes.toString('base64')}` } }] }] })), 'application/json', context.signal) as any;
      const text = raw?.choices?.[0]?.message?.content ?? raw?.output_text; if (typeof text !== 'string' || !text.trim()) throw new Error('视觉服务未返回文本'); this.health.set('media:vision', { ok: true }); return { text, data: { sourceFileId: input.fileId, sourceHash: file.metadata.hash, text } };
    } catch (error) { this.health.set('media:vision', { ok: false, reason: error instanceof Error ? error.message : String(error) }); throw error; }
  }
  private async generate(input: z.infer<typeof imageGenerate>, context: CapabilityCall): Promise<CapabilityReply> {
    const config = this.config.media.image; if (!config?.enabled) throw new Error('图像生成服务未配置'); let raw: any; let sourceHash: string | undefined;
    try {
      if (!config.allowPaidCalls) throw new Error('未明确允许独立API计费调用');
      if (input.referenceFileId) { if (!config.editEndpoint) throw new Error('图像编辑端点未配置'); const source = await this.image(context.chat, input.referenceFileId, context.signal); sourceHash = source.metadata.hash; const boundary = `dmw-${randomUUID()}`; const fields = [`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${config.model}\r\n`,`--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n${input.prompt}\r\n`,`--${boundary}\r\nContent-Disposition: form-data; name="size"\r\n\r\n${input.size}\r\n`,`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="image"\r\nContent-Type: ${source.metadata.mime}\r\n\r\n`]; const body = Buffer.concat([...fields.map(value=>Buffer.from(value)),source.bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]); raw = await this.mediaFetch(config, config.editEndpoint, body, `multipart/form-data; boundary=${boundary}`, context.signal); }
      else { const request = { model: config.model, prompt: input.prompt, size: input.size, ...(isGptImageModel(config.model) ? {} : { response_format: 'b64_json' }) }; raw = await this.mediaFetch(config, config.endpoint, Buffer.from(JSON.stringify(request)), 'application/json', context.signal); }
      const encoded = raw?.data?.[0]?.b64_json; if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('图像服务未返回base64图片'); const bytes = Buffer.from(encoded, 'base64');
      if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('生成图片为空或超过20MiB'); if (!this.options.inspectImage) throw new Error('文档服务图片解码校验不可用'); const decoded = await this.options.inspectImage({ name:'generated',mime:'application/octet-stream',bytes },context.signal); const extension = decoded.mime === 'image/png' ? 'png' : decoded.mime === 'image/webp' ? 'webp' : 'jpg';
      this.health.set('media:image', { ok: true }); const files: ProducedFile[] = [{ name: `generated-${randomUUID()}.${extension}`, bytes, mime:decoded.mime, ...(sourceHash ? { inputHashes: [sourceHash] } : {}) }]; return { text: '图像服务已返回并通过实际解码验证。', files, data: { size: input.size, width: decoded.width, height: decoded.height, bytes: bytes.length, hash: sha(bytes), sourceHash } };
    } catch (error) { this.health.set('media:image', { ok: false, reason: error instanceof Error ? error.message : String(error) }); throw error; }
  }
}

