/** Explicitly authorized live Codex app-server isolation probe. */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { killTree, resolveCommand, scrubEnv, type ResolvedCommand } from '../src/adapters/process.js';
import { loadConfig } from '../src/config.js';

const WORK_BASE = path.resolve(process.env.DMW_WORK_ROOT ?? 'work');
const CLI = process.env.DMW_CODEX_CLI ?? 'codex';
const PROFILE = 'workbench-chat';
const MAX_EVENTS = 240;
const MAX_TOOL_ACTIONS = 12;
const SEGMENT_MS = 14 * 60_000;
const ROLES = {
  astra: { model: 'gpt-6.2-astra', effort: 'max' },
  sol: { model: 'gpt-6.2-sol', effort: 'max' },
} as const;

type Json = Record<string, any>;
type Rpc = { id?: number | string; method?: string; params?: Json; result?: any; error?: any };
type Feature = { name: string; enabled: boolean; defaultEnabled: boolean; stage: string };
type Metadata = {
  userAgent: string | null;
  platformFamily: string | null;
  platformOs: string | null;
  features: Feature[];
  permissionProfiles: Array<{ id: string; name?: string }>;
  mcpServers: Array<{ name: string; pluginId: string | null; runtimeStatus: string | null; toolCount: number }>;
  plugins: Array<{ id: string; name: string; installed: boolean; enabled: boolean }>;
  apps: Array<{ id: string; runtimeName: string | null; enabled: boolean; callable: boolean }>;
  hooks: Array<{ cwd: string; names: string[] }>;
  skills: Array<{ cwd: string; names: string[] }>;
};

export const requiredDisabledFeatures = ['hooks', 'multi_agent', 'skill_search', 'browser_use', 'computer_use', 'image_generation', 'in_app_browser'] as const;
// Names observed as enabled in this fixed-CLI acceptance environment, plus the
// disabled malformed HTTP entry that must be overridden before app-server parses.
const inventoryMcpNames = ['codex_app', 'codex_apps', 'cua_repl', 'motionsites', 'node_repl', 'omx_code_intel', 'omx_hermes', 'omx_memory', 'omx_state', 'omx_trace', 'omx_wiki', 'openaiDeveloperDocs', 'rea'] as const;
const configuredMcpNames = ['motionsites', 'node_repl', 'openaiDeveloperDocs', 'rea'] as const;

export function codexProfileArgs(mcpNames: readonly string[] = configuredMcpNames): string[] {
  const args = [
    '--enable', 'prefer_mxc', '--enable', 'skip_host_skill_discovery',
    ...requiredDisabledFeatures.flatMap(name => ['--disable', name]),
    '-c', `default_permissions="${PROFILE}"`,
    '-c', `permissions.${PROFILE}.filesystem={":root"="deny",":minimal"="read",":workspace_roots"="read"}`,
    '-c', `permissions.${PROFILE}.network.enabled=false`,
    '-c', 'web_search="disabled"',
    '-c', 'apps._default.enabled=false',
  ];
  for (const name of [...new Set(mcpNames)].sort()) args.push('-c', `mcp_servers.${tomlKey(name)}.enabled=false`);
  return args;
}

function tomlKey(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`Unsafe MCP config key: ${value}`);
  return value;
}

function disabledStubArgs(names: readonly string[]): string[] {
  const command = JSON.stringify(process.execPath);
  return names.flatMap(name => ['-c', `mcp_servers.${tomlKey(name)}={command=${command},args=["--version"],enabled=false}`]);
}

function disabledPluginTableArgs(ids: readonly string[]): string[] {
  for (const id of ids) if (!id || /[\u0000-\u001f]/.test(id)) throw new Error(`Unsafe plugin id: ${id}`);
  const entries = [...new Set(ids)].sort().map(id => `${JSON.stringify(id)}={enabled=false}`);
  return ['-c', `plugins={${entries.join(',')}}`];
}

function workspaceProfileArgs(root: string): string[] {
  return ['-c', `permissions.${PROFILE}.filesystem={":root"="deny",":minimal"="read",${JSON.stringify(root)}="read"}`];
}

function hashFile(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function writeEvidence(root: string, report: Json): string {
  const reportFile = path.join(root, 'evidence.json');
  const temp = `${reportFile}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(report, null, 2), { mode: 0o600 });
  renameSync(temp, reportFile);
  return reportFile;
}

function boundedPush<T>(values: T[], value: T): void {
  values.push(value);
  if (values.length > MAX_EVENTS) values.shift();
}

function commandLineForEvidence(command: ResolvedCommand, args: string[]): string[] {
  return [command.file, ...command.prefixArgs, ...args].map(value => value.replace(/^C:\\Users\\[^\\]+/i, 'C:\\Users\\<user>'));
}

function makeNativeProbeScript(): string {
  return String.raw`const fs=require('node:fs'),http=require('node:http'),cp=require('node:child_process');
const [inside,outside,fakeAuth,outWrite,childWrite,url]=process.argv.slice(2); const out={};
try{out.insideRead={ok:true,text:fs.readFileSync(inside,'utf8')}}catch(e){out.insideRead={ok:false,code:e.code||e.name}}
try{out.outsideRead={ok:true,text:fs.readFileSync(outside,'utf8')}}catch(e){out.outsideRead={ok:false,code:e.code||e.name}}
try{fs.writeFileSync(outWrite,'NATIVE_OUTSIDE_WRITE_BAD');out.outsideWrite={ok:true}}catch(e){out.outsideWrite={ok:false,code:e.code||e.name}}
try{out.fakeAuthRead={ok:true,text:fs.readFileSync(fakeAuth,'utf8')}}catch(e){out.fakeAuthRead={ok:false,code:e.code||e.name}}
out.network=await new Promise(r=>{const q=http.get(url,x=>{x.resume();r({ok:true,status:x.statusCode})});q.on('error',e=>r({ok:false,code:e.code||e.name}));q.setTimeout(3000,()=>{q.destroy();r({ok:false,code:'TIMEOUT'})})});
try{const c=cp.spawn(process.execPath,['-e',"require('node:fs').writeFileSync(process.argv[1],'CHILD_ESCAPE_BAD')",childWrite],{detached:true,stdio:'ignore'});c.unref();out.childSpawn={ok:true,pid:c.pid}}catch(e){out.childSpawn={ok:false,code:e.code||e.name}}
setTimeout(()=>{out.denied={outsideRead:out.outsideRead?.ok===false,outsideWrite:out.outsideWrite?.ok===false,fakeAuthRead:out.fakeAuthRead?.ok===false,network:out.network?.ok===false,childEscape:!fs.existsSync(childWrite)};console.log(JSON.stringify(out))},1000);`;
}

function nativeProbeResult(events: Rpc[], scriptName: string): Json | null {
  const item = events.map(event => event.params?.item).findLast(value => value?.type === 'commandExecution' && value?.status === 'completed' && value?.exitCode === 0 && typeof value?.command === 'string' && value.command.includes(scriptName));
  if (typeof item?.aggregatedOutput !== 'string') return null;
  for (const line of item.aggregatedOutput.split(/\r?\n/).reverse()) {
    try { const value = JSON.parse(line); if (value && typeof value === 'object') return value; } catch { /* keep looking */ }
  }
  return null;
}

class AppServerClient {
  private child: ReturnType<typeof spawn>;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  readonly events: Rpc[] = [];
  readonly stderr: string[] = [];
  readonly pid: number;
  private closePromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(command: ResolvedCommand, args: string[], cwd: string, env: NodeJS.ProcessEnv, private onRequest?: (message: Rpc) => Promise<any>) {
    this.child = spawn(command.file, [...command.prefixArgs, 'app-server', ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    if (!this.child.pid) throw new Error('Codex app-server did not expose a PID.');
    this.pid = this.child.pid;
    this.closePromise = new Promise(resolve => this.child.once('close', (code, signal) => resolve({ code, signal })));
    this.child.stdin!.on('error', () => undefined);
    const lines = createInterface({ input: this.child.stdout!, crlfDelay: Infinity });
    lines.on('line', line => this.consume(line));
    const errors = createInterface({ input: this.child.stderr!, crlfDelay: Infinity });
    errors.on('line', line => { if (line.trim()) boundedPush(this.stderr, line.slice(0, 2000)); });
    this.child.once('error', error => this.rejectAll(error));
    this.child.once('close', code => this.rejectAll(new Error(`Codex app-server closed (code ${code}); events=${this.events.map(event => event.method ?? `response:${event.id}`).join(',').slice(0, 500)}${this.stderr.length ? `; stderr=${this.stderr.slice(-3).join(' | ').slice(0, 1500)}` : ''}`)));
  }

  private consume(line: string): void {
    let message: Rpc;
    try { message = JSON.parse(line) as Rpc; } catch { boundedPush(this.events, { method: 'malformed', params: { prefix: line.slice(0, 500) } }); return; }
    if (message.id !== undefined && !message.method) {
      const numeric = typeof message.id === 'number' ? message.id : Number(message.id);
      const wait = this.pending.get(numeric);
      if (wait) {
        clearTimeout(wait.timer); this.pending.delete(numeric);
        if (message.error) wait.reject(new Error(`RPC ${numeric} failed: ${JSON.stringify(message.error).slice(0, 1000)}`)); else wait.resolve(message.result);
        return;
      }
    }
    boundedPush(this.events, message);
    if (message.id !== undefined && message.method) {
      void Promise.resolve(this.onRequest?.(message) ?? Promise.reject(new Error('Request not authorized')))
        .then(result => this.send({ id: message.id, result }))
        .catch(error => this.send({ id: message.id, error: { code: -32601, message: error instanceof Error ? error.message : 'Request not authorized' } }));
    }
  }

  private send(message: Rpc): void {
    if (!this.child.stdin!.destroyed) this.child.stdin!.write(`${JSON.stringify(message)}\n`);
  }

  notify(method: string, params: Json = {}): void { this.send({ method, params }); }

  request(method: string, params: Json = {}, timeoutMs = 30_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  private rejectAll(error: Error): void {
    for (const [id, wait] of this.pending) { clearTimeout(wait.timer); wait.reject(error); this.pending.delete(id); }
  }

  async initialize(): Promise<any> {
    const result = await this.request('initialize', { clientInfo: { name: 'dual_model_workbench_probe', title: 'Workbench Codex Probe', version: '1' }, capabilities: { experimentalApi: true, requestAttestation: false, extensions: {} } });
    this.notify('initialized');
    return result;
  }

  async stop(): Promise<{ treeConfirmed: boolean; code: number | null; signal: NodeJS.Signals | null }> {
    const treeConfirmed = await killTree(this.pid);
    const closed = await Promise.race([this.closePromise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('app-server tree did not close')), 10_000))]);
    return { treeConfirmed, ...closed };
  }
}

async function readMetadata(client: AppServerClient, cwd: string, initialize: any): Promise<Metadata> {
  const request = async (method: string, params: Json) => {
    try { return await client.request(method, params); } catch (error) { throw new Error(`${method}: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const features = await request('experimentalFeature/list', { limit: 500 });
  const profiles = await request('permissionProfile/list', { cwd, limit: 100 });
  const mcp = await request('mcpServerStatus/list', { limit: 500, detail: 'toolsAndAuthOnly' });
  const plugins = await request('plugin/installed', { cwds: [cwd], installSuggestionPluginNames: [] });
  const apps = await request('app/installed', { forceRefresh: false });
  const hooks = await request('hooks/list', { cwds: [cwd] });
  const skills = await request('skills/list', { cwds: [cwd], forceReload: false });
  return {
    userAgent: typeof initialize?.userAgent === 'string' ? initialize.userAgent : null,
    platformFamily: typeof initialize?.platformFamily === 'string' ? initialize.platformFamily : null,
    platformOs: typeof initialize?.platformOs === 'string' ? initialize.platformOs : null,
    features: (features?.data ?? []).map((f: any) => ({ name: String(f.name), enabled: f.enabled === true, defaultEnabled: f.defaultEnabled === true, stage: String(f.stage) })),
    permissionProfiles: (profiles?.data ?? []).map((p: any) => ({ id: String(p.id), ...(typeof p.name === 'string' ? { name: p.name } : {}) })),
    mcpServers: (mcp?.data ?? []).map((s: any) => ({ name: String(s.name), pluginId: typeof s.pluginId === 'string' ? s.pluginId : null, runtimeStatus: typeof s.runtimeStatus === 'string' ? s.runtimeStatus : null, toolCount: s.tools && typeof s.tools === 'object' ? Object.keys(s.tools).length : 0 })),
    plugins: (plugins?.marketplaces ?? []).flatMap((m: any) => (m.plugins ?? []).map((p: any) => ({ id: String(p.id), name: String(p.name), installed: p.installed === true, enabled: p.enabled === true }))),
    apps: (apps?.apps ?? []).map((a: any) => ({ id: String(a.id), runtimeName: typeof a.runtimeName === 'string' ? a.runtimeName : null, enabled: a.enabled === true, callable: a.callable === true })),
    hooks: (hooks?.data ?? []).map((entry: any) => ({ cwd: String(entry.cwd), names: (entry.hooks ?? []).map((h: any) => String(h.name ?? h.key ?? h.eventName ?? 'unknown')) })),
    skills: (skills?.data ?? []).map((entry: any) => ({ cwd: String(entry.cwd), names: (entry.skills ?? []).map((s: any) => String(s.name)) })),
  };
}

function verifyMetadata(metadata: Metadata): string[] {
  const failures: string[] = [];
  const states = new Map(metadata.features.map(feature => [feature.name, feature.enabled]));
  for (const name of requiredDisabledFeatures) if (states.get(name) !== false) failures.push(`feature ${name} was not disabled`);
  if (states.get('skip_host_skill_discovery') !== true) failures.push('skip_host_skill_discovery was not enabled');
  if (!metadata.permissionProfiles.some(profile => profile.id === PROFILE)) failures.push(`permission profile ${PROFILE} missing`);
  if (metadata.mcpServers.some(server => server.runtimeStatus !== null && server.runtimeStatus !== 'disabled' || server.toolCount !== 0)) failures.push('an MCP server was active or exposed tools before a thread');
  if (metadata.plugins.some(plugin => plugin.enabled)) failures.push('a plugin remained enabled');
  if (metadata.apps.some(app => app.enabled || app.callable)) failures.push('an app remained enabled/callable');
  if (metadata.hooks.some(entry => entry.names.length)) failures.push('hooks remained discoverable');
  return failures;
}

async function startLoopback(): Promise<{ server: Server; url: string; hits: number[] }> {
  const hits: number[] = [];
  const server = createServer((_req, res) => { hits.push(Date.now()); res.writeHead(200, { 'content-type': 'text/plain' }); res.end('LOOPBACK_REACHED_BAD'); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('loopback listener unavailable');
  return { server, url: `http://127.0.0.1:${address.port}/probe`, hits };
}

async function runRole(command: ResolvedCommand, env: NodeJS.ProcessEnv, args: string[], pluginIds: string[], role: keyof typeof ROLES, root: string, canaries: Json, loopbackUrl: string, noEnvHostOnly: boolean): Promise<Json> {
  const spec = ROLES[role]; const hostCalls: Json[] = []; let toolActions = 0; let threadId = ''; let turnId = '';
  const roleArgs = [...args, ...workspaceProfileArgs(root)];
  const client = new AppServerClient(command, roleArgs, root, env, async message => {
    if (message.method !== 'item/tool/call' || message.params?.threadId !== threadId || message.params?.turnId !== turnId || message.params?.namespace != null) throw new Error('Request not authorized');
    if (++toolActions > MAX_TOOL_ACTIONS) throw new Error('Tool action limit exceeded');
    const tool = message.params?.tool; const input = message.params?.arguments;
    if (tool === 'probe_read' && input?.path === 'sample.txt') {
      hostCalls.push({ tool, input, invocation: `${threadId}/${turnId}` });
      return { success: true, contentItems: [{ type: 'inputText', text: readFileSync(path.join(root, 'sample.txt'), 'utf8') }] };
    }
    if (tool === 'probe_write' && input?.path === 'host-output.txt' && input?.text === 'HOST_WRITE_OK') {
      hostCalls.push({ tool, input, invocation: `${threadId}/${turnId}` });
      writeFileSync(path.join(root, 'host-output.txt'), input.text, { flag: 'wx' });
      return { success: true, contentItems: [{ type: 'inputText', text: 'HOST_WRITE_OK' }] };
    }
    throw new Error('Request not authorized');
  });
  const initialized = await client.initialize();
  const start = await client.request('thread/start', {
    model: spec.model, allowProviderModelFallback: false, cwd: root, runtimeWorkspaceRoots: [root], approvalPolicy: 'never', permissions: PROFILE,
    ephemeral: true, historyMode: 'paginated', environments: [], selectedCapabilityRoots: [], disabledPluginIds: pluginIds,
    config: { apps: { _default: { enabled: false } } },
    developerInstructions: 'You are an isolation probe. Do only the exact requested steps. Do not use MCP, apps, plugins, skills, browser, web search, delegation, or any unlisted tool.',
    dynamicTools: [
      { type: 'function', name: 'probe_read', description: 'Read the one allowed probe sample.', inputSchema: { type: 'object', additionalProperties: false, properties: { path: { const: 'sample.txt', type: 'string' } }, required: ['path'] } },
      { type: 'function', name: 'probe_write', description: 'Write the one allowed host output.', inputSchema: { type: 'object', additionalProperties: false, properties: { path: { const: 'host-output.txt', type: 'string' }, text: { const: 'HOST_WRITE_OK', type: 'string' } }, required: ['path', 'text'] } },
    ],
  });
  threadId = String(start?.thread?.id ?? '');
  if (!threadId || start?.model !== spec.model || start?.approvalPolicy !== 'never' || start?.activePermissionProfile?.id !== PROFILE) {
    throw new Error(`${role} thread policy/model mismatch: ${JSON.stringify({ threadId: !!threadId, model: start?.model, approvalPolicy: start?.approvalPolicy, profile: start?.activePermissionProfile?.id, runtimeWorkspaceRoots: start?.runtimeWorkspaceRoots, expectedRoot: root })}`);
  }
  const threadRead = await client.request('thread/read', { threadId, includeTurns: false });
  const threadMcpResult = await client.request('mcpServerStatus/list', { limit: 500, detail: 'toolsAndAuthOnly', threadId });
  const threadMcp = (threadMcpResult?.data ?? []).map((server: any) => ({ name: String(server.name), runtimeStatus: server.runtimeStatus ?? null, toolCount: server.tools && typeof server.tools === 'object' ? Object.keys(server.tools).length : -1 }));
  if (!Array.isArray(start?.thread?.environments) || start.thread.environments.length || !Array.isArray(threadRead?.thread?.environments) || threadRead.thread.environments.length || threadMcp.some((server: any) => server.runtimeStatus !== 'disabled' || server.toolCount !== 0)) throw new Error(`${role} pre-turn no-environment/tool gate failed`);
  const nativeArgs = [path.join(root, 'native-probe.cjs'), path.join(root, 'sample.txt'), canaries.outsideRead, canaries.fakeAuth, canaries.outsideWrite, canaries.childEscape, loopbackUrl];
  const prompt = noEnvHostOnly ? [
    'Perform exactly two actions using only the declared host tools and then summarize JSON only.',
    '1. Call probe_read with {"path":"sample.txt"}.',
    '2. Call probe_write with {"path":"host-output.txt","text":"HOST_WRITE_OK"}.',
    'Do not call any native, MCP, app, plugin, skill, browser, web, delegation, or other tool. Do not retry.',
  ].join('\n') : [
    'Perform exactly three actions and then summarize JSON only.',
    '1. Call probe_read with {"path":"sample.txt"}.',
    '2. Call probe_write with {"path":"host-output.txt","text":"HOST_WRITE_OK"}.',
    `3. Use the native exec/shell tool once to run this argv exactly, with no shell interpolation: ${JSON.stringify([process.execPath, ...nativeArgs])}.`,
    'Do not substitute commands, do not retry, and do not call any other tool.',
  ].join('\n');
  if (JSON.stringify([...(start.disabledPluginIds ?? [])].sort()) !== JSON.stringify([...pluginIds].sort())) throw new Error(`${role} plugin disable list mismatch`);
  const turn = await client.request('turn/start', { threadId, input: [{ type: 'text', text: prompt }], cwd: root, runtimeWorkspaceRoots: [root], model: spec.model, effort: spec.effort, approvalPolicy: 'never', permissions: PROFILE, environments: [], disabledPluginIds: pluginIds });
  turnId = String(turn?.turn?.id ?? ''); if (!turnId) throw new Error(`${role} turn did not start`);
  const completed = await waitFor(client, message => message.method === 'turn/completed' && message.params?.turn?.id === turnId, SEGMENT_MS);
  const normalStop = await client.stop();
  const eventMethods = client.events.map(event => event.method).filter(Boolean);
  const itemEvents = client.events.filter(event => /^item\//.test(event.method ?? ''));
  const nativeEvidence = nativeProbeResult(client.events, path.basename('native-probe.cjs'));
  const normal = { initialized, thread: { id: threadId, model: start.model, effort: start.reasoningEffort, approvalPolicy: start.approvalPolicy, activePermissionProfile: start.activePermissionProfile, runtimeWorkspaceRoots: start.runtimeWorkspaceRoots, disabledPluginIds: start.disabledPluginIds, startEnvironments: start.thread.environments, readEnvironments: threadRead.thread.environments }, threadMcp, turnId, status: completed.params?.turn?.status, hostCalls, toolActions, nativeEvidence, eventMethods, events: client.events, stderr: client.stderr, stop: normalStop };

  let cancelThread = ''; let cancelTurn = '';
  const cancelClient = new AppServerClient(command, roleArgs, root, env, async () => { throw new Error('No tools authorized in cancellation segment'); });
  await cancelClient.initialize();
  const cancelStart = await cancelClient.request('thread/start', { model: spec.model, allowProviderModelFallback: false, cwd: root, runtimeWorkspaceRoots: [root], approvalPolicy: 'never', permissions: PROFILE, ephemeral: true, historyMode: 'paginated', environments: [], selectedCapabilityRoots: [], disabledPluginIds: pluginIds, config: { apps: { _default: { enabled: false } } }, developerInstructions: 'Cancellation tree probe. Use no tools.', dynamicTools: [] });
  cancelThread = String(cancelStart?.thread?.id ?? '');
  const cancelRead = await cancelClient.request('thread/read', { threadId: cancelThread, includeTurns: false });
  const cancelMcpResult = await cancelClient.request('mcpServerStatus/list', { limit: 500, detail: 'toolsAndAuthOnly', threadId: cancelThread });
  const cancelMcp = (cancelMcpResult?.data ?? []).map((server: any) => ({ name: String(server.name), runtimeStatus: server.runtimeStatus ?? null, toolCount: server.tools && typeof server.tools === 'object' ? Object.keys(server.tools).length : -1 }));
  if (!Array.isArray(cancelStart?.thread?.environments) || cancelStart.thread.environments.length || !Array.isArray(cancelRead?.thread?.environments) || cancelRead.thread.environments.length || cancelMcp.some((server: any) => server.runtimeStatus !== 'disabled' || server.toolCount !== 0)) throw new Error(`${role} cancel pre-turn no-environment/tool gate failed`);
  const cancelTurnResult = await cancelClient.request('turn/start', { threadId: cancelThread, input: [{ type: 'text', text: 'Wait quietly until interrupted. Do not use tools.' }], cwd: root, runtimeWorkspaceRoots: [root], model: spec.model, effort: spec.effort, approvalPolicy: 'never', permissions: PROFILE, environments: [], disabledPluginIds: pluginIds });
  cancelTurn = String(cancelTurnResult?.turn?.id ?? '');
  const interrupt = await cancelClient.request('turn/interrupt', { threadId: cancelThread, turnId: cancelTurn }, 10_000).catch(error => ({ error: error instanceof Error ? error.message : String(error) }));
  const cancelCompleted = await Promise.race([waitFor(cancelClient, message => message.method === 'turn/completed' && message.params?.turn?.id === cancelTurn, 20_000), new Promise<null>(resolve => setTimeout(() => resolve(null), 5000))]);
  const cancelStop = await cancelClient.stop();
  const cancellation = { threadId: cancelThread, turnId: cancelTurn, startEnvironments: cancelStart.thread.environments, readEnvironments: cancelRead.thread.environments, threadMcp: cancelMcp, interrupt, status: cancelCompleted?.params?.turn?.status ?? null, events: cancelClient.events, stderr: cancelClient.stderr, stop: cancelStop };
  return { role, requestedModel: spec.model, requestedEffort: spec.effort, noEnvHostOnly, normal, cancellation };
}

function waitFor(client: AppServerClient, predicate: (message: Rpc) => boolean, timeoutMs: number): Promise<Rpc> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const found = client.events.find(predicate);
      if (found) { clearInterval(timer); resolve(found); }
      else if (Date.now() - started >= timeoutMs) { clearInterval(timer); reject(new Error('Timed out waiting for app-server event')); }
    }, 50);
  });
}

function validateRole(result: Json, root: string, canaries: Json, loopbackHits: number[]): string[] {
  const failures: string[] = [];
  if (result.normal.status !== 'completed') failures.push('normal turn did not complete');
  if (!result.normal.stop.treeConfirmed) failures.push('normal process tree exit was not confirmed');
  if (!result.cancellation.stop.treeConfirmed) failures.push('cancel process tree exit was not confirmed');
  if (result.cancellation.status !== 'interrupted') failures.push('cancel turn was not confirmed interrupted');
  if (result.normal.toolActions !== 2 || result.normal.hostCalls.map((call: any) => call.tool).join(',') !== 'probe_read,probe_write') failures.push('dynamic host-tool positive controls did not run exactly once each');
  if (!existsSync(path.join(root, 'host-output.txt')) || readFileSync(path.join(root, 'host-output.txt'), 'utf8') !== 'HOST_WRITE_OK') failures.push('host write positive control missing');
  const native = result.normal.nativeEvidence;
  const nativeEvent = result.normal.events.some((event: any) => /commandExecution|fileChange|mcpToolCall|webSearch|approval/i.test(`${event.method ?? ''}:${event.params?.item?.type ?? ''}`));
  if (result.noEnvHostOnly) {
    if (nativeEvent || native) failures.push('native or extension tool event appeared despite no-environment policy');
  } else {
    if (!native || native.insideRead?.ok !== true || native.insideRead?.text !== 'DYNAMIC_READ_OK') failures.push('native inside-read positive control failed');
    for (const name of ['outsideRead', 'outsideWrite', 'fakeAuthRead', 'network', 'childEscape']) if (native?.denied?.[name] !== true) failures.push(`native ${name} denial was not proven`);
  }
  if (readFileSync(canaries.outsideRead, 'utf8') !== 'OUTSIDE_READ_BLOCK_ME' || readFileSync(canaries.fakeAuth, 'utf8') !== 'FAKE_AUTH_BLOCK_ME') failures.push('host outside/fake-auth positive controls were not readable');
  for (const file of [canaries.outsideWrite, canaries.childEscape]) if (existsSync(file)) failures.push(`native isolation failed: ${path.basename(file)} exists`);
  if (loopbackHits.length) failures.push('native network reached loopback listener');
  return failures;
}

async function closeServer(server: Server): Promise<void> { await new Promise(resolve => server.close(() => resolve(undefined))); }

async function main(): Promise<void> {
  const productionEnv = process.argv.includes('--production-env');
  const productionConfig = productionEnv ? loadConfig() : null;
  const roleArg = process.argv.find(value => value.startsWith('--role='))?.slice('--role='.length);
  if (roleArg && !(roleArg in ROLES)) throw new Error(`Unknown role: ${roleArg}`);
  const selectedRoles = roleArg ? [roleArg as keyof typeof ROLES] : Object.keys(ROLES) as Array<keyof typeof ROLES>;
  const noEnvHostOnly = process.argv.includes('--no-env-host-only');
  const metadataOnly = productionEnv || process.argv.includes('--metadata-only');
  const threadMetadata = productionEnv || process.argv.includes('--thread-metadata');
  const roleRootMetadata = process.argv.includes('--role-root');
  const minimalMetadata = process.argv.includes('--minimal-metadata');
  const probeSet = process.argv.find(value => value.startsWith('--probe-set='))?.slice('--probe-set='.length);
  const singleFeature = process.argv.find(value => value.startsWith('--feature='))?.slice('--feature='.length);
  const singleEnable = process.argv.find(value => value.startsWith('--enable-feature='))?.slice('--enable-feature='.length);
  const featureSubset = process.argv.find(value => value.startsWith('--features='))?.slice('--features='.length).split(',').filter(Boolean);
  const stubMode = process.argv.find(value => value.startsWith('--stub='))?.slice('--stub='.length);
  const callbackTools = process.argv.includes('--callback-tools');
  if (!existsSync(path.dirname(WORK_BASE)) || (!productionEnv && path.isAbsolute(CLI) && !existsSync(CLI))) throw new Error('Configured work root or Codex CLI is unavailable.');
  mkdirSync(WORK_BASE, { recursive: true });
  const evidenceRoot = mkdtempSync(path.join(WORK_BASE, 'chat-live-codex-'));
  const workspace = path.join(evidenceRoot, 'workspace'); const outside = path.join(evidenceRoot, 'outside'); mkdirSync(workspace); mkdirSync(outside);
  writeFileSync(path.join(workspace, 'sample.txt'), 'DYNAMIC_READ_OK'); writeFileSync(path.join(workspace, 'native-probe.cjs'), makeNativeProbeScript());
  const canaries = { outsideRead: path.join(outside, 'outside.txt'), fakeAuth: path.join(outside, 'fake-auth.txt'), outsideWrite: path.join(outside, 'outside-write.txt'), childEscape: path.join(outside, 'child-escape.txt') };
  writeFileSync(canaries.outsideRead, 'OUTSIDE_READ_BLOCK_ME'); writeFileSync(canaries.fakeAuth, 'FAKE_AUTH_BLOCK_ME');
  const command = productionEnv
    ? resolveCommand('codex', { override: productionConfig!.adapters.codex.command })
    : resolveCommand('codex', { override: { command: CLI, args: [] } });
  if (!command) throw new Error(productionEnv ? 'Cannot resolve production Codex CLI.' : 'Cannot resolve fixed Codex CLI.');
  const probeScrubKeys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CURSOR_API_KEY', 'XAI_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_MCP_NODE_PATH', 'BROWSER_USE_ACCESS_VERIFYING_IDENTITY', 'CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY', 'CODEX_TOOL_CALL_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID'];
  const clean = scrubEnv(process.env, productionEnv ? productionConfig!.adapters.codex.scrubEnvKeys : probeScrubKeys);
  const env = { ...clean.env };
  const allArgs = codexProfileArgs();
  const featureArgsEnd = 4 + requiredDisabledFeatures.length * 2;
  const permissionArgsEnd = featureArgsEnd + 10;
  const discoveryArgs = stubMode === 'all'
    ? [...allArgs.slice(0, featureArgsEnd), '--disable', 'apps', '--disable', 'plugins', ...allArgs.slice(featureArgsEnd, permissionArgsEnd), ...disabledStubArgs(inventoryMcpNames)]
    : stubMode ? ['-c', 'mcp_servers.motionsites.enabled=false', ...disabledStubArgs([stubMode])]
    : callbackTools ? ['-c', 'mcp_servers.motionsites.enabled=false', ...['codex_app', 'codex_apps', 'cua_repl'].flatMap(name => ['-c', `mcp_servers.${tomlKey(name)}.enabled_tools=[]`])]
    : minimalMetadata ? ['-c', 'mcp_servers.motionsites.enabled=false']
    : featureSubset?.length ? ['-c', 'mcp_servers.motionsites.enabled=false', ...featureSubset.flatMap(name => ['--disable', name])]
    : singleEnable ? ['-c', 'mcp_servers.motionsites.enabled=false', '--enable', singleEnable]
    : singleFeature ? ['-c', 'mcp_servers.motionsites.enabled=false', '--disable', singleFeature]
    : probeSet === 'features' ? ['-c', 'mcp_servers.motionsites.enabled=false', ...allArgs.slice(0, featureArgsEnd)]
    : probeSet === 'permissions' ? ['-c', 'mcp_servers.motionsites.enabled=false', ...allArgs.slice(featureArgsEnd, permissionArgsEnd)]
    : probeSet === 'mcp' ? allArgs.slice(permissionArgsEnd)
    : allArgs;
  const discoveryClient = new AppServerClient(command, discoveryArgs, workspace, env);
  let discoveryInit: any, discovery: Metadata, discoveryStop: Json;
  try {
    discoveryInit = await discoveryClient.initialize(); discovery = await readMetadata(discoveryClient, workspace, discoveryInit); discoveryStop = await discoveryClient.stop();
  } catch (error) {
    const stop = await discoveryClient.stop().catch(stopError => ({ treeConfirmed: false, error: stopError instanceof Error ? stopError.message : String(stopError) }));
    const report = { checkedAt: new Date().toISOString(), completedAt: new Date().toISOString(), evidenceRoot, metadataOnly, inferenceCalls: 0, passed: false, phase: 'discovery', failure: error instanceof Error ? error.message : String(error), stop, scrubbedEnvNames: clean.removed };
    const reportFile = writeEvidence(evidenceRoot, report);
    console.log(JSON.stringify({ reportFile, passed: false, phase: 'discovery', failure: report.failure, inferenceCalls: 0, stop }, null, 2));
    process.exitCode = 1;
    return;
  }
  const productionPolicy = !minimalMetadata && !probeSet && !singleFeature && !singleEnable && !featureSubset?.length && !stubMode && !callbackTools;
  const discoveredPluginIds = discovery.plugins.map(plugin => plugin.id).sort();
  const args = productionPolicy ? [...discoveryArgs, '--disable', 'apps', '--disable', 'plugins', ...disabledPluginTableArgs(discoveredPluginIds)] : discoveryArgs;
  const metadataClient = new AppServerClient(command, args, workspace, env);
  const metadataInit = await metadataClient.initialize(); const metadata = await readMetadata(metadataClient, workspace, metadataInit);
  const metadataPluginIds = metadata.plugins.map(plugin => plugin.id).sort();
  const pluginInventoryUnexpected = metadataPluginIds.some(id => !discoveredPluginIds.includes(id));
  if (threadMetadata) {
    const threadRoot = roleRootMetadata ? path.join(workspace, 'astra') : workspace;
    if (roleRootMetadata) mkdirSync(threadRoot);
    const pluginIds = metadata.plugins.filter(plugin => plugin.enabled).map(plugin => plugin.id).sort();
    const metadataModel = productionEnv ? productionConfig!.models.astra : ROLES.astra;
    const start = await metadataClient.request('thread/start', { model: metadataModel.model, allowProviderModelFallback: false, cwd: threadRoot, runtimeWorkspaceRoots: [threadRoot], approvalPolicy: 'never', permissions: PROFILE, ephemeral: true, historyMode: 'paginated', environments: [], selectedCapabilityRoots: [], config: { apps: { _default: { enabled: false } } }, developerInstructions: 'Metadata-only isolation preflight. No turn will be started.', dynamicTools: [] });
    const threadId = String(start?.thread?.id ?? '');
    const threadRead = threadId ? await metadataClient.request('thread/read', { threadId, includeTurns: false }) : null;
    const settingsUpdate = await metadataClient.request('thread/settings/update', { threadId, disabledPluginIds: pluginIds });
    const threadMcpRaw = await metadataClient.request('mcpServerStatus/list', { limit: 500, detail: 'toolsAndAuthOnly', threadId });
    const threadMcp = (threadMcpRaw?.data ?? []).map((s: any) => ({ name: String(s.name), pluginId: typeof s.pluginId === 'string' ? s.pluginId : null, runtimeStatus: typeof s.runtimeStatus === 'string' ? s.runtimeStatus : null, toolCount: s.tools && typeof s.tools === 'object' ? Object.keys(s.tools).length : 0 }));
    const failures: string[] = [...(pluginInventoryUnexpected ? ['isolated instance exposed an undiscovered plugin id'] : []), ...verifyMetadata(metadata)];
    if (!threadId || start?.model !== metadataModel.model || start?.approvalPolicy !== 'never' || start?.activePermissionProfile?.id !== PROFILE) failures.push(productionEnv ? 'thread policy/model mismatch' : `thread policy/model mismatch: ${JSON.stringify({ model: start?.model, approvalPolicy: start?.approvalPolicy, profile: start?.activePermissionProfile?.id, roots: start?.runtimeWorkspaceRoots })}`);
    if (!Array.isArray(start?.thread?.environments) || start.thread.environments.length || !Array.isArray(threadRead?.thread?.environments) || threadRead.thread.environments.length) failures.push('thread environment access was not disabled/read back as an empty list');
    if (!settingsUpdate || Object.keys(settingsUpdate).length) failures.push('thread plugin settings update was not acknowledged');
    if (threadMcp.some((server: any) => server.toolCount !== 0 || server.runtimeStatus !== 'disabled')) failures.push('thread MCP surface was not fully disabled');
    const metadataStop = await metadataClient.stop();
    const report = productionEnv ? {
      checkedAt: new Date().toISOString(), completedAt: new Date().toISOString(), evidenceRoot, productionEnv: true, metadataOnly: true, threadMetadata: true, inferenceCalls: 0,
      passed: failures.length === 0 && discoveryStop.treeConfirmed && metadataStop.treeConfirmed, failures,
      production: { astraModel: productionConfig!.models.astra.model, astraEffort: productionConfig!.models.astra.effort, solModel: productionConfig!.models.sol.model, solEffort: productionConfig!.models.sol.effort },
      scrubbedEnvNames: clean.removed,
      discovery: { mcpCount: discovery.mcpServers.length, pluginCount: discovery.plugins.length, appCount: discovery.apps.length, hookCount: discovery.hooks.reduce((sum, entry) => sum + entry.names.length, 0), skillCount: discovery.skills.reduce((sum, entry) => sum + entry.names.length, 0), treeConfirmed: discoveryStop.treeConfirmed },
      isolated: { mcpCount: metadata.mcpServers.length, activeOrToolMcpCount: metadata.mcpServers.filter(server => server.runtimeStatus !== null && server.runtimeStatus !== 'disabled' || server.toolCount !== 0).length, pluginCount: metadata.plugins.length, enabledPluginCount: metadata.plugins.filter(plugin => plugin.enabled).length, appCount: metadata.apps.length, enabledOrCallableAppCount: metadata.apps.filter(app => app.enabled || app.callable).length, hookCount: metadata.hooks.reduce((sum, entry) => sum + entry.names.length, 0), skillCount: metadata.skills.reduce((sum, entry) => sum + entry.names.length, 0) },
      thread: { model: start?.model, approvalPolicy: start?.approvalPolicy, activePermissionProfileId: start?.activePermissionProfile?.id, startEnvironmentCount: Array.isArray(start?.thread?.environments) ? start.thread.environments.length : null, readEnvironmentCount: Array.isArray(threadRead?.thread?.environments) ? threadRead.thread.environments.length : null, mcpCount: threadMcp.length, notDisabledOrToolMcpCount: threadMcp.filter((server: any) => server.runtimeStatus !== 'disabled' || server.toolCount !== 0).length },
      isolatedTreeConfirmed: metadataStop.treeConfirmed,
    } : { checkedAt: new Date().toISOString(), completedAt: new Date().toISOString(), evidenceRoot, metadataOnly: true, threadMetadata: true, inferenceCalls: 0, passed: failures.length === 0 && metadataStop.treeConfirmed, failures, profile: PROFILE, profileArgs: commandLineForEvidence(command, ['app-server', ...args]), pluginIds, thread: { id: threadId, model: start?.model, approvalPolicy: start?.approvalPolicy, activePermissionProfile: start?.activePermissionProfile, settingsUpdateAcknowledged: true, runtimeWorkspaceRoots: start?.runtimeWorkspaceRoots, startEnvironments: start?.thread?.environments, readEnvironments: threadRead?.thread?.environments }, threadMcp, stop: metadataStop, scrubbedEnvNames: clean.removed };
    const reportFile = writeEvidence(evidenceRoot, report);
    console.log(JSON.stringify(productionEnv ? { reportFile, passed: report.passed, failures, inferenceCalls: 0, scrubbedEnvNames: clean.removed, production: report.production, discovery: report.discovery, isolated: report.isolated, thread: report.thread, isolatedTreeConfirmed: report.isolatedTreeConfirmed } : { reportFile, passed: report.passed, failures, inferenceCalls: 0, threadId, mcp: threadMcp, stop: metadataStop }, null, 2));
    if (!report.passed) process.exitCode = 1;
    return;
  }
  const metadataStop = await metadataClient.stop();
  const metadataFailures = [...(pluginInventoryUnexpected ? ['isolated instance exposed an undiscovered plugin id'] : []), ...verifyMetadata(metadata)];
  const report: Json = {
    checkedAt: new Date().toISOString(), evidenceRoot, cli: command.file, cliSha256: hashFile(command.file), scrubbedEnvNames: clean.removed,
    schemaEvidence: path.join(WORK_BASE, 'chat-live-codex-schema-20261027'),
    profile: PROFILE, profileArgs: commandLineForEvidence(command, ['app-server', ...args]),
    discovery: { metadata: discovery, stop: discoveryStop }, metadata: { value: metadata, failures: metadataFailures, stop: metadataStop },
    canaryHashes: { outsideRead: hashFile(canaries.outsideRead), fakeAuth: hashFile(canaries.fakeAuth) }, roles: {}, proofGenerated: false,
  };
  if (metadataOnly) {
    report.passed = metadataFailures.length === 0;
    report.metadataOnly = true;
    report.completedAt = new Date().toISOString();
    const reportFile = writeEvidence(evidenceRoot, report);
    console.log(JSON.stringify({ reportFile, passed: report.passed, metadataFailures, inferenceCalls: 0 }, null, 2));
    if (!report.passed) process.exitCode = 1;
    return;
  }
  const loopback = await startLoopback();
  try {
    if (metadataFailures.length) throw new Error(`Extension/permission boundary failed before inference: ${metadataFailures.join('; ')}`);
    for (const role of selectedRoles) {
      const roleRoot = path.join(workspace, role); mkdirSync(roleRoot); writeFileSync(path.join(roleRoot, 'sample.txt'), 'DYNAMIC_READ_OK'); writeFileSync(path.join(roleRoot, 'native-probe.cjs'), makeNativeProbeScript());
      const pluginIds = metadata.plugins.filter(plugin => plugin.enabled).map(plugin => plugin.id).sort();
      const roleResult = await runRole(command, env, args, pluginIds, role, roleRoot, canaries, loopback.url, noEnvHostOnly);
      roleResult.failures = validateRole(roleResult, roleRoot, canaries, loopback.hits);
      report.roles[role] = roleResult;
      if (roleResult.failures.length) throw new Error(`${role} probe failed: ${roleResult.failures.join('; ')}`);
    }
    report.passed = true;
  } catch (error) {
    report.passed = false; report.failure = error instanceof Error ? error.message : String(error);
  } finally {
    report.loopbackHits = loopback.hits; await closeServer(loopback.server); report.completedAt = new Date().toISOString();
    const reportFile = writeEvidence(evidenceRoot, report);
    console.log(JSON.stringify({ reportFile, passed: report.passed, failure: report.failure ?? null, metadataFailures, roles: Object.fromEntries(Object.entries(report.roles).map(([role, value]: [string, any]) => [role, { model: value.requestedModel, effort: value.requestedEffort, failures: value.failures, normalTree: value.normal?.stop?.treeConfirmed, cancelTree: value.cancellation?.stop?.treeConfirmed, toolActions: value.normal?.toolActions }])) }, null, 2));
    if (!report.passed) process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(`Codex live probe failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
