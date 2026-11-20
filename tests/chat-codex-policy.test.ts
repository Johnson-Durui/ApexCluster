import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCodexDiscoveryArgs,
  buildCodexIsolationArgs,
  collectAllCodexPages,
  parseCodexIsolationMetadata,
  validateCodexIsolation,
  type CodexInventory,
} from '../src/chat/codex-policy.js';

const discovery: CodexInventory = {
  mcpServers: [
    { name: 'direct_mcp', pluginId: null, runtimeStatus: null, toolCount: 2 },
    { name: 'codex_apps', pluginId: null, runtimeStatus: null, toolCount: 2 },
    { name: 'plugin_mcp', pluginId: 'p@local', runtimeStatus: null, toolCount: 2 },
  ],
  plugins: [{ id: 'p@local', enabled: true }],
};

test('Codex policy builds bare MCP keys and one complete plugin table', () => {
  const args = buildCodexIsolationArgs(discovery);
  assert.ok(args.includes('mcp_servers.direct_mcp.enabled=false'));
  assert.ok(!args.some(value => value.includes('mcp_servers.codex_apps.enabled=false')));
  assert.ok(args.includes('plugins={"p@local"={enabled=false}}'));
  assert.deepEqual(args.filter(value => value === '--disable').length >= 2, true);
  assert.throws(() => buildCodexDiscoveryArgs(['bad.name']), /Unsafe MCP/);
});

test('Codex pagination reads every page and fails closed on cycles or truncation', async () => {
  const cursors: Array<string | null> = [];
  assert.deepEqual(await collectAllCodexPages(async cursor => {
    cursors.push(cursor);
    return cursor === null ? { data: [1], nextCursor: 'next' } : { data: [2], nextCursor: null };
  }), [1, 2]);
  assert.deepEqual(cursors, [null, 'next']);
  await assert.rejects(() => collectAllCodexPages(async () => ({ data: [], nextCursor: 'same' }), 3), /Repeated/);
  await assert.rejects(() => collectAllCodexPages(async cursor => ({ data: [], nextCursor: cursor === null ? 'a' : `${cursor}a` }), 2), /did not complete/);
});

test('Codex metadata validation accepts only disabled known zero-tool surfaces', () => {
  const isolated = parseCodexIsolationMetadata({
    features: [
      { name: 'apps', enabled: false }, { name: 'plugins', enabled: false },
      { name: 'hooks', enabled: false }, { name: 'multi_agent', enabled: false }, { name: 'skill_search', enabled: false },
      { name: 'browser_use', enabled: false }, { name: 'computer_use', enabled: false }, { name: 'image_generation', enabled: false },
      { name: 'in_app_browser', enabled: false }, { name: 'skip_host_skill_discovery', enabled: true },
    ],
    profiles: [{ id: 'workbench-chat' }],
    mcpServers: discovery.mcpServers.map(server => ({ ...server, runtimeStatus: 'disabled', tools: {} })),
    plugins: [], apps: [], hooks: [],
  });
  assert.deepEqual(validateCodexIsolation(discovery, isolated), []);
  isolated.mcpServers[0]!.toolCount = 1;
  isolated.plugins.push({ id: 'unknown@remote', enabled: true });
  assert.deepEqual(validateCodexIsolation(discovery, isolated), [
    'isolated instance exposed an undiscovered plugin id',
    'a plugin remained enabled',
    'an MCP server was not disabled with zero tools',
  ]);
});

test('Codex MCP status is phase-aware without weakening the thread gate', () => {
  const make = (runtimeStatus: string | null, toolCount = 0) => parseCodexIsolationMetadata({
    features: [
      { name: 'apps', enabled: false }, { name: 'plugins', enabled: false }, { name: 'hooks', enabled: false },
      { name: 'multi_agent', enabled: false }, { name: 'skill_search', enabled: false }, { name: 'browser_use', enabled: false },
      { name: 'computer_use', enabled: false }, { name: 'image_generation', enabled: false }, { name: 'in_app_browser', enabled: false },
      { name: 'skip_host_skill_discovery', enabled: true },
    ],
    profiles: [{ id: 'workbench-chat' }],
    mcpServers: discovery.mcpServers.map(server => ({ ...server, runtimeStatus, toolCount })),
    plugins: [], apps: [], hooks: [],
  });
  assert.deepEqual(validateCodexIsolation(discovery, make(null), 'preflight'), []);
  assert.deepEqual(validateCodexIsolation(discovery, make('disabled'), 'preflight'), []);
  for (const status of ['connected', 'starting']) assert.match(validateCodexIsolation(discovery, make(status), 'preflight').join(';'), /inactive with zero tools/);
  assert.match(validateCodexIsolation(discovery, make(null, 1), 'preflight').join(';'), /inactive with zero tools/);
  assert.match(validateCodexIsolation(discovery, make(null)).join(';'), /disabled with zero tools/);
  assert.deepEqual(validateCodexIsolation(discovery, make('disabled')), []);
});

test('Codex metadata parser rejects missing, malformed, and duplicate inventories', () => {
  const valid = {
    features: [{ name: 'apps', enabled: false }], profiles: [{ id: 'workbench-chat' }],
    mcpServers: [{ name: 'm', pluginId: null, runtimeStatus: 'disabled', tools: {} }],
    plugins: [{ id: 'p', enabled: false }], apps: [{ id: 'a', enabled: false, callable: false }], hooks: [{ hooks: [] }],
  };
  assert.throws(() => parseCodexIsolationMetadata({ ...valid, apps: undefined }), /Invalid app inventory/);
  assert.throws(() => parseCodexIsolationMetadata({ ...valid, mcpServers: [{ name: 'm', pluginId: null, runtimeStatus: 'disabled' }] }), /tool inventory/);
  assert.throws(() => parseCodexIsolationMetadata({ ...valid, plugins: [{ id: 'p', enabled: false }, { id: 'p', enabled: false }] }), /Duplicate plugin/);
  assert.throws(() => parseCodexIsolationMetadata({ ...valid, hooks: [{}] }), /Invalid hook/);
  assert.throws(() => parseCodexIsolationMetadata({ ...valid, hooks: [{ hooks: [{}] }] }), /Invalid hook inventory value/);
  assert.throws(() => parseCodexIsolationMetadata({ ...valid, features: [{ name: 'apps', enabled: 0 }] }), /Invalid feature/);
});
