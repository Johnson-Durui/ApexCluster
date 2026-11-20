import readline from 'node:readline';
import { appendFileSync, existsSync } from 'node:fs';

if (process.argv.includes('--version')) { console.log('fake-codex 1.0'); process.exit(0); }
if (!process.argv.includes('app-server')) process.exit(1);
const isolated = process.argv.includes('plugins');
const required = ['--enable', 'prefer_mxc', 'default_permissions="workbench-chat"', 'permissions.workbench-chat.filesystem={":root"="deny",":minimal"="read",":workspace_roots"="read"}', 'permissions.workbench-chat.network.enabled=false', 'web_search="disabled"'];
for (const arg of required) if (!process.argv.includes(arg)) process.exit(3);
if (isolated && (!process.argv.includes('apps') || !process.argv.some(arg => arg.startsWith('plugins={')) || !process.argv.includes('mcp_servers.direct_mcp.enabled=false'))) process.exit(4);
appendFileSync('fake-codex-launches.jsonl', JSON.stringify({ phase: isolated ? 'isolated' : 'discovery', args: process.argv.slice(2) }) + '\n');

const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const page = (m, first, second = []) => send({ id: m.id, result: m.params?.cursor ? { data: second, nextCursor: null } : { data: first, nextCursor: second.length ? 'page-2' : null } });
const featureA = [{ name: 'apps', enabled: false }, { name: 'plugins', enabled: false }, { name: 'hooks', enabled: false }, { name: 'multi_agent', enabled: false }, { name: 'skill_search', enabled: false }, { name: 'browser_use', enabled: false }];
const featureB = [{ name: 'computer_use', enabled: false }, { name: 'image_generation', enabled: false }, { name: 'in_app_browser', enabled: false }, { name: 'skip_host_skill_discovery', enabled: true }];

readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  appendFileSync('fake-codex-rpcs.jsonl', JSON.stringify({ message: m.method ?? `response:${m.id}`, ...(m.error?.code !== undefined ? { errorCode: m.error.code } : {}) }) + '\n');
  if (m.method === 'initialize') {
    if (isolated && existsSync('unknown-preflight')) return send({ id: 88, method: 'process/spawn', params: { command: 'denied' } });
    send({ id: m.id, result: { capabilities: { experimentalApi: true } } });
  }
  else if (m.method === 'mcpServerStatus/list') {
    if (!isolated && existsSync('stall-preflight')) return;
    const disabled = name => ({ name, pluginId: null, runtimeStatus: 'disabled', tools: {} });
    if (!isolated) page(m, [{ name: 'direct_mcp', pluginId: null, runtimeStatus: null, tools: {} }], [{ name: 'codex_apps', pluginId: null, runtimeStatus: null, tools: {} }]);
    else if (m.params?.threadId) page(m, [disabled('direct_mcp')], [disabled('codex_apps')]);
    else page(m, [{ ...disabled('direct_mcp'), runtimeStatus: null }], [{ ...disabled('codex_apps'), runtimeStatus: null }]);
  }
  else if (m.method === 'plugin/installed') send({ id: m.id, result: { marketplaces: [{ plugins: isolated ? [] : [{ id: 'fake-plugin@fixture', enabled: true }] }] } });
  else if (m.method === 'experimentalFeature/list') page(m, featureA, featureB);
  else if (m.method === 'permissionProfile/list') page(m, [{ id: 'workbench-chat' }]);
  else if (m.method === 'app/installed') send({ id: m.id, result: { apps: [] } });
  else if (m.method === 'hooks/list') send({ id: m.id, result: { data: [{ cwd: process.cwd(), hooks: [] }] } });
  else if (m.method === 'thread/settings/update') send({ id: m.id, result: {} });
  else if (m.method === 'thread/start') {
    if (m.params.permissions !== 'workbench-chat' || 'sandbox' in m.params || !Array.isArray(m.params.environments) || m.params.environments.length || !Array.isArray(m.params.selectedCapabilityRoots) || m.params.selectedCapabilityRoots.length) return send({ id: m.id, error: { message: 'thread policy missing' } });
    send({ id: m.id, result: { model: m.params.model, approvalPolicy: 'never', activePermissionProfile: { id: existsSync('wrong-profile') ? 'other' : 'workbench-chat', extends: null }, thread: { id: 'thread-1', environments: [] } } });
  }
  else if (m.method === 'turn/start') {
    if (m.params.permissions !== 'workbench-chat' || 'sandboxPolicy' in m.params || !Array.isArray(m.params.environments) || m.params.environments.length) return send({ id: m.id, error: { message: 'turn policy missing' } });
    send({ id: m.id, result: { turn: { id: 'turn-1' } } });
    if (existsSync('close-during-turn')) return setImmediate(() => process.exit(7));
    if (existsSync('wrong-turn')) send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-wrong', status: 'completed' } } });
    const observerProbe = existsSync('probe-read-observer');
    send({ id: 77, method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 'turn-1', namespace: null, tool: observerProbe ? 'probe_read' : 'read', arguments: { path: observerProbe ? 'public.txt' : 'a.txt' } } });
  }
  else if (m.method === 'turn/interrupt') {
    send({ id: m.id, result: {} });
    send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } } });
  }
  else if (m.id === 77) {
    const items = m.result?.contentItems;
    const observerProbe = existsSync('probe-read-observer'); const expected = observerProbe ? 'CODEX_JOB_PUBLIC_READ_OK' : 'file';
    const valid = m.result?.success === true && Array.isArray(items) && items.length === 1
      && items[0]?.type === 'inputText' && items[0]?.text === expected && Object.keys(items[0]).sort().join(',') === 'text,type';
    if (!valid) return send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed' } } });
    send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'dynamicToolCall', id: 'fake-call-1', namespace: null, tool: observerProbe ? 'probe_read' : 'read', arguments: { path: observerProbe ? 'public.txt' : 'a.txt' }, status: 'completed', contentItems: items, success: true, durationMs: 1 } } });
    send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: items[0].text } });
    send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
  }
});
