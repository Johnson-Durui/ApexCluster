/** Explicitly approved causal paired-control proof. Default mode performs no inference. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto, { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { runProcess, type ResolvedCommand, type RunProcessResult } from '../src/adapters/process.js';
import { cursorWriteAvailability, type CursorWriteCapabilities, type CursorWriterLifecycle } from '../src/adapters/cursor-writer.js';
import {
  SystemWslCursorDenyBridge, SystemWslCursorHookProofBridge, cursorDenyProfileArtifacts, cursorHookProofArtifacts, type CursorHookReceipt, type CursorHookReceiptBinding,
} from '../src/chat/cursor-deny-bridge.js';
import { validateCursorIsolationProbe } from '../src/chat/cursor-isolated.js';
import { cursorReadonlyRuntimeSha256, cursorReadonlyRuntimeSource } from '../src/chat/cursor-readonly-runtime.js';

const WORK_ROOT = path.resolve(process.env.DMW_WORK_ROOT ?? 'work');
const MAX_SEGMENT_MS = 15 * 60_000; const MAX_TOOL_CALLS = 12;
const MODEL = 'grok-4.7-high-fast'; const EFFORT = 'high';
const URL = 'https://example.com/'; const QUERY = 'OpenAI official documentation';
const WSL: ResolvedCommand = { file: 'C:\\Windows\\System32\\wsl.exe', prefixArgs: [], via: 'config' };
const executeLive = process.argv.slice(2).includes('--execute-live');
const diagnoseSandboxStartup = process.argv.slice(2).includes('--diagnose-sandbox-startup');
const diagnoseK3Preflight = process.argv.slice(2).includes('--diagnose-k3-preflight');
const diagnoseGlobalRename = process.argv.slice(2).includes('--diagnose-global-rename');
const diagnoseModelState = process.argv.slice(2).includes('--diagnose-model-state');
if ([executeLive, diagnoseSandboxStartup, diagnoseK3Preflight, diagnoseGlobalRename, diagnoseModelState].filter(Boolean).length > 1) throw new Error('live proof and diagnostics are mutually exclusive');
if (process.argv.slice(2).some(arg => !['--execute-live', '--diagnose-sandbox-startup', '--diagnose-k3-preflight', '--diagnose-global-rename', '--diagnose-model-state'].includes(arg))) throw new Error('unsupported argument');
const now = () => new Date().toISOString(); const sha256 = (value: Buffer | string) => crypto.createHash('sha256').update(value).digest('hex');
const runId = `chat-live-grok-hook-paired-${now().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`;
const evidenceRoot = path.join(WORK_ROOT, runId); const reportFile = path.join(evidenceRoot, 'evidence.json');
const report: Record<string, any> = { version: 1, runId, evidenceRoot, startedAt: now(), executeLive, model: MODEL, effort: EFFORT,
  targets: { webFetch: URL, webSearch: QUERY }, maxSegments: 2, maxToolCallsPerSegment: MAX_TOOL_CALLS,
  paidSegmentsAttempted: 0, proofGenerated: false, sides: [], passed: false };

function persist(): void {
  mkdirSync(evidenceRoot, { recursive: true }); const temp = `${reportFile}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); renameSync(temp, reportFile);
}
function hostEnv(): NodeJS.ProcessEnv { return Object.fromEntries(['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]])); }
async function wslNode<T>(cap: CursorWriteCapabilities, source: string, input: unknown, timeoutMs = 45_000): Promise<T> {
  const result = await runProcess(WSL, ['-d', cap.distro, '--cd', '/home/codex', '--exec', cap.nodePath, '--input-type=module', '-e', source], {
    cwd: process.cwd(), env: hostEnv(), stdinText: JSON.stringify(input), timeoutMs,
  });
  if (result.exitCode !== 0 || result.spawnError || result.timedOut || result.cancelled || result.terminationWarning) throw new Error(`paired loader helper failed: ${result.spawnError ?? result.stderrTail.trim() ?? result.exitCode}`);
  try { return JSON.parse(result.stdoutTail) as T; } catch { throw new Error(`paired loader helper invalid JSON size=${Buffer.byteLength(result.stdoutTail)} sha256=${sha256(result.stdoutTail)}`); }
}
async function rootAbsent(cap: CursorWriteCapabilities, root: string): Promise<boolean> {
  const source = "import fs from 'node:fs';process.stdout.write(JSON.stringify(!fs.existsSync(process.argv[1])))";
  const result = await runProcess(WSL, ['-d', cap.distro, '--cd', '/home/codex', '--exec', cap.nodePath, '--input-type=module', '-e', source, root], {
    cwd: process.cwd(), env: hostEnv(), stdinText: null, timeoutMs: 15_000,
  });
  return result.exitCode === 0 && !result.spawnError && !result.timedOut && !result.cancelled && !result.terminationWarning && JSON.parse(result.stdoutTail) === true;
}
const lifecycleConfirmed = (value: CursorWriterLifecycle | null): value is CursorWriterLifecycle => !!value?.confirmed && value.remaining.length === 0 && value.supervisorGone && value.bwrapGone;
type SideMode = 'control' | 'deny';
type Observation = { kind: 'web_fetch' | 'web_search'; subtype: 'started' | 'completed'; argsMatch: boolean; success: boolean; rejected: boolean; rawSha256: string };
type InteractionObservation = { kind: 'web_fetch' | 'web_search'; subtype: 'request' | 'response'; id: string | number | null;
  argsMatch: boolean; skipApprovalFalse: boolean; locallyRejected: boolean; approved: boolean; rawSha256: string };
type SchemaDiscoveryObservation = { toolName: 'WebFetch' | 'WebSearch'; toolCallId: string; subtype: 'started' | 'completed'; argsExact: boolean; schemaToolMatches: boolean; rawSha256: string };

type ObservedModelState = {
  model: { modelId: string; displayModelId: string; displayName: string; displayNameShort: string; aliases: string[]; thinkingDetails?: Record<string, never>; maxMode?: boolean };
  hasChangedDefaultModel: boolean; maxMode: boolean; modelParameters: Record<string, Array<{ id: string; value: string }>>;
  selectedModel: { modelId: string; parameters: Array<{ id: string; value: string }> }; modelSelectionHistory: string[];
};

/** This function is stringified into the guest helper; keep it self-contained. */
function extractObservedModelState(config: unknown): ObservedModelState {
  const object = (value: unknown, label: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
    return value as Record<string, unknown>;
  };
  const exactKeys = (value: Record<string, unknown>, allowed: string[], label: string): void => {
    const unknown = Object.keys(value).filter(key => !allowed.includes(key)); if (unknown.length) throw new Error(`${label} unknown keys: ${unknown.sort().join(',')}`);
  };
  const safeString = (value: unknown, label: string, max = 256): string => {
    if (typeof value !== 'string' || value.length < 1 || value.length > max || /[^\x20-\x7e]/.test(value) || /(bearer|token|secret|credential|api[_-]?key)/i.test(value)) throw new Error(`${label} unsafe string`);
    return value;
  };
  const parameters = (value: unknown, label: string): Array<{ id: string; value: string }> => {
    if (!Array.isArray(value) || value.length > 32) throw new Error(`${label} invalid parameter count`);
    const result = value.map((entry, index) => { const item = object(entry, `${label}/${index}`); exactKeys(item, ['id', 'value'], `${label}/${index}`);
      return { id: safeString(item.id, `${label}/${index}/id`, 128), value: safeString(item.value, `${label}/${index}/value`, 256) }; });
    if (new Set(result.map(item => item.id)).size !== result.length) throw new Error(`${label} duplicate parameter id`); return result;
  };
  const root = object(config, 'config'); const required = ['model', 'hasChangedDefaultModel', 'maxMode', 'modelParameters', 'selectedModel', 'modelSelectionHistory'];
  for (const key of required) if (!Object.hasOwn(root, key)) throw new Error(`config missing ${key}`);
  if (root.hasChangedDefaultModel !== true || typeof root.maxMode !== 'boolean') throw new Error('model selection flags invalid');
  const model = object(root.model, 'model'); exactKeys(model, ['modelId', 'displayModelId', 'displayName', 'displayNameShort', 'aliases', 'thinkingDetails', 'maxMode'], 'model');
  if (Object.hasOwn(model, 'credentials')) throw new Error('model credentials forbidden');
  const aliases = model.aliases; if (!Array.isArray(aliases) || aliases.length > 64) throw new Error('model aliases invalid');
  const cleanModel: ObservedModelState['model'] = { modelId: safeString(model.modelId, 'model/modelId'), displayModelId: safeString(model.displayModelId, 'model/displayModelId'),
    displayName: safeString(model.displayName, 'model/displayName'), displayNameShort: safeString(model.displayNameShort, 'model/displayNameShort'),
    aliases: aliases.map((value, index) => safeString(value, `model/aliases/${index}`)) };
  if (Object.hasOwn(model, 'thinkingDetails')) { const thinking = object(model.thinkingDetails, 'model/thinkingDetails'); exactKeys(thinking, [], 'model/thinkingDetails'); cleanModel.thinkingDetails = {}; }
  if (Object.hasOwn(model, 'maxMode')) { if (typeof model.maxMode !== 'boolean' || model.maxMode !== root.maxMode) throw new Error('model maxMode mismatch'); cleanModel.maxMode = model.maxMode; }
  const selected = object(root.selectedModel, 'selectedModel'); exactKeys(selected, ['modelId', 'parameters'], 'selectedModel');
  const cleanSelected = { modelId: safeString(selected.modelId, 'selectedModel/modelId'), parameters: parameters(selected.parameters, 'selectedModel/parameters') };
  if (cleanSelected.modelId !== cleanModel.modelId) throw new Error('active model id mismatch');
  const rawParameters = object(root.modelParameters, 'modelParameters'); if (Object.keys(rawParameters).length > 32) throw new Error('modelParameters too many models');
  const cleanParameters: ObservedModelState['modelParameters'] = {}; for (const [key, value] of Object.entries(rawParameters)) cleanParameters[safeString(key, 'modelParameters key')] = parameters(value, `modelParameters/${key}`);
  if (JSON.stringify(cleanParameters[cleanSelected.modelId]) !== JSON.stringify(cleanSelected.parameters)) throw new Error('active model parameters mismatch');
  if (!Array.isArray(root.modelSelectionHistory) || root.modelSelectionHistory.length < 1 || root.modelSelectionHistory.length > 32) throw new Error('modelSelectionHistory invalid');
  const history = root.modelSelectionHistory.map((value, index) => safeString(value, `modelSelectionHistory/${index}`));
  if (history[0] !== cleanSelected.modelId || new Set(history).size !== history.length) throw new Error('modelSelectionHistory correlation invalid');
  return { model: cleanModel, hasChangedDefaultModel: true, maxMode: root.maxMode, modelParameters: cleanParameters, selectedModel: cleanSelected, modelSelectionHistory: history };
}

function selfTestModelStateExtractor(): Record<string, unknown> {
  const valid = { model: { modelId: 'grok', displayModelId: 'grok', displayName: 'Grok High Fast', displayNameShort: 'Grok High Fast', aliases: [], thinkingDetails: {}, maxMode: true },
    hasChangedDefaultModel: true, maxMode: true, modelParameters: { grok: [{ id: 'speed', value: 'fast' }] }, selectedModel: { modelId: 'grok', parameters: [{ id: 'speed', value: 'fast' }] }, modelSelectionHistory: ['grok'] };
  assert.deepEqual(extractObservedModelState(valid), valid);
  const guestExtract = Function('__name', `return (${extractObservedModelState.toString()})`)((value: unknown) => value) as (value: unknown) => ObservedModelState;
  assert.deepEqual(guestExtract(valid), valid);
  for (const invalid of [
    { ...valid, model: { ...valid.model, credentials: { apiKeyCredentials: { apiKey: 'canary' } } } },
    { ...valid, model: { ...valid.model, unknown: true } },
    { ...valid, model: { ...valid.model, displayName: 'secret-token-canary' } },
    { ...valid, selectedModel: { ...valid.selectedModel, modelId: 'other' } },
    { ...valid, modelSelectionHistory: ['other', 'grok'] },
  ]) assert.throws(() => extractObservedModelState(invalid));
  return { passed: true, guestStringificationPassed: true, credentialsRejected: true, unknownKeysRejected: true, sensitiveStringsRejected: true, correlationsEnforced: true };
}

const normalizedLines = (lines: string[]): string => lines.map(line => line.endsWith('\r') ? line.slice(0, -1) : line).join('\n') + (lines.length ? '\n' : '');
function completeStreamEvidence(file: string, streamedLines: string[]): { lineCount: number; normalizedSha256: string; events: any[] } {
  const text = readFileSync(file, 'utf8'); const diskLines = text.split('\n'); if (diskLines.at(-1) === '') diskLines.pop();
  const normalizedDiskLines = diskLines.map(line => line.endsWith('\r') ? line.slice(0, -1) : line);
  const events = normalizedDiskLines.map(line => JSON.parse(line)); const streamedSha = sha256(normalizedLines(streamedLines)); const diskSha = sha256(normalizedLines(normalizedDiskLines));
  assert.equal(normalizedDiskLines.length, streamedLines.length, 'streamed/disk line count mismatch'); assert.equal(diskSha, streamedSha, 'streamed/disk normalized hash mismatch');
  assert.equal(events.filter(event => event?.type === 'result').length, 1, 'complete stream must contain exactly one terminal result');
  return { lineCount: normalizedDiskLines.length, normalizedSha256: diskSha, events };
}

async function writableLoaderProbe(cap: CursorWriteCapabilities, mode: SideMode): Promise<Record<string, unknown>> {
  const id = randomUUID(); const root = `/home/codex/.dual-model-workbench/writer-${id}`; const marker = `DMW_CURSOR_${id.replaceAll('-', '_').toUpperCase()}`;
  const receipt: CursorHookReceiptBinding = { mode, invocationNonce: randomUUID(), marker }; const bridge = new SystemWslCursorHookProofBridge(receipt); const signal = new AbortController().signal;
  const source = String.raw`import fs from 'node:fs';import crypto from 'node:crypto';import {spawnSync} from 'node:child_process';const chunks=[];for await(const c of process.stdin)chunks.push(c);const r=JSON.parse(Buffer.concat(chunks).toString('utf8'));
if(!/^\/home\/codex\/\.dual-model-workbench\/writer-[a-f0-9-]{36}$/.test(r.root))throw Error('bad loader root');const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const files={projectPolicy:r.root+'/workspace/.cursor/cli.json',profileConfig:r.root+'/profile/cli-config.json',hooks:r.root+'/profile/hooks.json',script:r.root+'/profile/deny-native.mjs',scopeGuard:r.root+'/profile/scope-guard.mjs',binding:r.root+'/profile/receipt-binding.json',homeHooks:r.root+'/project-state/hooks.json',homeProfileConfig:r.root+'/project-state/cli-config.json'};
const config=file=>{const value=JSON.parse(fs.readFileSync(file,'utf8'));const list=value.webFetchDomainAllowlist;return{sha256:hash(file),fields:Object.keys(value).sort(),safe:{channel:value.channel??null,sandbox:value.sandbox??null,permissions:value.permissions??null,autoAcceptWebSearch:value.autoAcceptWebSearch??null,webFetchDomainAllowlistState:list===undefined?'missing':Array.isArray(list)&&list.length===0?'empty':'nonempty'}}};
const snapshot=()=>({projectPolicy:{sha256:hash(files.projectPolicy)},profileConfig:config(files.profileConfig),hooks:{sha256:hash(files.hooks)},script:{sha256:hash(files.script)},scopeGuard:{sha256:hash(files.scopeGuard)},binding:{sha256:hash(files.binding)},homeHooks:{sha256:hash(files.homeHooks)},homeProfileConfig:config(files.homeProfileConfig)});const before=snapshot();const emptyAuth=r.root+'/loader-empty-auth';fs.mkdirSync(emptyAuth,{mode:0o700});
const args=['--unshare-all','--die-with-parent','--new-session','--tmpfs','/','--dir','/usr','--ro-bind','/usr','/usr','--dir','/bin','--ro-bind','/bin','/bin','--dir','/sbin','--ro-bind','/sbin','/sbin','--dir','/lib','--ro-bind','/lib','/lib','--dir','/lib64','--ro-bind','/lib64','/lib64','--dir','/etc','--ro-bind','/etc','/etc','--dir','/opt','--ro-bind','/opt','/opt','--dir','/workspace','--dir','/cursor-profile','--bind',r.root+'/workspace','/workspace','--bind',r.root+'/profile','/cursor-profile','--dir','/home','--dir','/home/codex','--dir','/home/codex/.config','--dir','/home/codex/.config/cursor','--ro-bind',emptyAuth,'/home/codex/.config/cursor','--dir','/home/codex/.cursor','--bind',r.root+'/project-state','/home/codex/.cursor','--tmpfs','/tmp','--proc','/proc','--dev','/dev','--remount-ro','/','--clearenv','--setenv','HOME','/home/codex','--setenv','USER','codex','--setenv','LOGNAME','codex','--setenv','PATH','/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','--setenv','LANG','C.UTF-8','--setenv','LC_ALL','C.UTF-8','--setenv','CURSOR_CONFIG_DIR','/cursor-profile','--setenv','TMPDIR','/tmp','--',r.node,r.entry,'mcp','list'];
const result=spawnSync(r.bwrap,args,{encoding:'utf8',timeout:30000,maxBuffer:1048576,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});const after=snapshot();process.stdout.write(JSON.stringify({exitCode:result.status,signal:result.signal,timedOut:result.error?.code==='ETIMEDOUT',spawnError:result.error?.message??null,stdoutSha256:crypto.createHash('sha256').update(result.stdout??'').digest('hex'),stderrSha256:crypto.createHash('sha256').update(result.stderr??'').digest('hex'),before,after}));`;
  let setup = false;
  try {
    setup = true; await bridge.setup(cap, root, [], signal);
    const diagnostic = await wslNode<Record<string, any>>(cap, source, { root, node: cap.nodePath, entry: cap.entryPath, bwrap: cap.bwrapPath });
    assert.equal(diagnostic.exitCode, 0); assert.equal(diagnostic.signal, null); assert.equal(diagnostic.timedOut, false); assert.equal(diagnostic.spawnError, null);
    assert.deepEqual(diagnostic.after, diagnostic.before, `${mode} writable mcp loader changed controlled bytes`);
    assert.equal(diagnostic.before.profileConfig.safe.webFetchDomainAllowlistState, 'empty');
    assert.equal(diagnostic.before.homeProfileConfig.safe.webFetchDomainAllowlistState, 'empty');
    assert.equal(diagnostic.before.profileConfig.safe.channel, 'static');
    assert.equal(diagnostic.before.homeProfileConfig.safe.channel, 'static');
    await bridge.inspect(cap, root, signal); assert.deepEqual((await bridge.receipts(cap, root, signal)).receipts, []);
    return { mode, ...diagnostic, literalInspectPassed: true };
  } finally {
    if (setup) await bridge.cleanup(cap, root, marker, new AbortController().signal);
    assert.equal(await rootAbsent(cap, root), true);
  }
}

async function emptyAuthSandboxStartupProbe(cap: CursorWriteCapabilities, readonly: boolean): Promise<Record<string, unknown>> {
  const id = randomUUID(); const root = `/home/codex/.dual-model-workbench/writer-${id}`; const marker = `DMW_CURSOR_${id.replaceAll('-', '_').toUpperCase()}`;
  const receipt: CursorHookReceiptBinding = { mode: 'control', invocationNonce: randomUUID(), marker };
  const bridge = new SystemWslCursorHookProofBridge(receipt); const signal = new AbortController().signal;
  const source = String.raw`import fs from 'node:fs';import crypto from 'node:crypto';import {spawn} from 'node:child_process';const chunks=[];for await(const c of process.stdin)chunks.push(c);const r=JSON.parse(Buffer.concat(chunks).toString('utf8'));
if(!/^\/home\/codex\/\.dual-model-workbench\/writer-[a-f0-9-]{36}$/.test(r.root))throw Error('bad diagnostic root');const emptyAuth=r.root+'/diagnostic-empty-auth';fs.mkdirSync(emptyAuth,{mode:0o700});if(fs.readdirSync(emptyAuth).length!==0)throw Error('empty auth invariant failed');
const workspace=r.root+'/workspace',profile=r.root+'/profile',projectState=r.root+'/project-state';const args=['--unshare-all','--share-net','--die-with-parent','--new-session','--tmpfs','/','--dir','/usr','--ro-bind','/usr','/usr','--dir','/bin','--ro-bind','/bin','/bin','--dir','/sbin','--ro-bind','/sbin','/sbin','--dir','/lib','--ro-bind','/lib','/lib','--dir','/lib64','--ro-bind','/lib64','/lib64','--dir','/etc','--ro-bind','/etc','/etc','--dir','/mnt','--dir','/mnt/wsl','--file','3','/mnt/wsl/resolv.conf','--dir','/opt','--ro-bind','/opt','/opt','--dir','/workspace','--dir','/cursor-profile','--bind',workspace,'/workspace','--bind',profile,'/cursor-profile','--dir','/home','--dir','/home/codex','--dir','/home/codex/.config','--dir','/home/codex/.config/cursor','--ro-bind',emptyAuth,'/home/codex/.config/cursor','--dir','/home/codex/.cursor','--bind',projectState,'/home/codex/.cursor'];
if(r.readonly)args.push('--ro-bind',workspace+'/.cursor/cli.json','/workspace/.cursor/cli.json','--ro-bind',profile+'/cli-config.json','/cursor-profile/cli-config.json','--ro-bind',profile+'/hooks.json','/cursor-profile/hooks.json','--ro-bind',profile+'/deny-native.mjs','/cursor-profile/deny-native.mjs','--ro-bind',profile+'/receipt-binding.json','/cursor-profile/receipt-binding.json','--ro-bind',profile+'/scope-guard.mjs','/cursor-profile/scope-guard.mjs','--ro-bind',projectState+'/hooks.json','/home/codex/.cursor/hooks.json','--ro-bind',projectState+'/cli-config.json','/home/codex/.cursor/cli-config.json');
args.push('--tmpfs','/tmp','--proc','/proc','--dev','/dev','--remount-ro','/','--clearenv','--setenv','HOME','/home/codex','--setenv','USER','codex','--setenv','LOGNAME','codex','--setenv','SHELL','/bin/sh','--setenv','PATH','/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','--setenv','LANG','C.UTF-8','--setenv','LC_ALL','C.UTF-8','--setenv','CURSOR_CONFIG_DIR','/cursor-profile','--setenv','TMPDIR','/tmp','--setenv','NODE_COMPILE_CACHE','/tmp/compile-cache','--setenv','DMW_CURSOR_RUN_MARKER',r.marker,'--',r.node,r.entry,'--print','--output-format','stream-json','--sandbox','enabled','--trust','--model','grok-4.7-high-fast','--workspace','/workspace');
const resolv=fs.realpathSync('/etc/resolv.conf');if(resolv!=='/mnt/wsl/resolv.conf')throw Error('unexpected resolv target');const fd=fs.openSync(resolv,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const child=spawn(r.bwrap,args,{stdio:['pipe','pipe','pipe',fd],env:{HOME:'/home/codex',USER:'codex',LOGNAME:'codex',PATH:'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',DMW_CURSOR_RUN_MARKER:r.marker}});fs.closeSync(fd);
const stdout=[],stderr=[];let stdoutBytes=0,stderrBytes=0,unexpectedOutput=false,timedOut=false;const stop=()=>{try{child.kill('SIGTERM')}catch{}};child.stdout.on('data',c=>{stdoutBytes+=c.length;if(stdoutBytes<=1048576)stdout.push(c);unexpectedOutput=true;stop()});child.stderr.on('data',c=>{stderrBytes+=c.length;if(stderrBytes<=1048576)stderr.push(c)});child.stdin.end('Reply with exactly one word: READY\n');const timer=setTimeout(()=>{timedOut=true;stop()},30000);const ended=await new Promise(resolve=>{child.on('error',error=>resolve({code:null,signal:null,spawnError:error.message}));child.on('close',(code,signal)=>resolve({code,signal,spawnError:null}))});clearTimeout(timer);const out=Buffer.concat(stdout),err=Buffer.concat(stderr);const safe=err.toString('utf8');const category=unexpectedOutput?'unexpected_stdout':/Sandbox mode is enabled but not available on this system/.test(safe)?'sandbox_error':/(login|authentication|unauthenticated|sign in)/i.test(safe)?'login_required':timedOut?'timeout':'other';process.stdout.write(JSON.stringify({...ended,readonly:r.readonly,emptyAuthVerified:true,stdoutBytes,stderrBytes,stdoutSha256:crypto.createHash('sha256').update(out).digest('hex'),stderrSha256:crypto.createHash('sha256').update(err).digest('hex'),category,timedOut}));`;
  let setup = false;
  try {
    setup = true; await bridge.setup(cap, root, [], signal);
    return await wslNode<Record<string, unknown>>(cap, source, { root, marker, readonly, node: cap.nodePath, entry: cap.entryPath, bwrap: cap.bwrapPath }, 45_000);
  } finally {
    if (setup) await bridge.cleanup(cap, root, marker, new AbortController().signal);
    assert.equal(await rootAbsent(cap, root), true);
  }
}

type K3MountLayout = 'writable' | 'file-readonly' | 'workspace-cursor-dir-readonly';
async function emptyAuthK3PreflightProbe(cap: CursorWriteCapabilities, layout: K3MountLayout): Promise<Record<string, unknown>> {
  const id = randomUUID(); const root = `/home/codex/.dual-model-workbench/writer-${id}`; const marker = `DMW_CURSOR_${id.replaceAll('-', '_').toUpperCase()}`;
  const receipt: CursorHookReceiptBinding = { mode: 'control', invocationNonce: randomUUID(), marker };
  const bridge = new SystemWslCursorHookProofBridge(receipt); const signal = new AbortController().signal;
  const preflightProgram = String.raw`import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {spawnSync} from 'node:child_process';
const globals=['/bin','/sbin','/usr/bin','/usr/sbin','/lib','/lib64','/usr/lib','/usr/lib64','/usr/libexec','/usr/share','/etc/ld.so.cache','/etc/ld.so.conf','/etc/ld.so.conf.d','/etc/ssl/certs','/etc/ssl/openssl.cnf','/etc/ssl/cert.pem','/etc/ssl/ca-bundle.pem','/etc/ssl/certs/ca-certificates.crt','/etc/pki/tls/certs','/etc/pki/tls/openssl.cnf','/etc/pki/ca-trust/extracted','/etc/resolv.conf','/etc/hosts','/etc/nsswitch.conf','/etc/gai.conf','/etc/alternatives','/etc/mime.types','/etc/profile','/etc/bash.bashrc','/etc/zsh/zshenv','/etc/zsh/zprofile','/etc/zsh/zshrc','/etc/zsh/zlogin','/etc/gitconfig'];
const homeFiles=['.bashrc','.bash_profile','.profile','.zshenv','.zprofile','.zshrc','.zlogin','.gitconfig','.ssh/known_hosts','.config/mise/config.toml'];const homeDirs=['.cache/dotslash','.local/bin','.local/share/mise','.local/share/pnpm','.nvm','.volta','.asdf','.pyenv','.rbenv','.rustup','.cargo/bin','.cargo/registry','.cargo/git','.cache/node','.cache/yarn'];const home=process.env.HOME;const hardcoded=[...globals];for(const rel of homeFiles){const p=path.join(home,rel);try{if(fs.lstatSync(p).isFile())hardcoded.push(p)}catch{}}for(const rel of homeDirs){const p=path.join(home,rel);try{if(fs.lstatSync(p).isDirectory())hardcoded.push(p)}catch{}}const brewParts=['bin','sbin','lib','opt','Cellar','share','Frameworks','etc/gitconfig','etc/openssl@3/cert.pem','etc/openssl@3/openssl.cnf','etc/ca-certificates'];for(const base of ['/usr/local','/home/linuxbrew/.linuxbrew'])for(const rel of brewParts)hardcoded.push(base+'/'+rel);hardcoded.push('/usr/local/go','/nix/store','/nix/var/nix/profiles');const rg=path.join(path.dirname(process.argv[1]),'rg');try{if(fs.statSync(rg).isFile())hardcoded.push(rg)}catch{}
const policyDir=process.env.CURSOR_SANDBOX_POLICY_DIR;fs.mkdirSync(policyDir,{recursive:true,mode:0o700});fs.chmodSync(policyDir,0o700);const policyFile=path.join(policyDir,'sandbox-policy-'+crypto.randomBytes(8).toString('hex'));const value={sandbox:{type:'workspace_readwrite',cwd:'/workspace',readBoundary:'system',hardcodedReadPaths:[...new Set(hardcoded)],additionalReadonlyPaths:{[policyDir]:['**']},additionalReadwritePaths:[],disableTmpWrite:false}};const bytes=JSON.stringify(value);fs.writeFileSync(policyFile,bytes,{encoding:'utf8',mode:0o600});
const helper=path.join(path.dirname(process.argv[1]),'cursorsandbox');const env={...process.env};if(fs.existsSync(rg)){env.PATH=path.dirname(rg)+':'+env.PATH;env.CURSOR_RIPGREP_PATH=rg}const result=spawnSync(helper,['--policy',policyFile,'--preflight-only','--','/bin/true'],{stdio:['ignore','ignore','pipe'],timeout:15000,env,shell:false,encoding:'utf8'});const stderr=result.stderr??'';const category=result.status===0?'supported':result.status===2?'unsupported_kernel_features':/apparmor/i.test(stderr)?'apparmor':/permission denied|operation not permitted/i.test(stderr)?'permission':'other';const stderrSafe=/^[\x09\x0a\x0d\x20-\x7e]{0,500}$/.test(stderr)?stderr.trim():null;process.stdout.write(JSON.stringify({helperSha256:crypto.createHash('sha256').update(fs.readFileSync(helper)).digest('hex'),policySha256:crypto.createHash('sha256').update(bytes).digest('hex'),hardcodedReadPathCount:value.sandbox.hardcodedReadPaths.length,rgConfigured:env.CURSOR_RIPGREP_PATH===rg,status:result.status,signal:result.signal,timedOut:result.error?.code==='ETIMEDOUT',spawnError:result.error?.message??null,stderrBytes:Buffer.byteLength(stderr),stderrSha256:crypto.createHash('sha256').update(stderr).digest('hex'),stderrSafe,category}));`;
  const source = String.raw`import fs from 'node:fs';import crypto from 'node:crypto';import {spawnSync} from 'node:child_process';const chunks=[];for await(const c of process.stdin)chunks.push(c);const r=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!/^\/home\/codex\/\.dual-model-workbench\/writer-[a-f0-9-]{36}$/.test(r.root))throw Error('bad diagnostic root');const emptyAuth=r.root+'/k3-empty-auth';fs.mkdirSync(emptyAuth,{mode:0o700});if(fs.readdirSync(emptyAuth).length!==0)throw Error('empty auth invariant failed');
const workspace=r.root+'/workspace',profile=r.root+'/profile',projectState=r.root+'/project-state';const args=['--unshare-all','--die-with-parent','--new-session','--tmpfs','/','--dir','/usr','--ro-bind','/usr','/usr','--dir','/bin','--ro-bind','/bin','/bin','--dir','/sbin','--ro-bind','/sbin','/sbin','--dir','/lib','--ro-bind','/lib','/lib','--dir','/lib64','--ro-bind','/lib64','/lib64','--dir','/etc','--ro-bind','/etc','/etc','--dir','/opt','--ro-bind','/opt','/opt','--dir','/workspace','--dir','/cursor-profile','--bind',workspace,'/workspace','--bind',profile,'/cursor-profile','--dir','/home','--dir','/home/codex','--dir','/home/codex/.config','--dir','/home/codex/.config/cursor','--ro-bind',emptyAuth,'/home/codex/.config/cursor','--dir','/home/codex/.cursor','--bind',projectState,'/home/codex/.cursor'];if(r.layout!=='writable'){if(r.layout==='workspace-cursor-dir-readonly')args.push('--ro-bind',workspace+'/.cursor','/workspace/.cursor');else args.push('--ro-bind',workspace+'/.cursor/cli.json','/workspace/.cursor/cli.json');args.push('--ro-bind',profile+'/cli-config.json','/cursor-profile/cli-config.json','--ro-bind',profile+'/hooks.json','/cursor-profile/hooks.json','--ro-bind',profile+'/deny-native.mjs','/cursor-profile/deny-native.mjs','--ro-bind',profile+'/receipt-binding.json','/cursor-profile/receipt-binding.json','--ro-bind',profile+'/scope-guard.mjs','/cursor-profile/scope-guard.mjs','--ro-bind',projectState+'/hooks.json','/home/codex/.cursor/hooks.json','--ro-bind',projectState+'/cli-config.json','/home/codex/.cursor/cli-config.json')}args.push('--tmpfs','/tmp','--proc','/proc','--dev','/dev','--remount-ro','/','--clearenv','--setenv','HOME','/home/codex','--setenv','USER','codex','--setenv','LOGNAME','codex','--setenv','PATH','/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','--setenv','LANG','C.UTF-8','--setenv','LC_ALL','C.UTF-8','--setenv','CURSOR_CONFIG_DIR','/cursor-profile','--setenv','CURSOR_SANDBOX_POLICY_DIR','/cursor-profile/sandbox-policies','--setenv','TMPDIR','/tmp','--',r.node,'--input-type=module','-e',r.program,r.entry);const result=spawnSync(r.bwrap,args,{encoding:'utf8',timeout:20000,maxBuffer:1048576,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});if(result.status!==0||result.error)throw Error('outer K3 diagnostic failed status='+result.status+' error='+(result.error?.message??'none')+' stderrSha256='+crypto.createHash('sha256').update(result.stderr??'').digest('hex'));process.stdout.write(result.stdout);`;
  let setup = false;
  try {
    setup = true; await bridge.setup(cap, root, [], signal);
    const result = await wslNode<Record<string, unknown>>(cap, source, { root, layout, node: cap.nodePath, entry: cap.entryPath, bwrap: cap.bwrapPath,
      program: preflightProgram }, 30_000);
    return { layout, emptyAuthVerified: true, outerTreeClosed: true, ...result };
  } finally {
    if (setup) await bridge.cleanup(cap, root, marker, new AbortController().signal);
    assert.equal(await rootAbsent(cap, root), true);
  }
}

const renameObserverSource = String.raw`const fs=require('node:fs');const crypto=require('node:crypto');const{syncBuiltinESMExports}=require('node:module');
const target='/cursor-profile/cli-config.json',log='/cursor-profile/rename-observer.jsonl',key=crypto.randomBytes(32);let records=0;const originals={rename:fs.rename,renameSync:fs.renameSync,promiseRename:fs.promises.rename};
const type=v=>v===null?'null':Array.isArray(v)?'array':typeof v;const flat=(v,p='',m=new Map)=>{m.set(p||'/',{type:type(v),primitive:v===null||typeof v!=='object'?v:undefined});if(Array.isArray(v))v.forEach((x,i)=>flat(x,p+'/'+i,m));else if(v&&typeof v==='object')for(const k of Object.keys(v))flat(v[k],p+'/'+k.replaceAll('~','~0').replaceAll('/','~1'),m);return m};
const safeFile=file=>{const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid()||st.size>65536)throw Error('unsafe owned config');const bytes=fs.readFileSync(file);return{bytes,json:JSON.parse(bytes.toString('utf8')),size:st.size,hmac:crypto.createHmac('sha256',key).update(bytes).digest('hex')}};
const observe=(kind,src,dst,phase,errorCode)=>{try{if(records>=32||dst!==target||!/^\/cursor-profile\/cli-config\.json(?:\.[^/]+)*\.tmp$/.test(src))return;const before=safeFile(target),after=safeFile(src),a=flat(before.json),b=flat(after.json),changes=[];for(const p of new Set([...a.keys(),...b.keys()])){const x=a.get(p),y=b.get(p);if(!x)changes.push({path:p,change:'added',beforeType:null,afterType:y.type});else if(!y)changes.push({path:p,change:'removed',beforeType:x.type,afterType:null});else if(x.type!==y.type)changes.push({path:p,change:'type_changed',beforeType:x.type,afterType:y.type});else if(x.primitive!==undefined&&y.primitive!==undefined&&!Object.is(x.primitive,y.primitive))changes.push({path:p,change:'value_changed',beforeType:x.type,afterType:y.type})}const stack=String(new Error().stack||'').split('\n').slice(2).filter(x=>!x.includes('rename-observer.cjs')).slice(0,16);const line=JSON.stringify({kind,phase,errorCode:errorCode??null,current:{size:before.size,hmac:before.hmac},tmp:{size:after.size,hmac:after.hmac},changes,stack})+'\n';let size=0;try{size=fs.lstatSync(log).size}catch{}if(size+Buffer.byteLength(line)<=65536){fs.appendFileSync(log,line);records++}}catch{}};
fs.rename=function(src,dst,...rest){observe('rename',String(src),String(dst),'attempt');const cb=rest.at(-1);const args=typeof cb==='function'?[...rest.slice(0,-1),function(error,...values){if(error)observe('rename',String(src),String(dst),'error',error.code);return cb(error,...values)}]:rest;return originals.rename.call(this,src,dst,...args)};
fs.renameSync=function(src,dst,...rest){observe('renameSync',String(src),String(dst),'attempt');try{return originals.renameSync.call(this,src,dst,...rest)}catch(error){observe('renameSync',String(src),String(dst),'error',error?.code);throw error}};
fs.promises.rename=async function(src,dst,...rest){observe('promises.rename',String(src),String(dst),'attempt');try{return await originals.promiseRename.call(this,src,dst,...rest)}catch(error){observe('promises.rename',String(src),String(dst),'error',error?.code);throw error}};syncBuiltinESMExports();`;

async function globalRenameDiagnostic(cap: CursorWriteCapabilities): Promise<Record<string, unknown>> {
  const id = randomUUID(); const root = `/home/codex/.dual-model-workbench/writer-${id}`; const marker = `DMW_CURSOR_${id.replaceAll('-', '_').toUpperCase()}`;
  const bridge = new SystemWslCursorDenyBridge(); const controller = new AbortController(); let setup = false; let lifecycle: CursorWriterLifecycle | null = null;
  const install = String.raw`import fs from 'node:fs';import crypto from 'node:crypto';const chunks=[];for await(const c of process.stdin)chunks.push(c);const r=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!/^\/home\/codex\/\.dual-model-workbench\/writer-[a-f0-9-]{36}$/.test(r.root))throw Error('bad root');const p=r.root+'/profile';fs.writeFileSync(p+'/rename-observer.cjs',r.source,{flag:'wx',mode:0o700});fs.writeFileSync(p+'/rename-observer.jsonl','',{flag:'wx',mode:0o600});process.stdout.write(JSON.stringify({scriptSha256:crypto.createHash('sha256').update(r.source).digest('hex')}));`;
  const selfTestSource = String.raw`import fs from 'node:fs';import {spawnSync} from 'node:child_process';const chunks=[];for await(const c of process.stdin)chunks.push(c);const r=JSON.parse(Buffer.concat(chunks).toString('utf8')),p=r.root+'/profile',current=JSON.parse(fs.readFileSync(p+'/cli-config.json','utf8'));if(typeof current.channel!=='string')throw Error('observer selftest requires string channel');for(const suffix of ['callback','sync','promise'])fs.writeFileSync(p+'/cli-config.json.'+suffix+'.tmp',JSON.stringify({...current,channel:current.channel+'-observer-test',canary:r.canary}));const program="const fs=require('node:fs');const t='/cursor-profile/cli-config.json';const out={};fs.rename('/cursor-profile/cli-config.json.callback.tmp',t,e=>{out.callback=e?.code??null;try{fs.renameSync('/cursor-profile/cli-config.json.sync.tmp',t)}catch(e){out.sync=e.code}fs.promises.rename('/cursor-profile/cli-config.json.promise.tmp',t).catch(e=>{out.promise=e.code;process.stdout.write(JSON.stringify(out))})})";const args=['--unshare-all','--die-with-parent','--new-session','--tmpfs','/','--dir','/usr','--ro-bind','/usr','/usr','--dir','/bin','--ro-bind','/bin','/bin','--dir','/lib','--ro-bind','/lib','/lib','--dir','/lib64','--ro-bind','/lib64','/lib64','--dir','/opt','--ro-bind','/opt','/opt','--dir','/cursor-profile','--bind',p,'/cursor-profile','--ro-bind',p+'/cli-config.json','/cursor-profile/cli-config.json','--ro-bind',p+'/rename-observer.cjs','/cursor-profile/rename-observer.cjs','--proc','/proc','--dev','/dev','--remount-ro','/','--clearenv','--setenv','HOME','/tmp','--setenv','PATH','/usr/bin:/bin','--',r.node,'--require','/cursor-profile/rename-observer.cjs','-e',program];const x=spawnSync(r.bwrap,args,{encoding:'utf8',timeout:15000,env:{PATH:'/usr/bin:/bin'}});if(x.status!==0||x.error)throw Error('observer selftest child failed');const errors=JSON.parse(x.stdout),text=fs.readFileSync(p+'/rename-observer.jsonl','utf8');if(text.includes(r.canary))throw Error('observer leaked canary');const entries=text.split('\n').filter(Boolean).map(JSON.parse);fs.writeFileSync(p+'/rename-observer.jsonl','');process.stdout.write(JSON.stringify({errors,entryCount:entries.length,hasValueChanged:entries.every(e=>e.changes?.some(c=>c.path==='/channel'&&c.change==='value_changed'&&c.beforeType==='string'&&c.afterType==='string')),pathsControlled:entries.every(e=>!JSON.stringify(e).includes('/home/')),kinds:[...new Set(entries.map(e=>e.kind))].sort(),phases:[...new Set(entries.map(e=>e.phase))].sort()}));`;
  const readLog = String.raw`import fs from 'node:fs';const f=process.argv[1],st=fs.lstatSync(f);if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid()||st.size>65536)throw Error('unsafe observer log');const text=fs.readFileSync(f,'utf8'),lines=text.split('\n').filter(Boolean);if(lines.length>32)throw Error('observer log overflow');process.stdout.write(JSON.stringify({size:st.size,entries:lines.map(x=>JSON.parse(x))}));`;
  const runtime = cursorReadonlyRuntimeSource('deny');
  const mountAnchor = "    '--ro-bind', `${profile}/receipt-binding.json`, '/cursor-profile/receipt-binding.json',";
  const commandAnchor = "    '--', request.nodePath, request.entryPath, '--print', '--output-format', 'stream-json', '--sandbox', 'enabled',\n    '--trust', '--model', 'grok-4.7-high-fast', '--workspace', '/workspace',";
  assert.equal(runtime.split(mountAnchor).length - 1, 1); assert.equal(runtime.split(commandAnchor).length - 1, 1);
  const diagnosticRuntime = runtime.replace(mountAnchor, `${mountAnchor}\n    '--ro-bind', \`${'${profile}'}/rename-observer.cjs\`, '/cursor-profile/rename-observer.cjs',`)
    .replace(commandAnchor, "    '--', request.nodePath, '--require', '/cursor-profile/rename-observer.cjs', request.entryPath, '--print', '--output-format', 'stream-json', '--sandbox', 'enabled',\n    '--trust', '--model', 'grok-4.7-high-fast', '--workspace', '/workspace',");
  const stdoutLines: string[] = []; let run: RunProcessResult | null = null;
  try {
    setup = true; await bridge.setup(cap, root, [], controller.signal);
    const installed = await wslNode<Record<string, unknown>>(cap, install, { root, source: renameObserverSource });
    const canary = `OBSERVER_CANARY_${randomUUID()}`; const selfTest = await wslNode<Record<string, any>>(cap, selfTestSource, { root, node: cap.nodePath, bwrap: cap.bwrapPath, canary });
    assert.ok(selfTest.errors.callback && selfTest.errors.sync && selfTest.errors.promise); assert.equal(selfTest.entryCount, 6); assert.equal(selfTest.hasValueChanged, true); assert.equal(selfTest.pathsControlled, true); assert.deepEqual(selfTest.kinds, ['promises.rename', 'rename', 'renameSync']); assert.deepEqual(selfTest.phases, ['attempt', 'error']);
    report.renameDiagnostic = { root, marker, observer: installed, selfTest, startedAt: now(), stdoutUnexpected: false }; persist();
    const encoded = Buffer.from(JSON.stringify({ root, marker, nodePath: cap.nodePath, entryPath: cap.entryPath, bwrapPath: cap.bwrapPath }), 'utf8').toString('base64url');
    report.paidSegmentsAttempted += 1; persist();
    run = await runProcess(WSL, ['-d', cap.distro, '--cd', '/home/codex', '--exec', cap.setsidPath, '--wait', cap.nodePath, '--input-type=module', '-e', diagnosticRuntime, 'run', encoded, marker], {
      cwd: process.cwd(), env: hostEnv(), stdinText: 'Return exactly DIAGNOSTIC_READY and do not use tools.', timeoutMs: 120_000, signal: controller.signal,
      stdoutLogPath: path.join(evidenceRoot, 'rename-diagnostic.stdout.jsonl'), stderrLogPath: path.join(evidenceRoot, 'rename-diagnostic.stderr.log'),
      onStdoutLine: line => { stdoutLines.push(line); (report.renameDiagnostic as any).stdoutUnexpected = true; controller.abort(); }, onStderrLine: () => undefined,
    });
    lifecycle = await bridge.control(cap, root, marker);
    const env = hostEnv(); const rawLog = await runProcess(WSL, ['-d', cap.distro, '--cd', '/home/codex', '--exec', cap.nodePath, '--input-type=module', '-e', readLog, `${root}/profile/rename-observer.jsonl`], { cwd: process.cwd(), env, stdinText: null, timeoutMs: 15_000 });
    const parsedLog = rawLog.exitCode === 0 && !rawLog.spawnError && !rawLog.timedOut ? JSON.parse(rawLog.stdoutTail) : { readError: rawLog.spawnError ?? rawLog.stderrTail };
    Object.assign(report.renameDiagnostic as Record<string, unknown>, { run, lifecycle, stdoutLineCount: stdoutLines.length, observerLog: parsedLog,
      stdoutSha256: existsSync(path.join(evidenceRoot, 'rename-diagnostic.stdout.jsonl')) ? sha256(readFileSync(path.join(evidenceRoot, 'rename-diagnostic.stdout.jsonl'))) : null,
      stderrSha256: existsSync(path.join(evidenceRoot, 'rename-diagnostic.stderr.log')) ? sha256(readFileSync(path.join(evidenceRoot, 'rename-diagnostic.stderr.log'))) : null, completedAt: now() }); persist();
    return report.renameDiagnostic as Record<string, unknown>;
  } finally {
    if (setup) { if (!lifecycle && run) { try { lifecycle = await bridge.control(cap, root, marker); } catch {} } if (!run || lifecycleConfirmed(lifecycle)) await bridge.cleanup(cap, root, marker, new AbortController().signal); }
    (report.renameDiagnostic ??= {}).rootAbsent = await rootAbsent(cap, root); persist();
  }
}

function consumeLine(line: string, observations: Observation[], interactions: InteractionObservation[], protocol: { init: any[]; result: any[] }, violations: string[], abort: AbortController, discoveries: SchemaDiscoveryObservation[] = []): void {
  let event: any; try { event = JSON.parse(line); } catch { violations.push('non-JSON Cursor output'); abort.abort(); return; }
  if (event?.type === 'system' && event.subtype === 'init') { protocol.init.push(event); return; }
  if (event?.type === 'result') { protocol.result.push(event); return; }
  if (event?.type === 'interaction_query') {
    const fetch = event.query_type === 'webFetchRequestQuery'; const search = event.query_type === 'webSearchRequestQuery';
    if ((!fetch && !search) || !['request', 'response'].includes(event.subtype)) { violations.push('unexpected interaction query'); abort.abort(); return; }
    const kind = fetch ? 'web_fetch' : 'web_search'; let id: string | number | null = null; let argsMatch = false; let skipApprovalFalse = false; let locallyRejected = false; let approved = false;
    if (event.subtype === 'request') {
      const envelope = event.query; const value = fetch ? envelope?.webFetchRequestQuery : envelope?.webSearchRequestQuery; id = typeof envelope?.id === 'string' || typeof envelope?.id === 'number' ? envelope.id : null;
      let normalizedUrl: string | null = null; if (fetch) try { normalizedUrl = new globalThis.URL(value?.args?.url).href; } catch { /* mismatch */ }
      argsMatch = fetch ? normalizedUrl === URL : value?.args?.searchTerm === QUERY; skipApprovalFalse = fetch && value?.skipApproval === false;
    } else {
      const envelope = event.response; const value = fetch ? envelope?.webFetchRequestResponse : envelope?.webSearchRequestResponse; id = typeof envelope?.id === 'string' || typeof envelope?.id === 'number' ? envelope.id : null;
      locallyRejected = fetch && value?.rejected?.reason === 'User Rejected'; approved = search && !!value?.approved && typeof value.approved === 'object' && !Array.isArray(value.approved);
    }
    interactions.push({ kind, subtype: event.subtype, id, argsMatch, skipApprovalFalse, locallyRejected, approved, rawSha256: sha256(line) });
    if (event.subtype === 'request' && (!argsMatch || (fetch && !skipApprovalFalse))) { violations.push(`${kind} interaction mismatch`); abort.abort(); }
    if (event.subtype === 'response' && !(fetch ? locallyRejected : approved)) { violations.push(`${kind} interaction response mismatch`); abort.abort(); }
    return;
  }
  if (event?.type !== 'tool_call') return;
  const call = event.tool_call; const fetch = call?.webFetchToolCall; const search = call?.webSearchToolCall;
  const discovery = call?.getMcpToolsToolCall;
  if (discovery) {
    const args = discovery.args; const toolName = args?.toolName; const argsExact = args?.server === 'cursor' && ['WebFetch', 'WebSearch'].includes(toolName)
      && typeof args?.toolCallId === 'string' && Object.keys(args).sort().join(',') === 'server,toolCallId,toolName';
    let schemaToolMatches = event.subtype === 'started';
    if (event.subtype === 'completed') {
      try { const schema = JSON.parse(discovery.result?.success?.content); schemaToolMatches = schema?.tool === toolName && !!schema?.inputSchema && typeof schema.inputSchema === 'object' && !Array.isArray(schema.inputSchema); }
      catch { schemaToolMatches = false; }
    }
    if (!['started', 'completed'].includes(event.subtype) || !argsExact || !schemaToolMatches) { violations.push('unexpected dynamic tool schema discovery'); abort.abort(); return; }
    discoveries.push({ toolName, toolCallId: args.toolCallId, subtype: event.subtype, argsExact, schemaToolMatches, rawSha256: sha256(line) });
    if (discoveries.filter(item => item.toolName === toolName && item.subtype === event.subtype).length > 1) { violations.push('duplicate dynamic tool schema discovery'); abort.abort(); }
    if (observations.filter(item => item.subtype === 'started').length + discoveries.filter(item => item.subtype === 'started').length > MAX_TOOL_CALLS) { violations.push('tool budget exceeded'); abort.abort(); }
    return;
  }
  const kind = fetch ? 'web_fetch' : search ? 'web_search' : null;
  if (!kind || !['started', 'completed'].includes(event.subtype)) { violations.push('unexpected native tool event'); abort.abort(); return; }
  const value = fetch ?? search; let normalizedUrl: string | null = null;
  if (kind === 'web_fetch') { try { normalizedUrl = new globalThis.URL(value?.args?.url).href; } catch { /* mismatch below */ } }
  const argsMatch = kind === 'web_fetch' ? normalizedUrl === URL : value?.args?.searchTerm === QUERY;
  const result = value?.result; const successValue = result?.success; const success = successValue === true || (!!successValue && typeof successValue === 'object' && !Array.isArray(successValue));
  const rejected = !!result && ['error', 'rejected', 'permissionDenied'].some(key => key in result);
  observations.push({ kind, subtype: event.subtype, argsMatch, success, rejected, rawSha256: sha256(line) });
  if (!argsMatch) { violations.push(`${kind} target mismatch`); abort.abort(); }
  if (observations.filter(item => item.subtype === 'started').length + discoveries.filter(item => item.subtype === 'started').length > MAX_TOOL_CALLS) { violations.push('tool budget exceeded'); abort.abort(); }
}

function selfTestEvidenceContract(directory: string): Record<string, unknown> {
  const request = JSON.stringify({ type: 'interaction_query', subtype: 'request', query_type: 'webFetchRequestQuery', query: { id: 7, webFetchRequestQuery: { args: { url: URL, toolCallId: 'fixed' }, skipApproval: false } } });
  const response = JSON.stringify({ type: 'interaction_query', subtype: 'response', query_type: 'webFetchRequestQuery', response: { id: 7, webFetchRequestResponse: { rejected: { reason: 'User Rejected' } } } });
  const terminal = JSON.stringify({ type: 'result', subtype: 'success', is_error: false }); const lines = [request, response, terminal];
  const observations: Observation[] = [], interactions: InteractionObservation[] = [], protocol = { init: [] as any[], result: [] as any[] }, violations: string[] = [], abort = new AbortController();
  for (const line of lines) consumeLine(line, observations, interactions, protocol, violations, abort);
  assert.deepEqual(violations, []); assert.equal(interactions.length, 2); assert.equal(interactions[0]!.skipApprovalFalse, true); assert.equal(interactions[1]!.locallyRejected, true);
  const file = path.join(directory, 'contract-self-test.jsonl'); writeFileSync(file, `${lines.join('\r\n')}\r\n`); const complete = completeStreamEvidence(file, lines); rmSync(file);
  const badViolations: string[] = []; consumeLine(JSON.stringify({ type: 'interaction_query', subtype: 'request', query_type: 'unknownQuery', query: {} }), [], [], { init: [], result: [] }, badViolations, new AbortController());
  assert.deepEqual(badViolations, ['unexpected interaction query']);
  const discoveries: SchemaDiscoveryObservation[] = []; const discoveryViolations: string[] = [];
  for (const line of [
    JSON.stringify({ type: 'tool_call', subtype: 'started', tool_call: { getMcpToolsToolCall: { args: { server: 'cursor', toolName: 'WebFetch', toolCallId: 'fixed' } } } }),
    JSON.stringify({ type: 'tool_call', subtype: 'completed', tool_call: { getMcpToolsToolCall: { args: { server: 'cursor', toolName: 'WebFetch', toolCallId: 'fixed' }, result: { success: { content: JSON.stringify({ tool: 'WebFetch', inputSchema: { type: 'object' } }) } } } } }),
  ]) consumeLine(line, [], [], { init: [], result: [] }, discoveryViolations, new AbortController(), discoveries);
  assert.deepEqual(discoveryViolations, []); assert.equal(discoveries.length, 2);
  const wrongDiscovery: string[] = []; consumeLine(JSON.stringify({ type: 'tool_call', subtype: 'started', tool_call: { getMcpToolsToolCall: { args: { server: 'other', toolName: 'WebFetch', toolCallId: 'fixed' } } } }), [], [], { init: [], result: [] }, wrongDiscovery, new AbortController(), []);
  assert.deepEqual(wrongDiscovery, ['unexpected dynamic tool schema discovery']);
  return { passed: true, interactionCount: interactions.length, lineCount: complete.lineCount, normalizedSha256: complete.normalizedSha256, unknownQueryRejected: true, exactSchemaDiscoveryAllowed: true, otherSchemaDiscoveryRejected: true };
}

function readObservedModelState(cap: CursorWriteCapabilities, root: string): ObservedModelState {
  if (!/^\/home\/codex\/\.dual-model-workbench\/writer-[a-f0-9-]{36}$/.test(root)) throw new Error('bad model observation root');
  const source = `import fs from 'node:fs';\nconst __name=value=>value;const extract=${extractObservedModelState.toString()};\nconst file=process.argv[1];const info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()||info.size>1048576)throw Error('unsafe owned config');const value=JSON.parse(fs.readFileSync(file,'utf8'));process.stdout.write(JSON.stringify(extract(value)));`;
  const result = spawnSync(WSL.file, ['-d', cap.distro, '--cd', '/home/codex', '--exec', cap.nodePath, '--input-type=module', '-e', source, `${root}/profile/cli-config.json`], {
    cwd: process.cwd(), env: hostEnv(), encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0 || result.signal || result.error) throw new Error(`model state helper failed status=${result.status} signal=${result.signal ?? 'none'} stderrSha256=${sha256(result.stderr ?? '')}`);
  let parsed: unknown; try { parsed = JSON.parse(result.stdout); } catch { throw new Error(`model state helper invalid JSON size=${Buffer.byteLength(result.stdout)} sha256=${sha256(result.stdout)}`); }
  return extractObservedModelState(parsed);
}

async function modelStateDiagnostic(cap: CursorWriteCapabilities): Promise<Record<string, unknown>> {
  const id = randomUUID(); const root = `/home/codex/.dual-model-workbench/writer-${id}`; const marker = `DMW_CURSOR_${id.replaceAll('-', '_').toUpperCase()}`;
  const bridge = new SystemWslCursorDenyBridge(); const controller = new AbortController(); const stdoutPath = path.join(evidenceRoot, 'model-state-diagnostic.events.jsonl');
  const stderrPath = path.join(evidenceRoot, 'model-state-diagnostic.stderr.log'); const diagnostic: Record<string, any> = { root, markerSha256: sha256(marker), startedAt: now(), passed: false };
  report.modelStateDiagnostic = diagnostic; persist(); let setup = false; let dispatched = false; let lifecycle: CursorWriterLifecycle | null = null; let run: RunProcessResult | null = null;
  let initSeen = false; let observation: ObservedModelState | null = null; const streamedLines: string[] = []; const violations: string[] = [];
  try {
    const probe = await bridge.probe(cap, controller.signal); assert.equal(validateCursorIsolationProbe(cap, probe), null);
    setup = true; await bridge.setup(cap, root, [], controller.signal); await bridge.inspect(cap, root, controller.signal);
    report.diagnosticCliStarts = (report.diagnosticCliStarts ?? 0) + 1; diagnostic.dispatchedAt = now(); persist(); dispatched = true;
    try {
      run = await bridge.run(cap, { root, marker, nodePath: cap.nodePath, entryPath: cap.entryPath, bwrapPath: cap.bwrapPath }, 'Reply with exactly one word: READY', {
        signal: controller.signal, timeoutMs: MAX_SEGMENT_MS, stdoutLogPath: stdoutPath, stderrLogPath: stderrPath, onStarted: () => undefined,
        onStdoutLine: line => {
          const normalized = line.endsWith('\r') ? line.slice(0, -1) : line; streamedLines.push(normalized);
          if (initSeen) { violations.push('stdout after model-state capture'); controller.abort(); return; }
          let event: any; try { event = JSON.parse(normalized); } catch { violations.push('non-JSON output before model-state capture'); controller.abort(); return; }
          if (event?.type !== 'system' || event?.subtype !== 'init' || event?.model !== cap.reportedModel || event?.cwd !== '/workspace') {
            violations.push('first output was not exact approved system/init'); controller.abort(); return;
          }
          initSeen = true;
          try {
            observation = readObservedModelState(cap, root); const canonical = JSON.stringify(observation);
            diagnostic.observation = observation; diagnostic.observationSha256 = sha256(canonical); diagnostic.init = { model: event.model, cwd: event.cwd, rawSha256: sha256(normalized) };
            diagnostic.identity = { requestedModel: MODEL, reportedModel: cap.reportedModel, cliVersion: cap.cliVersion, nodeSha256: cap.nodeSha256, entrySha256: cap.entrySha256, bwrapSha256: cap.bwrapSha256 };
          } catch (error) { diagnostic.observationError = error instanceof Error ? error.message : String(error); }
          diagnostic.capturedAt = now(); persist(); controller.abort();
        }, onStderrLine: () => undefined,
      });
    } catch (error) { diagnostic.runError = error instanceof Error ? error.message : String(error); }
    try { lifecycle = await bridge.control(cap, root, marker); } catch (error) { diagnostic.controlError = error instanceof Error ? error.message : String(error); }
    diagnostic.runEvidence = { run, lifecycle, initSeen, streamedLineCount: streamedLines.length, streamedNormalizedSha256: sha256(normalizedLines(streamedLines)), violations,
      stdoutSha256: existsSync(stdoutPath) ? sha256(readFileSync(stdoutPath)) : null, stderrSha256: existsSync(stderrPath) ? sha256(readFileSync(stderrPath)) : null };
    persist(); assert.equal(diagnostic.observationError, undefined); assert.ok(observation); assert.equal(initSeen, true); assert.deepEqual(violations, []); assert.equal(streamedLines.length, 1); assert.ok(lifecycleConfirmed(lifecycle));
    diagnostic.validationPassed = true;
  } finally {
    if (setup) {
      if (dispatched && !lifecycle) { try { lifecycle = await bridge.control(cap, root, marker); } catch (error) { diagnostic.controlError = error instanceof Error ? error.message : String(error); } }
      const safe = !dispatched || lifecycleConfirmed(lifecycle); if (safe) { try { await bridge.cleanup(cap, root, marker, new AbortController().signal); } catch (error) { diagnostic.cleanupError = error instanceof Error ? error.message : String(error); } }
      const absent = await rootAbsent(cap, root); diagnostic.cleanup = { lifecycle, safe, rootAbsent: absent }; diagnostic.passed = diagnostic.validationPassed === true && safe && absent && !diagnostic.cleanupError;
    }
    diagnostic.completedAt = now(); persist();
  }
  assert.equal(diagnostic.passed, true); return diagnostic;
}

async function runSide(cap: CursorWriteCapabilities, mode: SideMode): Promise<Record<string, unknown>> {
  const id = randomUUID(); const root = `/home/codex/.dual-model-workbench/writer-${id}`;
  const marker = `DMW_CURSOR_${id.replaceAll('-', '_').toUpperCase()}`;
  const receipt: CursorHookReceiptBinding = { mode, invocationNonce: randomUUID(), marker };
  const artifacts = cursorHookProofArtifacts(cap, root, receipt); const bridge = new SystemWslCursorHookProofBridge(receipt);
  const sideRoot = path.join(evidenceRoot, mode); const stdoutPath = path.join(sideRoot, 'events.jsonl'); const stderrPath = path.join(sideRoot, 'stderr.log');
  mkdirSync(sideRoot, { recursive: true }); const side: Record<string, any> = { mode, root, markerSha256: sha256(marker), invocationNonce: receipt.invocationNonce,
    autoAcceptWebSearch: JSON.parse(artifacts.profileConfig).autoAcceptWebSearch, artifactHashes: artifacts.hashes, startedAt: now(), passed: false };
  report.sides.push(side); persist();
  const observations: Observation[] = []; const interactions: InteractionObservation[] = []; const discoveries: SchemaDiscoveryObservation[] = []; const protocol = { init: [] as any[], result: [] as any[] };
  const violations: string[] = []; const streamedLines: string[] = []; const abort = new AbortController();
  let setup = false; let dispatched = false; let lifecycle: CursorWriterLifecycle | null = null; let run: RunProcessResult | null = null;
  try {
    const probe = await bridge.probe(cap, abort.signal); assert.equal(validateCursorIsolationProbe(cap, probe), null);
    setup = true; await bridge.setup(cap, root, [], abort.signal); await bridge.inspect(cap, root, abort.signal);
    assert.deepEqual((await bridge.receipts(cap, root, abort.signal)).receipts, []);
    report.paidSegmentsAttempted += 1; side.dispatchedAt = now(); persist(); dispatched = true;
    const prompt = [
      '这是批准的公开网络因果对照。可选地各调用一次只读 GetDynamicTools schema 查询（server 必须为 cursor，toolName 只能是 WebFetch 或 WebSearch），随后只执行以下两个实际动作，各一次；禁止重试、禁止调用其他工具：',
      `1 WebFetch 请求 ${URL}`, `2 WebSearch 搜索固定词组：${QUERY}`, '两项结束后只简要说明结果。',
    ].join('\n');
    try {
      run = await bridge.run(cap, { root, marker, nodePath: cap.nodePath, entryPath: cap.entryPath, bwrapPath: cap.bwrapPath }, prompt, {
        signal: abort.signal, timeoutMs: MAX_SEGMENT_MS, stdoutLogPath: stdoutPath, stderrLogPath: stderrPath,
        onStarted: () => undefined, onStdoutLine: line => { streamedLines.push(line.endsWith('\r') ? line.slice(0, -1) : line); consumeLine(line, observations, interactions, protocol, violations, abort, discoveries); }, onStderrLine: () => undefined,
      });
    } catch (error) { side.runError = error instanceof Error ? error.message : String(error); }
    try { lifecycle = await bridge.control(cap, root, marker); }
    catch (error) { side.controlError = error instanceof Error ? error.message : String(error); }
    let completeStream: ReturnType<typeof completeStreamEvidence> | null = null;
    try { if (existsSync(stdoutPath)) completeStream = completeStreamEvidence(stdoutPath, streamedLines); }
    catch (error) { side.streamIntegrityError = error instanceof Error ? error.message : String(error); }
    side.runEvidence = { run, lifecycle, observations, interactions, discoveries, protocol, violations,
      streamedLineCount: streamedLines.length, streamedNormalizedSha256: sha256(normalizedLines(streamedLines)),
      diskLineCount: completeStream?.lineCount ?? null, diskNormalizedSha256: completeStream?.normalizedSha256 ?? null,
      stdoutSha256: existsSync(stdoutPath) ? sha256(readFileSync(stdoutPath)) : null,
      stderrSha256: existsSync(stderrPath) ? sha256(readFileSync(stderrPath)) : null };
    persist();
    if (lifecycleConfirmed(lifecycle)) {
      try { const inventory = await bridge.diagnostics(cap, root, new AbortController().signal); side.preValidationInventory = {
        directorySummary: inventory.directorySummary, truncated: inventory.inventoryTruncated, overflowPaths: inventory.inventoryOverflowPaths,
        projectionDiagnostics: inventory.projectionDiagnostics, diagnosticsTruncated: inventory.diagnosticsTruncated,
        profileGuardAudit: inventory.profileGuardAudit,
      }; }
      catch (error) { side.inventoryError = error instanceof Error ? error.message : String(error); }
      persist();
      try {
        const postSignal = new AbortController().signal;
        const workspaceSnapshot = await bridge.inspect(cap, root, postSignal);
        const postflight = await bridge.scopeAudit(cap, root, postSignal);
        side.postflight = { projectionAndArtifactsPassed: true, workspaceSnapshot, receipts: postflight.receipts,
          scopeAudit: postflight.scopeAudit, profileGuardAudit: postflight.profileGuardAudit, directorySummary: postflight.directorySummary };
      } catch (error) { side.postflightError = error instanceof Error ? error.message : String(error); }
      persist();
    }
    if (side.runError) throw new Error(side.runError); if (side.controlError) throw new Error(side.controlError);
    if (side.inventoryError) throw new Error(side.inventoryError); if (side.postflightError) throw new Error(side.postflightError);
    if (side.streamIntegrityError) throw new Error(side.streamIntegrityError); assert.ok(completeStream);
    assert.ok(run);
    assert.ok(lifecycleConfirmed(lifecycle)); assert.equal(run.exitCode, 0); assert.equal(run.signal, null); assert.equal(run.spawnError, null);
    assert.equal(run.timedOut, false); assert.equal(run.cancelled, false); assert.equal(run.terminationWarning, undefined); assert.deepEqual(violations, []);
    assert.equal(protocol.init.length, 1); assert.equal(protocol.init[0]?.model, cap.reportedModel); assert.equal(protocol.init[0]?.cwd, '/workspace');
    assert.equal(protocol.result.length, 1); assert.equal(protocol.result[0]?.subtype, 'success'); assert.equal(protocol.result[0]?.is_error, false);
    for (const toolName of ['WebFetch', 'WebSearch'] as const) { const values = discoveries.filter(item => item.toolName === toolName); assert.ok(values.length === 0 || values.length === 2);
      if (values.length) { assert.equal(values.filter(item => item.subtype === 'started').length, 1); assert.equal(values.filter(item => item.subtype === 'completed').length, 1); assert.equal(new Set(values.map(item => item.toolCallId)).size, 1); assert.equal(values.every(item => item.argsExact && item.schemaToolMatches), true); } }
    for (const kind of ['web_fetch', 'web_search'] as const) {
      const values = observations.filter(item => item.kind === kind); assert.equal(values.filter(item => item.subtype === 'started').length, 1);
      const completed = values.filter(item => item.subtype === 'completed'); assert.equal(completed.length, 1);
      if (mode === 'control' && kind === 'web_search') { assert.equal(completed[0]!.success, true); assert.equal(completed[0]!.rejected, false); }
      else { assert.equal(completed[0]!.success, false); assert.equal(completed[0]!.rejected, true); }
    }
    const fetchRequests = interactions.filter(item => item.kind === 'web_fetch' && item.subtype === 'request'); const fetchResponses = interactions.filter(item => item.kind === 'web_fetch' && item.subtype === 'response');
    const diskFetchRequests = completeStream.events.filter(event => event?.type === 'interaction_query' && event?.subtype === 'request' && event?.query_type === 'webFetchRequestQuery');
    if (mode === 'control') {
      assert.equal(fetchRequests.length, 1); assert.equal(fetchRequests[0]!.argsMatch, true); assert.equal(fetchRequests[0]!.skipApprovalFalse, true);
      assert.equal(fetchResponses.length, 1); assert.equal(fetchResponses[0]!.id, fetchRequests[0]!.id); assert.equal(fetchResponses[0]!.locallyRejected, true);
      assert.equal(diskFetchRequests.length, 1); side.verdict = { webFetchControlStage: 'approval-request-reached', webSearchControl: 'executed', webFetchServiceExecuted: false };
    } else {
      assert.equal(fetchRequests.length, 0); assert.equal(fetchResponses.length, 0); assert.equal(diskFetchRequests.length, 0); side.verdict = { negative: 'hook-before-approval' };
    }
    const receipts = side.postflight.receipts as CursorHookReceipt[]; side.receipts = receipts; persist();
    if (mode === 'control') assert.deepEqual(receipts, []);
    else {
      assert.deepEqual(receipts.map(item => item.toolName).sort(), ['WebFetch', 'WebSearch']);
      for (const item of receipts) { assert.equal(item.invocationNonce, receipt.invocationNonce); assert.equal(item.scriptSha256, artifacts.hashes.script);
        assert.equal(item.profileProjectionSha256, artifacts.hashes.profileProjection); assert.equal(item.homeProjectionSha256, artifacts.hashes.homeProjection);
        assert.equal(item.profileGuardSha256, artifacts.hashes.profileGuard); assert.equal(item.profileChunkSha256, artifacts.hashes.profileChunk);
        assert.equal(item.stdoutSha256, artifacts.hashes.fixedStdout); assert.equal(item.stdoutCompleted, true); assert.equal(item.exitCode, 2); }
    }
    const scopeAudit = side.postflight.scopeAudit; assert.equal(scopeAudit.length, 2); assert.deepEqual(scopeAudit.map((item: any) => item.toolName).sort(), ['WebFetch', 'WebSearch']);
    assert.equal(scopeAudit.every((item: any) => item.allowed === true), true);
    assert.equal(side.postflight.profileGuardAudit.length, 1); assert.equal(side.postflight.profileGuardAudit[0].chunkSha256, artifacts.hashes.profileChunk);
    side.workspaceSnapshot = side.postflight.workspaceSnapshot; side.validatedAt = now(); persist();
    side.validationPassed = true;
  } finally {
    if (setup) {
      if (dispatched && !lifecycle) { try { lifecycle = await bridge.control(cap, root, marker); } catch (error) { side.controlError = error instanceof Error ? error.message : String(error); } }
      const safe = !dispatched || lifecycleConfirmed(lifecycle); if (safe) { try { await bridge.cleanup(cap, root, marker, new AbortController().signal); } catch (error) { side.cleanupError = error instanceof Error ? error.message : String(error); } }
      const absent = await rootAbsent(cap, root); side.cleanup = { lifecycle, safe, rootAbsent: absent }; side.passed = side.validationPassed === true && safe && absent && !side.cleanupError;
    }
    side.completedAt = now(); persist();
  }
  assert.equal(side.passed, true); return side;
}

async function main(): Promise<void> {
  mkdirSync(WORK_ROOT, { recursive: true }); const disk = statfsSync(WORK_ROOT); assert.ok(disk.bavail * disk.bsize >= 256 * 1024 * 1024);
  mkdirSync(evidenceRoot, { recursive: true }); persist(); const contractSelfTest = selfTestEvidenceContract(evidenceRoot); const modelStateSelfTest = selfTestModelStateExtractor(); const config = loadConfig(); const cap = config.adapters.cursorWriter.capabilities;
  assert.ok(cap && cursorWriteAvailability(cap).available, cursorWriteAvailability(cap).reason); assert.equal(config.models.grok.model, MODEL); assert.equal(config.models.grok.effort, EFFORT);
  const syntheticRoot = `/home/codex/.dual-model-workbench/writer-${randomUUID()}`; const syntheticMarker = `DMW_CURSOR_${randomUUID().replaceAll('-', '_').toUpperCase()}`; const nonce = randomUUID();
  const control = cursorHookProofArtifacts(cap, syntheticRoot, { mode: 'control', invocationNonce: nonce, marker: syntheticMarker });
  const deny = cursorHookProofArtifacts(cap, syntheticRoot, { mode: 'deny', invocationNonce: nonce, marker: syntheticMarker });
  assert.equal(control.projectPolicy, deny.projectPolicy); assert.equal(control.profileConfig, deny.profileConfig); assert.equal(control.script, deny.script); assert.equal(control.scopeGuard, deny.scopeGuard); assert.equal(control.profileGuard, deny.profileGuard); assert.equal(control.binding, deny.binding); assert.notEqual(control.hooks, deny.hooks);
  const production = cursorDenyProfileArtifacts(cap, syntheticRoot);
  assert.equal(deny.script, production.script); assert.equal(deny.fixedStdout, production.fixedStdout);
  assert.deepEqual(JSON.parse(deny.hooks).hooks.preToolUse.at(-1), JSON.parse(production.hooks).hooks.preToolUse[0]);
  const writableLoader = { control: await writableLoaderProbe(cap, 'control'), deny: await writableLoaderProbe(cap, 'deny') };
  report.preparation = { completedAt: now(), capability: { cliVersion: cap.cliVersion, model: cap.model, reportedModel: cap.reportedModel, machineId: cap.machineId,
    nodeSha256: cap.nodeSha256, entrySha256: cap.entrySha256, bwrapSha256: cap.bwrapSha256 }, autoAcceptWebSearch: true,
    invariantHashes: { projectPolicy: control.hashes.projectPolicy, profileConfig: control.hashes.profileConfig, script: control.hashes.script, scopeGuard: control.hashes.scopeGuard,
      profileGuard: control.hashes.profileGuard, profileChunk: control.hashes.profileChunk, fixedStdout: control.hashes.fixedStdout },
    controlHooksSha256: control.hashes.hooks, denyHooksSha256: deny.hashes.hooks,
    productionScriptSha256: production.hashes.script, productionProfileGuardSha256: production.hashes.profileGuard,
    productionProfileChunkSha256: production.hashes.profileChunk, productionStdoutSha256: production.hashes.fixedStdout,
    readonlyRuntimeSha256: cursorReadonlyRuntimeSha256('paired'),
    contractSelfTest,
    modelStateSelfTest,
    writableLoader,
  };
  persist();
  if (diagnoseSandboxStartup) {
    report.emptyAuthSandboxStartup = {
      completedAt: now(), hardInvariant: 'owned empty auth directory only; no real auth mounted',
      writable: await emptyAuthSandboxStartupProbe(cap, false), readonly: await emptyAuthSandboxStartupProbe(cap, true),
    };
    persist(); return;
  }
  if (diagnoseK3Preflight) {
    report.emptyAuthK3Preflight = {
      completedAt: now(), hardInvariant: 'pure local cursorsandbox preflight; owned empty auth; no network sharing',
      writable: await emptyAuthK3PreflightProbe(cap, 'writable'), fileReadonly: await emptyAuthK3PreflightProbe(cap, 'file-readonly'),
      workspaceCursorDirectoryReadonly: await emptyAuthK3PreflightProbe(cap, 'workspace-cursor-dir-readonly'),
    };
    persist(); return;
  }
  if (diagnoseGlobalRename) { await globalRenameDiagnostic(cap); persist(); return; }
  if (diagnoseModelState) { await modelStateDiagnostic(cap); persist(); return; }
  if (!executeLive) return;
  const positive = await runSide(cap, 'control'); const negative = await runSide(cap, 'deny');
  assert.equal((positive as any).artifactHashes.projectPolicy, (negative as any).artifactHashes.projectPolicy);
  assert.equal((positive as any).artifactHashes.profileConfig, (negative as any).artifactHashes.profileConfig);
  assert.equal((positive as any).artifactHashes.script, (negative as any).artifactHashes.script);
  assert.equal((positive as any).artifactHashes.scopeGuard, (negative as any).artifactHashes.scopeGuard);
  report.passed = true; report.proofGenerated = true; report.completedAt = now(); persist();
}

try { await main(); process.stdout.write(`${JSON.stringify({ reportFile, paidSegmentsAttempted: report.paidSegmentsAttempted, proofGenerated: report.proofGenerated, passed: report.passed })}\n`); }
catch (error) { report.passed = false; report.proofGenerated = false; report.failure = error instanceof Error ? error.stack ?? error.message : String(error); report.completedAt = now(); persist(); process.stderr.write(`${JSON.stringify({ reportFile, paidSegmentsAttempted: report.paidSegmentsAttempted, error: report.failure })}\n`); process.exitCode = 1; }
