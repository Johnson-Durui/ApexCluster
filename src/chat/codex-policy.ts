export const CODEX_CHAT_PROFILE = 'workbench-chat';
export const CODEX_MEDIA_PROFILE = 'workbench-native-media';
const CODEX_BASE_DISABLED_FEATURES = ['hooks', 'multi_agent', 'skill_search', 'browser_use', 'computer_use', 'image_generation', 'in_app_browser'] as const;
// Fixed Codex 0.165 normalizes UnifiedExec back on unless a managed requirement
// pins it off. ShellTool is the registration gate; with it disabled, UnifiedExec
// only selects an implementation for a tool that is never registered.
const CODEX_MEDIA_EXTRA_DISABLED_FEATURES = ['shell_tool', 'view_image', 'artifact'] as const;
export const CODEX_DISABLED_FEATURES = ['apps', 'plugins', ...CODEX_BASE_DISABLED_FEATURES] as const;

export type CodexMcpInventory = { name: string; pluginId: string | null; runtimeStatus: string | null; toolCount: number };
export type CodexPluginInventory = { id: string; enabled: boolean };
export type CodexInventory = { mcpServers: CodexMcpInventory[]; plugins: CodexPluginInventory[] };
export type CodexIsolationMetadata = CodexInventory & {
  features: Map<string, boolean>;
  permissionProfileIds: string[];
  appsEnabled: string[];
  hookCount: number;
};

const CALLBACK_MCP = new Set(['codex_app', 'codex_apps', 'cua_repl']);
const DEFAULT_DIRECT_MCP = ['motionsites', 'node_repl', 'openaiDeveloperDocs', 'rea'] as const;

function safeKey(value: string, kind: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`Unsafe ${kind}: ${value}`);
  return value;
}

function pluginTable(ids: readonly string[]): string {
  for (const id of ids) if (!id || /[\u0000-\u001f]/.test(id)) throw new Error(`Unsafe plugin id: ${id}`);
  return `plugins={${[...new Set(ids)].sort().map(id => `${JSON.stringify(id)}={enabled=false}`).join(',')}}`;
}

export function buildCodexDiscoveryArgs(knownDirectMcpNames: readonly string[] = DEFAULT_DIRECT_MCP): string[] {
  return [
    '--enable', 'prefer_mxc', '--enable', 'skip_host_skill_discovery',
    ...CODEX_BASE_DISABLED_FEATURES.flatMap(name => ['--disable', name]),
    '-c', `default_permissions="${CODEX_CHAT_PROFILE}"`,
    '-c', `permissions.${CODEX_CHAT_PROFILE}.filesystem={":root"="deny",":minimal"="read",":workspace_roots"="read"}`,
    '-c', `permissions.${CODEX_CHAT_PROFILE}.network.enabled=false`,
    '-c', 'web_search="disabled"',
    '-c', 'apps._default.enabled=false',
    ...[...new Set(knownDirectMcpNames)].sort().flatMap(name => ['-c', `mcp_servers.${safeKey(name, 'MCP config key')}.enabled=false`]),
  ];
}

export function buildCodexIsolationArgs(discovery: CodexInventory): string[] {
  const pluginIds = discovery.plugins.map(plugin => plugin.id);
  const direct = discovery.mcpServers
    .filter(server => server.pluginId === null && !CALLBACK_MCP.has(server.name))
    .map(server => safeKey(server.name, 'MCP config key'));
  return [...buildCodexDiscoveryArgs(direct), '--disable', 'apps', '--disable', 'plugins', '-c', pluginTable(pluginIds)];
}

/** Separate native-image policy. Ordinary chat keeps image_generation disabled. */
export function buildCodexMediaIsolationArgs(discovery: CodexInventory): string[] {
  const pluginIds = discovery.plugins.map(plugin => plugin.id);
  const direct = discovery.mcpServers
    .filter(server => server.pluginId === null && !CALLBACK_MCP.has(server.name))
    .map(server => safeKey(server.name, 'MCP config key'));
  const disabled = [...CODEX_BASE_DISABLED_FEATURES.filter(name => name !== 'image_generation'), ...CODEX_MEDIA_EXTRA_DISABLED_FEATURES];
  return [
    '--enable', 'prefer_mxc', '--enable', 'skip_host_skill_discovery', '--enable', 'image_generation',
    ...disabled.flatMap(name => ['--disable', name]),
    '--disable', 'apps', '--disable', 'plugins',
    '-c', `default_permissions="${CODEX_MEDIA_PROFILE}"`,
    '-c', `permissions.${CODEX_MEDIA_PROFILE}.filesystem={":root"="deny",":minimal"="read",":workspace_roots"="write"}`,
    '-c', `permissions.${CODEX_MEDIA_PROFILE}.network.enabled=false`,
    '-c', 'web_search="disabled"',
    '-c', 'apps._default.enabled=false',
    '-c', pluginTable(pluginIds),
    ...[...new Set(direct)].sort().flatMap(name => ['-c', `mcp_servers.${name}.enabled=false`]),
  ];
}

export async function collectAllCodexPages<T>(
  fetch: (cursor: string | null) => Promise<{ data: T[]; nextCursor: string | null }>,
  maxPages = 100,
): Promise<T[]> {
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new Error('Invalid page limit');
  const result: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const value = await fetch(cursor);
    if (!value || !Array.isArray(value.data) || !(value.nextCursor === null || typeof value.nextCursor === 'string')) throw new Error('Invalid paginated response');
    result.push(...value.data);
    if (value.nextCursor === null) return result;
    if (!value.nextCursor || seen.has(value.nextCursor)) throw new Error('Repeated or empty pagination cursor');
    seen.add(value.nextCursor);
    cursor = value.nextCursor;
  }
  throw new Error('Pagination did not complete');
}

function strictList(value: unknown, kind: string): any[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${kind} inventory`);
  return value;
}

function unique(values: string[], kind: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${kind} inventory entry`);
}

export function parseCodexIsolationMetadata(raw: {
  features?: unknown; profiles?: unknown; mcpServers?: unknown; plugins?: unknown; apps?: unknown; hooks?: unknown;
}): CodexIsolationMetadata {
  const featureRows = strictList(raw.features, 'feature');
  const features = featureRows.map(value => {
    if (!value || typeof value.name !== 'string' || !value.name || typeof value.enabled !== 'boolean') throw new Error('Invalid feature inventory entry');
    return [value.name, value.enabled] as const;
  });
  unique(features.map(([name]) => name), 'feature');
  const permissionProfileIds = strictList(raw.profiles, 'permission profile').map(value => {
    if (!value || typeof value.id !== 'string' || !value.id) throw new Error('Invalid permission profile inventory entry');
    return value.id;
  });
  unique(permissionProfileIds, 'permission profile');
  const mcpServers = strictList(raw.mcpServers, 'MCP').map(value => {
    if (!value || typeof value.name !== 'string' || !value.name || !(value.pluginId === null || typeof value.pluginId === 'string') || !(value.runtimeStatus === null || typeof value.runtimeStatus === 'string')) throw new Error('Invalid MCP inventory entry');
    const hasTools = value.tools && typeof value.tools === 'object' && !Array.isArray(value.tools);
    const hasCount = Number.isSafeInteger(value.toolCount) && value.toolCount >= 0;
    if (!hasTools && !hasCount) throw new Error('Invalid MCP tool inventory');
    return { name: value.name, pluginId: value.pluginId, runtimeStatus: value.runtimeStatus, toolCount: hasTools ? Object.keys(value.tools).length : value.toolCount };
  });
  unique(mcpServers.map(value => value.name), 'MCP');
  const plugins = strictList(raw.plugins, 'plugin').map(value => {
    if (!value || typeof value.id !== 'string' || !value.id || typeof value.enabled !== 'boolean') throw new Error('Invalid plugin inventory entry');
    return { id: value.id, enabled: value.enabled };
  });
  unique(plugins.map(value => value.id), 'plugin');
  const apps = strictList(raw.apps, 'app').map(value => {
    if (!value || typeof value.id !== 'string' || !value.id || typeof value.enabled !== 'boolean' || typeof value.callable !== 'boolean') throw new Error('Invalid app inventory entry');
    return value;
  });
  unique(apps.map(value => value.id), 'app');
  const hookRows = strictList(raw.hooks, 'hook');
  const hookCount = hookRows.reduce((sum, value) => {
    if (!value || (!Array.isArray(value.hooks) && !Array.isArray(value.names))) throw new Error('Invalid hook inventory entry');
    const hooks = value.hooks ?? value.names;
    const validHook = (hook: unknown) => {
      if (typeof hook === 'string') return hook.length > 0;
      if (!hook || typeof hook !== 'object') return false;
      const record = hook as Record<string, unknown>;
      return ['name', 'key', 'eventName'].some(key => typeof record[key] === 'string' && (record[key] as string).length > 0);
    };
    if (hooks.some((hook: unknown) => !validHook(hook))) throw new Error('Invalid hook inventory value');
    return sum + hooks.length;
  }, 0);
  return { features: new Map(features), permissionProfileIds, mcpServers, plugins, appsEnabled: apps.filter(value => value.enabled || value.callable).map(value => value.id), hookCount };
}

export function validateCodexIsolation(discovery: CodexInventory, isolated: CodexIsolationMetadata, phase: 'preflight' | 'thread' = 'thread'): string[] {
  const failures: string[] = [];
  const pluginIds = new Set(discovery.plugins.map(plugin => plugin.id));
  const mcpNames = new Set(discovery.mcpServers.map(server => server.name));
  for (const feature of CODEX_DISABLED_FEATURES) if (isolated.features.get(feature) !== false) failures.push(`feature ${feature} was not disabled`);
  if (isolated.features.get('skip_host_skill_discovery') !== true) failures.push('skip_host_skill_discovery was not enabled');
  if (!isolated.permissionProfileIds.includes(CODEX_CHAT_PROFILE)) failures.push(`permission profile ${CODEX_CHAT_PROFILE} missing`);
  if (isolated.plugins.some(plugin => !pluginIds.has(plugin.id))) failures.push('isolated instance exposed an undiscovered plugin id');
  if (isolated.plugins.some(plugin => plugin.enabled)) failures.push('a plugin remained enabled');
  if (isolated.mcpServers.some(server => !mcpNames.has(server.name))) failures.push('isolated instance exposed an undiscovered MCP server');
  if (isolated.mcpServers.some(server => server.toolCount !== 0 || (phase === 'preflight' ? server.runtimeStatus !== null && server.runtimeStatus !== 'disabled' : server.runtimeStatus !== 'disabled'))) failures.push(`an MCP server was not ${phase === 'preflight' ? 'inactive' : 'disabled'} with zero tools`);
  if (isolated.appsEnabled.length) failures.push('an app remained enabled/callable');
  if (isolated.hookCount) failures.push('hooks remained discoverable');
  return failures;
}

export function validateCodexMediaIsolation(discovery: CodexInventory, isolated: CodexIsolationMetadata, phase: 'preflight' | 'thread' = 'thread'): string[] {
  const failures: string[] = [];
  for (const feature of CODEX_DISABLED_FEATURES) {
    const expected = feature === 'image_generation';
    if (isolated.features.get(feature) !== expected) failures.push(`feature ${feature} was not ${expected ? 'enabled' : 'disabled'}`);
  }
  for (const feature of CODEX_MEDIA_EXTRA_DISABLED_FEATURES) if (isolated.features.get(feature) !== false) failures.push(`feature ${feature} was not disabled`);
  if (isolated.features.get('skip_host_skill_discovery') !== true) failures.push('skip_host_skill_discovery was not enabled');
  if (!isolated.permissionProfileIds.includes(CODEX_MEDIA_PROFILE)) failures.push(`permission profile ${CODEX_MEDIA_PROFILE} missing`);
  const pluginIds = new Set(discovery.plugins.map(plugin => plugin.id));
  const mcpNames = new Set(discovery.mcpServers.map(server => server.name));
  if (isolated.plugins.some(plugin => !pluginIds.has(plugin.id) || plugin.enabled)) failures.push('a plugin remained enabled or undiscovered');
  if (isolated.mcpServers.some(server => !mcpNames.has(server.name))) failures.push('isolated instance exposed an undiscovered MCP server');
  if (isolated.mcpServers.some(server => server.toolCount !== 0 || (phase === 'preflight' ? server.runtimeStatus !== null && server.runtimeStatus !== 'disabled' : server.runtimeStatus !== 'disabled'))) failures.push(`an MCP server was not ${phase === 'preflight' ? 'inactive' : 'disabled'} with zero tools`);
  if (isolated.appsEnabled.length) failures.push('an app remained enabled/callable');
  if (isolated.hookCount) failures.push('hooks remained discoverable');
  return failures;
}
