// MCP 服务 (#env-mcp): common connection fields, the tool allowlist with read/write access, and write consent.
import type { ChatSettings, McpSetting } from '../../../lib/chat-api';

const lines = (value: string) => value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
export const newMcp = (index: number): McpSetting => ({ id: `mcp_${index}`, enabled: true, transport: 'http', url: 'http://127.0.0.1:3000', toolAllowlist: ['search'], toolAccess: { search: 'read' }, allowWrites: false, writeToolAllowlist: [], timeoutMs: 30_000, maxOutputBytes: 256 * 1024 });
export const mcpApiKeyHeader = (item: McpSetting) => item.apiKeyHeader ?? 'Authorization';

export function setToolAccess(item: McpSetting, tool: string, access: 'read' | 'write'): McpSetting {
  const toolAccess = { ...item.toolAccess, [tool]: access };
  const writeToolAllowlist = access === 'write' ? [...new Set([...item.writeToolAllowlist, tool])] : item.writeToolAllowlist.filter(name => name !== tool);
  return { ...item, toolAccess, writeToolAllowlist, searchTool: access === 'write' && item.searchTool === tool ? undefined : item.searchTool };
}
export function renameTool(item: McpSetting, previous: string, next: string): McpSetting {
  if (!next || next === previous || item.toolAllowlist.some(name => name === next && name !== previous)) return item;
  const access = item.toolAccess[previous] ?? 'read';
  const toolAccess = { ...item.toolAccess }; delete toolAccess[previous]; toolAccess[next] = access;
  return { ...item, toolAllowlist: item.toolAllowlist.map(name => name === previous ? next : name), toolAccess, searchTool: item.searchTool === previous ? next : item.searchTool, writeToolAllowlist: item.writeToolAllowlist.map(name => name === previous ? next : name) };
}
export function removeTool(item: McpSetting, tool: string): McpSetting {
  const toolAccess = { ...item.toolAccess }; delete toolAccess[tool];
  return { ...item, toolAllowlist: item.toolAllowlist.filter(name => name !== tool), toolAccess, searchTool: item.searchTool === tool ? undefined : item.searchTool, writeToolAllowlist: item.writeToolAllowlist.filter(name => name !== tool) };
}
/** Switching transport clears the fields that do not apply to the chosen one. */
export function changeTransport(item: McpSetting, transport: McpSetting['transport']): Partial<McpSetting> {
  return transport === 'http'
    ? { transport, url: item.url ?? 'http://127.0.0.1:3000', dockerCli: undefined, dockerCliSha256: undefined, image: undefined, serverArgs: undefined }
    : { transport, url: undefined, apiKeyEnv: undefined, apiKeyHeader: undefined, dockerCli: item.dockerCli ?? '', dockerCliSha256: item.dockerCliSha256 ?? '', image: item.image ?? '', serverArgs: item.serverArgs ?? [] };
}

// Rows are keyed by position or by a client-side key, never by a field the user edits: a key that changes on each
// keystroke remounts the row and drops focus after one character.
export function McpItem({ item, onUpdate, onRemove }: { item: McpSetting; onUpdate(patch: Partial<McpSetting>): void; onRemove(): void }) {
  const http = item.transport === 'http';
  const addTool = () => {
    let suffix = item.toolAllowlist.length + 1;
    while (item.toolAllowlist.includes(`tool_${suffix}`)) suffix += 1;
    const name = `tool_${suffix}`;
    onUpdate(setToolAccess({ ...item, toolAllowlist: [...item.toolAllowlist, name] }, name, 'read'));
  };
  return <details className="settings-item" open>
    <summary><b>{item.id || '未命名 MCP'}</b><span className={`tag${item.enabled ? '' : ' muted'}`}>{item.enabled ? http ? 'HTTP' : '隔离 Docker stdio' : '已停用'}</span></summary>
    <div className="settings-grid">
      <label className="settings-field">ID<input value={item.id} onChange={event => onUpdate({ id: event.target.value })} /></label>
      <label className="settings-field">传输<select value={item.transport} onChange={event => onUpdate(changeTransport(item, event.target.value as McpSetting['transport']))}><option value="http">HTTP</option><option value="stdio">stdio</option></select></label>
      <label className="settings-switch"><input type="checkbox" checked={item.enabled} onChange={event => onUpdate({ enabled: event.target.checked })} />启用服务</label>
      {http ? <label className="settings-field span-2">URL<input className="mono" value={item.url ?? ''} onChange={event => onUpdate({ url: event.target.value || undefined })} placeholder="http://127.0.0.1:3000" /></label> : <>
        <div className="span-2 mcp-sandbox-note"><b>隔离 Docker 服务</b><span>程序生成 Docker 创建参数；默认禁用网络且不挂载本机目录，不开放任意本机 Shell。</span></div>
        <label className="settings-field span-2">Docker CLI 绝对路径<input className="mono" value={item.dockerCli ?? ''} onChange={event => onUpdate({ dockerCli: event.target.value || undefined })} placeholder="C:\Program Files\Docker\Docker\resources\bin\docker.exe" /></label>
        <label className="settings-field span-2">Docker CLI SHA-256<input className="mono" value={item.dockerCliSha256 ?? ''} onChange={event => onUpdate({ dockerCliSha256: event.target.value || undefined })} maxLength={64} placeholder="64 位十六进制摘要" /></label>
        <label className="settings-field span-2">固定镜像摘要<input className="mono" value={item.image ?? ''} onChange={event => onUpdate({ image: event.target.value || undefined })} placeholder="vendor/server@sha256:…" /><small>必须使用 name@sha256:digest，不能使用可变 tag。</small></label>
        <label className="settings-field span-2">服务参数（每行一个）<textarea className="mono" rows={3} value={(item.serverArgs ?? []).join('\n')} onChange={event => onUpdate({ serverArgs: lines(event.target.value) })} /></label>
      </>}
      <div className="span-2 tool-access-editor">
        <div className="tool-access-heading"><span>工具白名单与访问级别</span><button type="button" className="button compact" onClick={addTool}>添加工具</button></div>
        {item.toolAllowlist.map((tool, toolIndex) => <div className="tool-access-row" key={toolIndex}>
          <input className="mono" aria-label="工具名" value={tool} onChange={event => onUpdate(renameTool(item, tool, event.target.value))} />
          <select aria-label={`${tool} 访问级别`} value={item.toolAccess?.[tool] ?? 'read'} onChange={event => onUpdate(setToolAccess(item, tool, event.target.value as 'read' | 'write'))}><option value="read">只读</option><option value="write">写入</option></select>
          <button type="button" className="ghost compact" disabled={item.toolAllowlist.length <= 1} onClick={() => onUpdate(removeTool(item, tool))}>删除</button>
        </div>)}
      </div>
      <label className="settings-field">搜索工具<select value={item.searchTool ?? ''} onChange={event => onUpdate({ searchTool: event.target.value || undefined })}><option value="">未指定</option>{item.toolAllowlist.filter(tool => (item.toolAccess?.[tool] ?? 'read') === 'read').map(tool => <option value={tool} key={tool}>{tool}</option>)}</select></label>
      {http ? <>
        <label className="settings-field">API Key 环境变量名<input className="mono" value={item.apiKeyEnv ?? ''} onChange={event => onUpdate({ apiKeyEnv: event.target.value || undefined })} autoComplete="off" /><small>只填写变量名，不填写密钥值。</small></label>
        <label className="settings-field">API Key 请求头<select value={mcpApiKeyHeader(item)} onChange={event => onUpdate({ apiKeyHeader: event.target.value as McpSetting['apiKeyHeader'] })}><option value="Authorization">Authorization: Bearer</option><option value="x-api-key">x-api-key</option></select></label>
      </> : null}
      <label className="settings-switch span-2"><input type="checkbox" checked={item.allowWrites} onChange={event => onUpdate({ allowWrites: event.target.checked })} />允许已分类的写工具</label>
      <p className="span-2 settings-help">写工具必须同时标记为“写入”、出现在程序生成的写白名单中，并启用此开关。</p>
    </div>
    <button type="button" className="ghost compact settings-remove" onClick={onRemove}>删除此 MCP</button>
  </details>;
}

export function McpSection({ settings, onChange, rowKeys }: {
  settings: ChatSettings;
  onChange(update: (current: ChatSettings) => ChatSettings): void;
  /** Stable client-side row keys, one per MCP entry (panelState carries them across edits); position otherwise. */
  rowKeys?: readonly string[];
}) {
  const update = (index: number, patch: Partial<McpSetting>) => onChange(current => ({ ...current, mcp: current.mcp.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) }));
  return <section className="panel settings-card" id="env-mcp" aria-labelledby="env-mcp-heading">
    <div className="settings-section-title">
      <div><h2 id="env-mcp-heading">MCP 服务</h2><p>常用连接项直接编辑；参数和工具名每行一个。</p></div>
      <button type="button" className="button compact" onClick={() => onChange(current => ({ ...current, mcp: [...current.mcp, newMcp(current.mcp.length + 1)] }))}>添加 MCP</button>
    </div>
    {settings.mcp.length ? <div className="settings-collection">{settings.mcp.map((item, index) => <McpItem key={rowKeys?.[index] ?? `mcp-${index}`} item={item}
      onUpdate={patch => update(index, patch)}
      onRemove={() => onChange(current => ({ ...current, mcp: current.mcp.filter((_, itemIndex) => itemIndex !== index) }))} />)}</div>
      : <p className="muted settings-empty">尚未配置 MCP 服务。</p>}
  </section>;
}
