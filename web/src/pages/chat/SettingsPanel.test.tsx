import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ApiChatConfiguration, ChatSettings, McpSetting } from '../../lib/chat-api';
import { ApiConfigurationStatus, mcpApiKeyHeader, MediaSettingsSection, newCodexMedia, newMedia, renameTool, selectMediaProvider, ServiceStatusList, setToolAccess, updateCodexMedia } from './SettingsPanel';
import ExecCapabilityNotice from './ExecCapabilityNotice';
import { AdvancedSection } from './settings/AdvancedSection';
import { McpSection } from './settings/McpSection';
import { SettingsSaveBar, StaleDraftPrompt } from './settings/SaveBar';
import { DocWorkerSection, RuntimeSection } from './settings/ServicesSection';
import { SkillsSection } from './settings/SkillsSection';
import { clearSettingsDraft, countSettingsChanges, dirtyLabel, readSettingsDraft, resolveSettingsDraft, settingsHash, SETTINGS_DRAFT_KEY, writeSettingsDraft } from './settings/settingsDraft';

it('shows a persistent alert for unsandboxed execution and normal status for Docker', () => {
  const unsafe = renderToStaticMarkup(<ExecCapabilityNotice capability={{ backend: 'local-unsafe', available: true, unsafe: true }} warningsOnly />);
  expect(unsafe).toContain('role="alert"');
  expect(unsafe).toContain('本机无沙箱执行');
  const docker = renderToStaticMarkup(<ExecCapabilityNotice capability={{ backend: 'docker', available: false, reason: '缺少固定镜像', unsafe: false }} />);
  expect(docker).toContain('Docker 执行沙箱');
  expect(docker).toContain('缺少固定镜像');
  expect(docker).not.toContain('role="alert"');
});

const settings = (): ChatSettings => ({
  version: 1, skills: [], mcp: [], documentWorker: { enabled: true, url: 'http://127.0.0.1:18781' },
  media: {
    vision: { enabled: true, endpoint: 'https://vision.example/v1', model: 'vision-model', apiKeyEnv: 'VISION_API_KEY', allowPaidCalls: false, timeoutMs: 30_000, maxOutputBytes: 1024 },
    image: { enabled: true, endpoint: 'https://image.example/v1', editEndpoint: 'https://image.example/edit', model: 'image-model', apiKeyEnv: 'IMAGE_API_KEY', allowPaidCalls: false, timeoutMs: 30_000, maxOutputBytes: 1024 },
  },
});

describe('chat capability settings status', () => {
  it('distinguishes ready from unconfigured and degraded services', () => {
    const html = renderToStaticMarkup(<ServiceStatusList services={[
      { id: 'docs', name: '文档服务', state: 'ready', tools: ['document_create'] },
      { id: 'vision', name: '视觉理解', state: 'unconfigured', reason: '缺少 endpoint', tools: [] },
      { id: 'search', name: '搜索', state: 'degraded', reason: '部分工具不可用', tools: ['search'] },
    ]} />);
    expect(html).toContain('文档服务');
    expect(html).toContain('已就绪');
    expect(html).toContain('未配置 · 缺少 endpoint');
    expect(html).toContain('降级运行 · 部分工具不可用');
  });

  it('does not claim readiness when no service state was returned', () => {
    const html = renderToStaticMarkup(<ServiceStatusList services={[]} />);
    expect(html).toContain('不能据此认定能力已就绪');
  });

  it('shows API key presence, model verification, roster bindings, and actionable preset blockers without secret values', () => {
    const configuration: ApiChatConfiguration = {
      mode: 'api',
      keyReadiness: [
        { provider: 'openai', env: 'OPENAI_API_KEY', configured: true },
        { provider: 'anthropic', env: 'ANTHROPIC_API_KEY', configured: false },
      ],
      modelChecks: [
        { id: 'gpt-6.1-sol', provider: 'openai', status: 'verified' },
        { id: 'claude-opus-5-5', provider: 'anthropic', status: 'stale' },
      ],
      presets: [{
        id: 'flagship', rootSeat: 'claude', available: false, reason: 'anthropic 缺少 ANTHROPIC_API_KEY',
        seats: [
          { role: 'claude', model: 'claude-fable-5-2', effort: 'high', contextHard: 240_000, available: false, reason: '缺少密钥', isolationVerified: true },
          { role: 'sol', model: 'gpt-6.1-sol', effort: 'high', contextHard: 240_000, available: true, isolationVerified: true },
        ],
      }],
    };
    const html = renderToStaticMarkup(<ApiConfigurationStatus configuration={configuration} />);
    expect(html).toContain('这里只显示环境变量是否存在，不读取或展示密钥值');
    expect(html).toContain('OPENAI_API_KEY');
    expect(html).toContain('已检测到环境变量');
    expect(html).toContain('ANTHROPIC_API_KEY');
    expect(html).toContain('请在工作台启动环境中配置后重载状态');
    expect(html).toContain('claude-opus-5-5');
    expect(html).toContain('核对已过期');
    expect(html).toContain('flagship');
    expect(html).toContain('anthropic 缺少 ANTHROPIC_API_KEY');
    expect(html).toContain('换窗上限');
    expect(html).not.toContain('sk-secret-value');
  });

  it('classifies every MCP tool and keeps the write allowlist synchronized', () => {
    const base: McpSetting = { id: 'docs', enabled: true, transport: 'http', url: 'http://127.0.0.1:3000', toolAllowlist: ['read_doc'], toolAccess: { read_doc: 'read' }, allowWrites: false, writeToolAllowlist: [], timeoutMs: 30_000, maxOutputBytes: 1024 };
    const writable = setToolAccess({ ...base, searchTool: 'read_doc' }, 'read_doc', 'write');
    expect(writable.toolAccess).toEqual({ read_doc: 'write' });
    expect(writable.writeToolAllowlist).toEqual(['read_doc']);
    expect(writable.searchTool).toBeUndefined();
    const renamed = renameTool({ ...writable, searchTool: 'read_doc' }, 'read_doc', 'write_doc');
    expect(renamed.toolAllowlist).toEqual(['write_doc']);
    expect(renamed.toolAccess).toEqual({ write_doc: 'write' });
    expect(renamed.writeToolAllowlist).toEqual(['write_doc']);
    expect(renamed.searchTool).toBe('write_doc');
  });

  it('keeps legacy MCP auth on Bearer while allowing the explicit x-api-key mode', () => {
    const legacy: McpSetting = { id: 'exa', enabled: true, transport: 'http', url: 'https://mcp.example.test', apiKeyEnv: 'DMW_TEST_MCP_AUTH_KEY', toolAllowlist: ['search'], toolAccess: { search: 'read' }, allowWrites: false, writeToolAllowlist: [], timeoutMs: 30_000, maxOutputBytes: 1024 };
    expect(mcpApiKeyHeader(legacy)).toBe('Authorization');
    expect(Object.hasOwn(legacy, 'apiKeyHeader')).toBe(false);
    expect(mcpApiKeyHeader({ ...legacy, apiKeyHeader: 'x-api-key' })).toBe('x-api-key');
  });

  it('keeps independently billed media calls disabled by default', () => {
    expect(newMedia('vision')).toMatchObject({ allowPaidCalls: false, apiKeyEnv: 'VISION_API_KEY', maxOutputBytes: 32 * 1024 * 1024 });
    expect(newMedia('image')).toMatchObject({ allowPaidCalls: false, apiKeyEnv: 'IMAGE_API_KEY', maxOutputBytes: 32 * 1024 * 1024 });
  });

  it('selects local Codex without requiring API fields or claiming availability', () => {
    const local = selectMediaProvider(settings(), 'codex');
    expect(local.media.codex).toEqual(newCodexMedia());
    const html = renderToStaticMarkup(<MediaSettingsSection settings={local} onChange={() => undefined} />);
    expect(html).toContain('本机 GPT');
    expect(html).toContain('允许使用现有订阅额度');
    expect(html).toContain('实际可用状态以上方运行状态为准');
    expect(html).not.toContain('API Key 环境变量名');
    expect(html).not.toContain('已就绪');
  });

  it('preserves inactive API settings and consent when switching providers', () => {
    const original = settings();
    const local = selectMediaProvider(original, 'codex');
    const consented = updateCodexMedia(local, { allowSubscriptionCalls: true });
    expect(consented.media.codex?.allowSubscriptionCalls).toBe(true);
    const api = selectMediaProvider(consented, 'api');
    expect(api.media.codex).toMatchObject({ enabled: false, allowSubscriptionCalls: true });
    expect(api.media.vision).toEqual(original.media.vision);
    expect(api.media.image).toEqual(original.media.image);
    expect(api.media.vision?.allowPaidCalls).toBe(false);
    expect(api.media.image?.allowPaidCalls).toBe(false);
    const html = renderToStaticMarkup(<MediaSettingsSection settings={api} onChange={() => undefined} />);
    expect(html).toContain('API Key 环境变量名');
    expect(html).toContain('vision-model');
  });
});

describe('settings draft and dirty state (BUILD-SPEC-B §6.4)', () => {
  const memory = () => {
    const values = new Map<string, string>();
    return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  };

  it('counts changed settings items, not keystrokes or key order', () => {
    const base = settings();
    expect(countSettingsChanges(base, structuredClone(base))).toBe(0);
    expect(countSettingsChanges(base, { ...base, documentWorker: { url: base.documentWorker.url, enabled: false } })).toBe(1);
    const withMcp = { ...base, mcp: [{ id: 'a', enabled: true, transport: 'http' as const, url: 'http://127.0.0.1:3000', toolAllowlist: ['search'], toolAccess: { search: 'read' as const }, allowWrites: false, writeToolAllowlist: [], timeoutMs: 1, maxOutputBytes: 1 }] };
    expect(countSettingsChanges(base, withMcp)).toBe(1);
    expect(countSettingsChanges(withMcp, { ...withMcp, mcp: [renameTool(withMcp.mcp[0], 'search', 'find')] })).toBe(1);
    expect(countSettingsChanges(base, selectMediaProvider(base, 'codex'))).toBe(1);
    expect(dirtyLabel(0)).toBe('没有未保存的更改');
    expect(dirtyLabel(2)).toBe('2 项未保存更改');
  });

  it('restores a draft made on the loaded settings, and asks first when the settings changed since (草稿基于较早读取的配置)', () => {
    const loaded = settings();
    const edited = { ...loaded, documentWorker: { ...loaded.documentWorker, url: 'http://127.0.0.1:19999' } };
    const storage = memory();
    writeSettingsDraft({ hash: settingsHash(loaded), settings: edited }, storage);
    expect(resolveSettingsDraft(readSettingsDraft(storage), loaded)).toEqual({ kind: 'restore', settings: edited });
    const changedOnServer = { ...loaded, skills: [{ id: 'team', root: 'D:\Skills', enabled: true }] };
    const stale = resolveSettingsDraft(readSettingsDraft(storage), changedOnServer);
    expect(stale.kind).toBe('stale');
    const html = renderToStaticMarkup(<StaleDraftPrompt onRestore={() => undefined} onDiscard={() => undefined} />);
    expect(html).toContain('草稿基于较早读取的配置');
    expect(html).toContain('恢复草稿');
    expect(html).toContain('放弃草稿');
    clearSettingsDraft(storage);
    expect(readSettingsDraft(storage)).toBeNull();
  });

  it('ignores missing, malformed or throwing draft storage and drops a draft equal to the loaded settings', () => {
    const loaded = settings();
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    expect(readSettingsDraft(throwing)).toBeNull();
    expect(() => writeSettingsDraft({ hash: 'x', settings: loaded }, throwing)).not.toThrow();
    const broken = memory();
    broken.setItem(SETTINGS_DRAFT_KEY, '{"hash":1}');
    expect(readSettingsDraft(broken)).toBeNull();
    expect(resolveSettingsDraft({ hash: 'old', settings: structuredClone(loaded) }, loaded)).toEqual({ kind: 'none' });
    expect(SETTINGS_DRAFT_KEY).toBe('dmw:settings:draft:v1');
  });

  it('keeps 保存设置 in a save bar that names the unsaved count and the busy-runtime rule', () => {
    const clean = renderToStaticMarkup(<SettingsSaveBar dirty={0} saving={false} error="" notice="配置已保存并重新加载运行状态。" onDiscard={() => undefined} onSave={() => undefined} />);
    expect(clean).toContain('没有未保存的更改');
    expect(clean).toContain('>保存设置</button>');
    expect(clean).toContain('role="status">配置已保存并重新加载运行状态。');
    expect(clean).toContain('有执行中或等待中的任务时，运行层会拒绝保存。');
    const dirty = renderToStaticMarkup(<SettingsSaveBar dirty={3} saving error="当前不能保存：有任务在执行" notice="" onDiscard={() => undefined} onSave={() => undefined} />);
    expect(dirty).toContain('3 项未保存更改');
    expect(dirty).toContain('保存并重载中…');
    expect(dirty).toContain('role="alert">当前不能保存：有任务在执行');
  });

  it('gives every Environment section its nav id and keeps the hooks the browser checks use', () => {
    const api = renderToStaticMarkup(<ApiConfigurationStatus />);
    expect(api).toContain('id="env-api"');
    const media = renderToStaticMarkup(<MediaSettingsSection settings={settings()} onChange={() => undefined} />);
    expect(media).toContain('id="env-media"');
    expect(media).toContain('class="panel settings-card media-provider-settings"');
    expect(media).toMatch(/name="media-provider"[^>]*value="api"/);
    expect(media).toContain('多模态服务');
    const runtime = renderToStaticMarkup(<RuntimeSection services={[]} loading={false} saving={false} dirty={0} onReload={() => undefined} />);
    expect(runtime).toContain('id="env-runtime"');
    expect(runtime).toContain('重载状态');
    const worker = renderToStaticMarkup(<DocWorkerSection settings={settings()} onChange={() => undefined} />);
    expect(worker).toContain('id="env-docworker"');
    expect(worker).toContain('本地 URL');
    expect(renderToStaticMarkup(<McpSection settings={settings()} onChange={() => undefined} />)).toContain('id="env-mcp"');
    expect(renderToStaticMarkup(<SkillsSection settings={settings()} onChange={() => undefined} />)).toContain('id="env-skills"');
    expect(renderToStaticMarkup(<AdvancedSection value="{}" onValue={() => undefined} onApply={() => undefined} />)).toContain('id="env-advanced"');
  });
});
