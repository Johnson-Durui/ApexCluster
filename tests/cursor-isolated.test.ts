import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { runProcess, type RunProcessResult } from '../src/adapters/process.js';
import type {
  CursorWriteCapabilities,
  CursorWriterBridge,
  CursorWriterLifecycle,
  CursorWriterProbe,
  CursorWriterSnapshot,
} from '../src/adapters/cursor-writer.js';
import {
  CURSOR_GROK_MODEL_STATE, CURSOR_HOOK_PROOF_MARKER, CURSOR_NATIVE_DENY_MARKER, CURSOR_PROFILE_CHUNK_SHA256,
  SystemWslCursorDenyBridge, SystemWslCursorHookProofBridge,
  cursorDenyProfileArtifacts, cursorHookProofArtifacts, cursorMutableConfigProjectionSha256, parseCursorPolicyHelperOutput,
} from '../src/chat/cursor-deny-bridge.js';
import { loadConfig } from '../src/config.js';
import { CursorIsolationError, runIsolatedCursorRound, validateCursorDenyAllSnapshot } from '../src/chat/cursor-isolated.js';
import { CURSOR_ENTRY_SHA256, CURSOR_NATIVE_APPROVAL_CASES, CURSOR_NATIVE_APPROVAL_MARKER, cursorNativeApprovalInjectionSource, cursorNativeApprovalSource } from '../src/chat/cursor-native-approval.js';
import {
  cursorReadonlyMountProbeRuntimeSource, cursorReadonlyProfileGuardProbeRuntimeSource, cursorReadonlyRuntimeSource,
  runCursorReadonlyMountProbe, runCursorReadonlyProfileGuardProbe,
} from '../src/chat/cursor-readonly-runtime.js';
import { tempDir } from './helpers.js';

const cap: CursorWriteCapabilities = {
  verifiedAt: '2026-10-27T00:00:00.000Z', cliVersion: 'cursor-agent 2026.10.22-27dcf5f',
  model: 'grok-4.7-high-fast', reportedModel: 'Grok 4.7 256K High Fast', distro: 'codex-cursor-h7', machineId: '1'.repeat(32),
  nodePath: '/opt/cursor-agent/versions/2026.10.22-27dcf5f/node', entryPath: '/opt/cursor-agent/versions/2026.10.22-27dcf5f/index.js',
  nodeSha256: 'a'.repeat(64), entrySha256: 'b'.repeat(64), bwrapPath: '/usr/bin/bwrap', bwrapSha256: 'c'.repeat(64),
  setsidPath: '/usr/bin/setsid', setsidSha256: 'd'.repeat(64), kernel: '6.6.87.2-microsoft-standard-WSL2',
  toolPolicy: 'workspace_edits_only', commandExitEventsVerified: true, fileChangesVerified: true,
  workspaceWriteVerified: true, isolatedWorkspaceVerified: true, terminationVerified: true,
};

const probe: CursorWriterProbe = {
  uid: 1000, machineId: cap.machineId, kernel: cap.kernel, nodeSha256: cap.nodeSha256, entrySha256: cap.entrySha256,
  bwrapSha256: cap.bwrapSha256, setsidSha256: cap.setsidSha256, bwrapSecure: true, setsidSecure: true,
  version: cap.cliVersion!, automountDisabled: true, interopDisabled: true, drvfsAbsent: true,
};

const policy = Buffer.from(`${JSON.stringify({ permissions: {
  allow: [], deny: ['Read(**)', 'Write(**)', 'Shell(*)', 'WebFetch(*)', 'WebSearch(*)', 'Mcp(*:*)'],
} }, null, 2)}\n`).toString('base64');

class FakeBridge implements CursorWriterBridge {
  calls: string[] = [];
  runTimeoutMs: number | null = null;
  constructor(private readonly mode: 'success' | 'native' | 'lifecycle' | 'drift' | 'throw_before_started' | 'budget' = 'success') {}
  async probe(): Promise<CursorWriterProbe> { this.calls.push('probe'); return this.mode === 'drift' ? { ...probe, nodeSha256: 'e'.repeat(64) } : probe; }
  async setup(_cap: CursorWriteCapabilities, _root: string, files: Parameters<CursorWriterBridge['setup']>[2], _signal: AbortSignal): Promise<void> {
    this.calls.push('setup'); assert.deepEqual(files, []);
    if (this.mode === 'budget') await new Promise(resolve => setTimeout(resolve, 20));
  }
  async run(_cap: CursorWriteCapabilities, _request: Parameters<CursorWriterBridge['run']>[1], _prompt: string, callbacks: Parameters<CursorWriterBridge['run']>[3]): Promise<RunProcessResult> {
    this.calls.push('run');
    this.runTimeoutMs = callbacks.timeoutMs;
    if (this.mode === 'throw_before_started') throw new Error('dispatch status unknown');
    callbacks.onStarted(123);
    callbacks.onStdoutLine(JSON.stringify(this.mode === 'native' ? { type: 'tool_call', tool_call: { shellToolCall: {} } } : { type: 'result', result: '{"result":"ok"}' }));
    return { exitCode: 0, signal: null, timedOut: false, cancelled: callbacks.signal.aborted, spawnError: null, stdoutTail: '', stderrTail: '', durationMs: 1, pid: 123 };
  }
  async control(): Promise<CursorWriterLifecycle> {
    this.calls.push('control');
    if (this.mode === 'throw_before_started') throw new Error('control unavailable');
    return this.mode === 'lifecycle'
      ? { confirmed: false, before: [123], remaining: [123], supervisorGone: false, bwrapGone: false }
      : { confirmed: true, before: [], remaining: [], supervisorGone: true, bwrapGone: true };
  }
  async inspect(): Promise<CursorWriterSnapshot> {
    this.calls.push('inspect'); return { files: [{ path: '.cursor/cli.json', type: 'file', size: Buffer.byteLength(policy, 'base64'), base64: policy }] };
  }
  async cleanup(): Promise<void> { this.calls.push('cleanup'); }
}

function options(bridge: CursorWriterBridge, signal = new AbortController().signal) {
  const root = tempDir();
  return {
    capabilities: cap, prompt: 'strict host JSON', signal, timeoutMs: 1000,
    stdoutLogPath: path.join(root, 'events.jsonl'), stderrLogPath: path.join(root, 'stderr.log'), onStdoutLine: () => undefined, bridge,
    nativeToolExclusionVerifier: async () => { (bridge as FakeBridge).calls?.push('exclusion'); },
  };
}

function createStaleUnixSocket(capabilities: CursorWriteCapabilities, root: string, relative: string, env: NodeJS.ProcessEnv): Promise<RunProcessResult> {
  return runProcess({ file: 'C:\\Windows\\System32\\wsl.exe', prefixArgs: [], via: 'config' }, [
    '-d', capabilities.distro, '--cd', '/home/codex', '--exec', capabilities.bwrapPath, '--unshare-all', '--die-with-parent', '--new-session',
    '--tmpfs', '/', '--dir', '/usr', '--ro-bind', '/usr', '/usr', '--dir', '/bin', '--ro-bind', '/bin', '/bin', '--dir', '/lib', '--ro-bind', '/lib', '/lib',
    '--dir', '/lib64', '--ro-bind', '/lib64', '/lib64', '--dir', '/home', '--dir', '/home/codex', '--dir', '/home/codex/.cursor',
    '--bind', `${root}/project-state`, '/home/codex/.cursor', '--proc', '/proc', '--dev', '/dev', '--', '/bin/sh', '-c',
    "/usr/bin/python3 -c 'import os,signal,socket,sys;s=socket.socket(socket.AF_UNIX);s.bind(sys.argv[1]);os.kill(os.getpid(),signal.SIGKILL)' \"$1\"; test -S \"$1\"",
    'dmw-stale-socket', `/home/codex/.cursor/${relative}`,
  ], { cwd: process.cwd(), env, stdinText: null, timeoutMs: 10_000 });
}

test('deny_all 隔离回合使用空工作区并在确认进程树后检查和清理', async () => {
  const bridge = new FakeBridge();
  const result = await runIsolatedCursorRound(options(bridge));
  assert.equal(result.exitConfirmed, true);
  assert.equal(result.nativeToolDetected, false);
  assert.deepEqual(bridge.calls, ['exclusion', 'probe', 'setup', 'run', 'control', 'inspect', 'cleanup']);
});

test('发现 Cursor 原生工具事件立即取消隔离子进程', async () => {
  const bridge = new FakeBridge('native');
  const result = await runIsolatedCursorRound(options(bridge));
  assert.equal(result.cancelled, true);
  assert.equal(result.nativeToolDetected, true);
  assert.equal(result.exitConfirmed, true);
});

test('进程树未确认时禁止检查和清理并返回明确退出未知错误', async () => {
  const bridge = new FakeBridge('lifecycle');
  await assert.rejects(runIsolatedCursorRound(options(bridge)), (error: unknown) => {
    assert.ok(error instanceof CursorIsolationError);
    assert.equal(error.exitConfirmed, false);
    return true;
  });
  assert.deepEqual(bridge.calls, ['exclusion', 'probe', 'setup', 'run', 'control']);
});

test('可信工具哈希漂移时在 setup 与模型启动前关闭', async () => {
  const bridge = new FakeBridge('drift');
  await assert.rejects(runIsolatedCursorRound(options(bridge)), (error: unknown) => error instanceof CursorIsolationError && error.exitConfirmed);
  assert.deepEqual(bridge.calls, ['exclusion', 'probe']);
});

test('native exclusion artifact/ABI 漂移在 probe、setup 与模型启动前关闭且确认未派发', async () => {
  const bridge = new FakeBridge(); const value = options(bridge);
  value.nativeToolExclusionVerifier = async () => { throw new Error('descriptor drift'); };
  await assert.rejects(runIsolatedCursorRound(value), (error: unknown) => error instanceof CursorIsolationError && error.exitConfirmed && /descriptor drift/.test(error.message));
  assert.deepEqual(bridge.calls, []);
});

test('run 在 onStarted 前抛错且 control 不可用时退出未知并禁止检查清理', async () => {
  const bridge = new FakeBridge('throw_before_started');
  await assert.rejects(runIsolatedCursorRound(options(bridge)), (error: unknown) => {
    assert.ok(error instanceof CursorIsolationError);
    assert.equal(error.exitConfirmed, false);
    return true;
  });
  assert.deepEqual(bridge.calls, ['exclusion', 'probe', 'setup', 'run', 'control']);
});

test('probe 与 setup 消耗从 run 的总超时预算扣除', async () => {
  const bridge = new FakeBridge('budget');
  const input = options(bridge); input.timeoutMs = 200;
  await runIsolatedCursorRound(input);
  assert.ok(bridge.runTimeoutMs !== null && bridge.runTimeoutMs < 200 && bridge.runTimeoutMs > 0);
});

test('setup 完成后收到取消时不派发模型并安全清理', async () => {
  const controller = new AbortController();
  class AbortAfterSetupBridge extends FakeBridge {
    override async setup(...args: Parameters<CursorWriterBridge['setup']>): Promise<void> {
      await super.setup(...args); controller.abort();
    }
  }
  const bridge = new AbortAfterSetupBridge();
  await assert.rejects(runIsolatedCursorRound(options(bridge, controller.signal)), (error: unknown) => error instanceof CursorIsolationError && error.exitConfirmed);
  assert.deepEqual(bridge.calls, ['exclusion', 'probe', 'setup', 'cleanup']);
});

test('setup 已创建目录但策略阶段失败时仍尝试清理且不派发模型', async () => {
  class PartialSetupBridge extends FakeBridge {
    override async setup(...args: Parameters<CursorWriterBridge['setup']>): Promise<void> {
      await super.setup(...args); throw new Error('deny policy setup failed');
    }
  }
  const bridge = new PartialSetupBridge();
  await assert.rejects(runIsolatedCursorRound(options(bridge)), (error: unknown) => error instanceof CursorIsolationError && error.exitConfirmed && /policy setup/.test(error.message));
  assert.deepEqual(bridge.calls, ['exclusion', 'probe', 'setup', 'cleanup']);
});

test('chat deny profile 使用固定全局 preToolUse hook 且不拼接模型输入', () => {
  const artifacts = cursorDenyProfileArtifacts(cap, `/home/codex/.dual-model-workbench/writer-${crypto.randomUUID()}`);
  const hooks = JSON.parse(artifacts.hooks);
  const profile = JSON.parse(artifacts.profileConfig);
  assert.equal(profile.channel, 'static');
  assert.deepEqual(profile.webFetchDomainAllowlist, []);
  assert.deepEqual(profile.sandbox, { mode: 'enabled', networkAccess: 'user_config_with_defaults', readBoundary: 'workspace' });
  assert.equal(profile.approvalMode, 'allowlist');
  assert.deepEqual({ model: profile.model, hasChangedDefaultModel: profile.hasChangedDefaultModel, maxMode: profile.maxMode,
    modelParameters: profile.modelParameters, selectedModel: profile.selectedModel, modelSelectionHistory: profile.modelSelectionHistory }, CURSOR_GROK_MODEL_STATE);
  assert.deepEqual(hooks.hooks.preToolUse, [{
    type: 'command', command: `'${cap.nodePath}' '/cursor-profile/deny-native.mjs'`, matcher: '.*', timeout: 5, failClosed: true,
  }]);
  assert.match(artifacts.script, new RegExp(CURSOR_NATIVE_DENY_MARKER));
  assert.match(artifacts.script, /value\?\.tool_name/);
  assert.doesNotMatch(artifacts.script, /value\?\.(?:tool_input|agent_message)/);
  for (const [name, value] of Object.entries({ projectPolicy: artifacts.projectPolicy, profileConfig: artifacts.profileConfig, hooks: artifacts.hooks, script: artifacts.script })) {
    assert.equal(artifacts.hashes[name as keyof typeof artifacts.hashes], crypto.createHash('sha256').update(value).digest('hex'));
  }
});

test('mutable Cursor settings projection only omits strictly typed vendor metadata', () => {
  const artifacts = cursorDenyProfileArtifacts(cap, `/home/codex/.dual-model-workbench/writer-${crypto.randomUUID()}`);
  const config = JSON.parse(artifacts.profileConfig);
  assert.equal(cursorMutableConfigProjectionSha256(config), artifacts.hashes.profileProjection);
  assert.equal(cursorMutableConfigProjectionSha256({ ...config, authInfo: { email: 'private@example.invalid', authId: 'auth', userId: 7, activeTeamId: 3 },
    privacyCache: { ghostMode: false, privacyMode: 2, updatedAt: 1 } }), artifacts.hashes.profileProjection);
  for (const invalid of [
    { ...config, unknownSetting: true },
    { ...config, permissions: { allow: ['Shell(*)'], deny: [] } },
    { ...config, model: { ...config.model, modelId: 'other-model' } },
    { ...config, selectedModel: { ...config.selectedModel, parameters: config.selectedModel.parameters.map((item: any) => item.id === 'context' ? { ...item, value: '128k' } : item) } },
    { ...config, selectedModel: { ...config.selectedModel, parameters: config.selectedModel.parameters.map((item: any) => item.id === 'reasoning_effort' ? { ...item, value: 'low' } : item) } },
    { ...config, selectedModel: { ...config.selectedModel, parameters: config.selectedModel.parameters.map((item: any) => item.id === 'fast' ? { ...item, value: 'false' } : item) } },
    { ...config, authInfo: { token: 'forbidden' } },
    { ...config, authInfo: { email: true } },
    { ...config, authInfo: { email: 123 } },
    { ...config, authInfo: { userId: '123' } },
    { ...config, privacyCache: { ghostMode: false, updatedAt: 'bad' } },
    { ...config, privacyCache: { ghostMode: false, updatedAt: 1, token: 'forbidden' } },
  ]) assert.throws(() => {
    const hash = cursorMutableConfigProjectionSha256(invalid);
    if (hash !== artifacts.hashes.profileProjection) throw new Error('projection mismatch');
  });
});

test('策略 helper 输出解析失败只报告模式、大小和哈希，contract 错误只报告字段名', () => {
  const artifacts = cursorDenyProfileArtifacts(cap, `/home/codex/.dual-model-workbench/writer-${crypto.randomUUID()}`);
  const invalid = '{not-json';
  assert.throws(() => parseCursorPolicyHelperOutput('inspect', invalid, artifacts.hashes), new RegExp(
    `helper_stdout_parse_failure mode=inspect size=${Buffer.byteLength(invalid)} sha256=${crypto.createHash('sha256').update(invalid).digest('hex')}`,
  ));
  assert.throws(
    () => parseCursorPolicyHelperOutput('audit', JSON.stringify({ ok: true, secretValue: 'MUST_NOT_APPEAR' }), artifacts.hashes),
    (error: unknown) => error instanceof Error && error.message === 'helper_contract_failure mode=audit fields=ok,secretValue' && !error.message.includes('MUST_NOT_APPEAR'),
  );
});

test('paired proof 两侧策略相同且唯一行为差异是固定 hook，receipt 脚本绑定自身哈希与真实 exit', () => {
  const root = `/home/codex/.dual-model-workbench/writer-${crypto.randomUUID()}`;
  const common = { invocationNonce: crypto.randomUUID(), marker: `DMW_CURSOR_${crypto.randomUUID().replaceAll('-', '_').toUpperCase()}` };
  const control = cursorHookProofArtifacts(cap, root, { mode: 'control', ...common });
  const deny = cursorHookProofArtifacts(cap, root, { mode: 'deny', ...common });
  const production = cursorDenyProfileArtifacts(cap, root);
  assert.equal(control.projectPolicy, deny.projectPolicy); assert.equal(control.profileConfig, deny.profileConfig);
  assert.equal(control.script, deny.script); assert.equal(control.scopeGuard, deny.scopeGuard); assert.equal(control.profileGuard, deny.profileGuard); assert.equal(control.binding, deny.binding); assert.notEqual(control.hooks, deny.hooks);
  assert.equal(JSON.parse(control.profileConfig).autoAcceptWebSearch, true);
  assert.equal(JSON.parse(control.profileConfig).channel, 'static'); assert.deepEqual(JSON.parse(control.profileConfig).webFetchDomainAllowlist, []);
  assert.equal(control.hashes.profileProjection, 'b0d1abec4f22acb6e2a397fa6ad5ccad859b584281c29354c1699dad7d83d603');
  const controlHooks = JSON.parse(control.hooks).hooks.preToolUse; const denyHooks = JSON.parse(deny.hooks).hooks.preToolUse;
  assert.equal(controlHooks.length, 1); assert.equal(controlHooks[0].command, `'${cap.nodePath}' '/cursor-profile/scope-guard.mjs'`); assert.equal(controlHooks[0].matcher, '.*');
  assert.deepEqual(denyHooks.slice(0, 1), controlHooks); assert.deepEqual(denyHooks[1], {
    type: 'command', command: `'${cap.nodePath}' '/cursor-profile/deny-native.mjs'`, matcher: '.*', timeout: 5, failClosed: true,
  });
  assert.equal(production.script, deny.script); assert.equal(production.profileGuard, deny.profileGuard); assert.equal(production.nativeApproval, deny.nativeApproval); assert.equal(production.fixedStdout, deny.fixedStdout);
  assert.deepEqual(JSON.parse(production.hooks).hooks.preToolUse[0], denyHooks[1]); assert.equal(JSON.parse(production.binding).markerSha256, null);
  assert.equal(JSON.parse(deny.binding).profileGuardSha256, deny.hashes.profileGuard); assert.equal(JSON.parse(deny.binding).profileChunkSha256, deny.hashes.profileChunk);
  assert.equal(JSON.parse(deny.binding).nativeApprovalSha256, deny.hashes.nativeApproval); assert.equal(JSON.parse(deny.binding).entrySha256, CURSOR_ENTRY_SHA256);
  assert.match(deny.script, /process\.on\('exit'/); assert.match(deny.script, /fs\.readFileSync\(self\)/); assert.match(deny.script, /stdoutCompleted/);
  assert.match(deny.scopeGuard, /scope-guard-audit\.jsonl/); assert.match(deny.scopeGuard, /toolInputShape/);
  assert.doesNotMatch(deny.scopeGuard, /user_email|transcript_path/);
  assert.equal(deny.hashes.fixedStdout, crypto.createHash('sha256').update(deny.fixedStdout).digest('hex'));
});

test('chat readonly runtime 只从唯一 legacy mount/command 锚点派生固定 deny/paired 变体', () => {
  const deny = cursorReadonlyRuntimeSource('deny'); const paired = cursorReadonlyRuntimeSource('paired');
  for (const source of [deny, paired]) {
    assert.ok(source.includes("'--ro-bind', `${workspace}/.cursor`"));
    assert.ok(!source.includes("'--ro-bind', `${workspace}/.cursor/cli.json`"));
    assert.ok(!source.includes("'--ro-bind', `${profile}/cli-config.json`"));
    assert.ok(source.includes("'--ro-bind', `${projectState}/hooks.json`"));
    assert.ok(!source.includes("'--ro-bind', `${projectState}/cli-config.json`"));
  }
  assert.match(deny, /deny-native\.mjs/); assert.match(deny, /receipt-binding\.json/); assert.doesNotMatch(deny, /scope-guard\.mjs/);
  assert.match(paired, /deny-native\.mjs/); assert.match(paired, /receipt-binding\.json/); assert.match(paired, /scope-guard\.mjs/);
  for (const source of [deny, paired]) {
    assert.match(source, /profile-guard\.cjs/); assert.match(source, /native-approval\.cjs/);
    assert.match(source, /--require', '\/cursor-profile\/profile-guard\.cjs', '--require', '\/cursor-profile\/native-approval\.cjs'/);
  }
  const probe = cursorReadonlyMountProbeRuntimeSource('deny');
  assert.doesNotMatch(probe, /readonly-probe-result\.json/); assert.match(probe, /readonly-probe-empty-auth/);
  assert.doesNotMatch(probe, /const authStore = '\/home\/codex\/\.config\/cursor'/);
  for (const source of [cursorReadonlyProfileGuardProbeRuntimeSource('deny'), cursorReadonlyProfileGuardProbeRuntimeSource('paired')]) {
    assert.match(source, /profile-guard-probe-empty-auth/); assert.match(source, /--require', '\/cursor-profile\/profile-guard\.cjs'/);
    assert.doesNotMatch(source, /grok-4\.7-high-fast/);
  }
});

test('remote native approval firewall pins the fixed entry ABI and rejects only the three typed approval queries', () => {
  const source = cursorNativeApprovalSource(cap);
  assert.match(source, new RegExp(CURSOR_ENTRY_SHA256));
  assert.match(source, /\.prototype\.run\.length!==11/);
  assert.match(source, /agent-client\/dist\/index\.js/); assert.match(source, /interaction-queries\.js/);
  for (const kind of CURSOR_NATIVE_APPROVAL_CASES) assert.match(source, new RegExp(kind));
  assert.match(source, new RegExp(CURSOR_NATIVE_APPROVAL_MARKER));
  assert.match(source, /Reflect\.apply\(originalQuery,targetObject/);
  assert.match(source, /number:'\+id/); assert.match(source, /string:'\+id/);
  assert.match(source, /toolCallIdSha256/); assert.match(source, /constructed:true,returned:true/);
  assert.match(source, /result\?\.case!==expectedCase/); assert.match(source, /result\?\.value\?\.result\?\.case!=='rejected'/);
  assert.doesNotMatch(source, /skipApproval|forceApprove|runEverything/);
});

test('remote native approval factory wrapper returns three typed rejections and delegates other queries with original listener identity', async () => {
  if (!process.getuid) Object.defineProperty(process, 'getuid', { value: () => 1000, configurable: true });
  const appended: string[] = []; const self = Buffer.from('fixed-firewall'); const selfHash = crypto.createHash('sha256').update(self).digest('hex');
  const binding = { invocationNonce: 'invocation', rootSha256: 'root', profileProjectionSha256: 'profile', homeProjectionSha256: 'home', nativeApprovalSha256: selfHash, entrySha256: CURSOR_ENTRY_SHA256 };
  const mockFs = { readFileSync: () => self, lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, uid: process.getuid?.() ?? 0, size: appended.join('').length }), appendFileSync: (_file: string, line: string) => appended.push(line) };
  const response = (kind: string, id: string | number, reason: string) => ({ id, result: { case: kind.replace('Query', 'Response'), value: { result: { case: 'rejected', value: { reason } } } } });
  const helpers = { webFetchRejected: (id: string | number, reason: string) => response('webFetchRequestQuery', id, reason), webSearchRejected: (id: string | number, reason: string) => response('webSearchRequestQuery', id, reason), generateImageRejected: (id: string | number, reason: string) => response('generateImageRequestQuery', id, reason) };
  let delegated = 0; let sendUpdateThis = false; let queryThis = false;
  const listener = { sendUpdate() { sendUpdateThis = this === listener; }, async query(_context: unknown, query: unknown) { queryThis = this === listener; delegated += 1; return { delegated: query }; } };
  class Base { async run(_a: unknown, _b: unknown, _c: unknown, _d: unknown, active: typeof listener, _f: unknown, _g: unknown, _h: unknown, _i: unknown, _j: unknown, query: unknown) { active.sendUpdate(); return active.query({}, query); } }
  const exports: Record<string, unknown> = {}; const modules: Record<string, Function> = { '../agent-client/dist/index.js': (_module: unknown, out: unknown, req: any) => req.d(out, { PW: () => Base }) };
  const webpackRequire: any = (key: string) => key === '../agent-core/dist/interaction-queries.js' ? { x1: helpers } : undefined;
  webpackRequire.d = (out: Record<string, unknown>, definitions: Record<string, () => unknown>) => { for (const [key, get] of Object.entries(definitions)) Object.defineProperty(out, key, { enumerable: true, get }); };
  const mockRequire = (key: string) => key === '/cursor-profile/receipt-binding.json' ? binding : key === 'node:fs' ? mockFs : key === 'node:crypto' ? crypto : undefined;
  new Function('__webpack_modules__', 'require', cursorNativeApprovalInjectionSource())(modules, mockRequire);
  modules['../agent-client/dist/index.js']!({ exports }, exports, webpackRequire);
  const Wrapped = exports.PW as new () => Base; const instance = new Wrapped();
  for (const [index, kind] of CURSOR_NATIVE_APPROVAL_CASES.entries()) {
    const id = index === 0 ? 0 : `query-${index}`; const query = { id, query: { case: kind, value: { args: { toolCallId: `tool-${index}` } } } };
    const result = await instance.run(null, null, null, null, listener, null, null, null, null, null, query) as any;
    assert.equal(result.id, id); assert.equal(result.result.value.result.case, 'rejected'); assert.equal(result.result.value.result.value.reason, CURSOR_NATIVE_APPROVAL_MARKER);
  }
  assert.equal(delegated, 0); assert.equal(sendUpdateThis, true);
  const other = { id: 9, query: { case: 'askQuestionInteractionQuery', value: {} } };
  assert.deepEqual(await instance.run(null, null, null, null, listener, null, null, null, null, null, other), { delegated: other });
  assert.equal(delegated, 1); assert.equal(queryThis, true);
  assert.equal(appended.length, 3); for (const line of appended) { assert.ok(line.endsWith('\n')); assert.doesNotThrow(() => JSON.parse(line)); }
});

test('真实固定 Cursor bundle 的 native approval factory ABI 匹配（不执行 entry 或模型）', { skip: process.env.DMW_RUN_WSL_CURSOR_POLICY !== '1' }, async () => {
  const capabilities = loadConfig().adapters.cursorWriter.capabilities; assert.ok(capabilities);
  const source = "import fs from 'node:fs';import crypto from 'node:crypto';const [file,hash]=process.argv.slice(1),text=fs.readFileSync(file,'utf8'),anchors=['\\\"../agent-client/dist/index.js\\\"(t,e,r){\\\"use strict\\\";r.d(e,{ao:()=>$,PW:()=>Oe,Yv:()=>M,cc:()=>G,SK:()=>L,DN:()=>U,rS:()=>Ie,mb:()=>p,Oe:()=>h});','\\\"../agent-core/dist/interaction-queries.js\\\"(t,e,r){\\\"use strict\\\";r.d(e,{l4:()=>d,x1:()=>m});','var __webpack_exports__=__webpack_require__(\\\"./src/main.tsx\\\")})();','class Oe{constructor(t,e,r={}){this.client=t,this.endpointUrl=e,this.options=r,this.hasStartedStream=!1}async run(t,e,r,s,i,c,u,l,d,m,p){','webSearchRejected:(t,e)=>new n.Y5','webFetchRejected:(t,e)=>new n.Y5','generateImageRejected:(t,e)=>new n.Y5'];const result={sha256:crypto.createHash('sha256').update(text).digest('hex'),anchors:anchors.map(anchor=>text.split(anchor).length-1)};if(result.sha256!==hash||result.anchors.some(count=>count!==1))throw Error(JSON.stringify(result));process.stdout.write(JSON.stringify(result));";
  const result = await runProcess({ file: 'C:\\Windows\\System32\\wsl.exe', prefixArgs: [], via: 'config' }, [
    '-d', capabilities.distro, '--cd', '/home/codex', '--exec', capabilities.nodePath, '--input-type=module', '-e', source, capabilities.entryPath, CURSOR_ENTRY_SHA256,
  ], { cwd: process.cwd(), env: Object.fromEntries(['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
    signal: new AbortController().signal, timeoutMs: 30_000, stdinText: null });
  assert.equal(result.exitCode, 0, result.stderrTail); assert.equal(result.spawnError, null); assert.equal(result.timedOut, false); assert.equal(result.cancelled, false);
  assert.deepEqual(JSON.parse(result.stdoutTail), { sha256: CURSOR_ENTRY_SHA256, anchors: [1, 1, 1, 1, 1, 1, 1] });
});

test('真实 WSL profile guard 在精确 bwrap UID namespace 中校验固定 chunk 并修补 factory（不启动 Cursor CLI）', { skip: process.env.DMW_RUN_WSL_CURSOR_POLICY !== '1' }, async () => {
  const capabilities = loadConfig().adapters.cursorWriter.capabilities; assert.ok(capabilities);
  const id = crypto.randomUUID(); const root = `/home/codex/.dual-model-workbench/writer-${id}`; const marker = `DMW_CURSOR_${id.replaceAll('-', '_').toUpperCase()}`;
  const bridge = new SystemWslCursorDenyBridge(); const controller = new AbortController(); const logs = tempDir();
  await bridge.setup(capabilities, root, [], controller.signal);
  try {
    type GuardProbe = { uid: number; expectedUid: number; mode: number; realpathMatches: boolean; sha256: string; same: boolean; stable: boolean; disabled: boolean };
    const box: { value: GuardProbe | null } = { value: null };
    const result = await runCursorReadonlyProfileGuardProbe('deny', capabilities, {
      root, marker, nodePath: capabilities.nodePath, entryPath: capabilities.entryPath, bwrapPath: capabilities.bwrapPath,
    }, {
      signal: controller.signal, timeoutMs: 30_000, stdoutLogPath: path.join(logs, 'guard.out'), stderrLogPath: path.join(logs, 'guard.err'),
      onStarted: () => undefined, onStdoutLine: line => { box.value = JSON.parse(line) as GuardProbe; }, onStderrLine: () => undefined,
    });
    assert.equal(result.exitCode, 0, result.stderrTail); assert.equal(result.spawnError, null); assert.equal(result.timedOut, false); assert.equal(result.cancelled, false);
    assert.ok(box.value); assert.equal(box.value.uid, box.value.expectedUid); assert.equal(box.value.mode & 0o022, 0); assert.equal(box.value.realpathMatches, true);
    assert.equal(box.value.sha256, CURSOR_PROFILE_CHUNK_SHA256); assert.equal(box.value.same, true); assert.equal(box.value.stable, true); assert.equal(box.value.disabled, true);
    const audit = await bridge.nativeAudit(capabilities, root, controller.signal); assert.equal(audit.profileGuardAudit.length, 1);
    const lifecycle = await bridge.control(capabilities, root, marker); assert.equal(lifecycle.confirmed, true); assert.deepEqual(lifecycle.remaining, []);
  } finally { await bridge.cleanup(capabilities, root, marker, new AbortController().signal); }
  await assert.rejects(bridge.inspect(capabilities, root, controller.signal));
});

test('真实 WSL chat bridge 生成严格 deny_all 策略并移除完整目录（不启动模型）', { skip: process.env.DMW_RUN_WSL_CURSOR_POLICY !== '1' }, async () => {
  const capabilities = loadConfig().adapters.cursorWriter.capabilities;
  assert.ok(capabilities);
  const bridge = new SystemWslCursorDenyBridge();
  const controller = new AbortController();
  const id = crypto.randomUUID();
  const root = `/home/codex/.dual-model-workbench/writer-${id}`;
  const marker = `DMW_CURSOR_${id.replaceAll('-', '_').toUpperCase()}`;
  await bridge.setup(capabilities, root, [], controller.signal);
  try {
    validateCursorDenyAllSnapshot(await bridge.inspect(capabilities, root, controller.signal));
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[key] !== undefined) env[key] = process.env[key];
    const chatBucket = crypto.createHash('md5').update('/workspace').digest('hex'); const chatSession = crypto.randomUUID();
    const seedCache = await runProcess({ file: 'C:\\Windows\\System32\\wsl.exe', prefixArgs: [], via: 'config' }, [
      '-d', capabilities.distro, '--cd', '/home/codex', '--exec', capabilities.nodePath, '--input-type=module', '-e',
      "import fs from 'node:fs';import crypto from 'node:crypto';const [root,bucket,session]=process.argv.slice(1),dir=root+'/profile/chats/'+bucket+'/'+session;fs.mkdirSync(dir,{recursive:true,mode:0o700});for(const name of ['store.db','store.db-wal','store.db-shm','meta.json','prompt_history.json','pasted_text.json'])fs.writeFileSync(dir+'/'+name,'',{mode:0o600});fs.writeFileSync(root+'/profile/statsig-cache.json','{}',{mode:0o600});fs.writeFileSync(root+'/project-state/agent-cli-state.json','{}',{mode:0o600});const project=root+'/project-state/projects/workspace',trust=project+'/.workspace-trusted';fs.mkdirSync(project,{recursive:true,mode:0o700});fs.writeFileSync(trust,JSON.stringify({trustedAt:'2026-10-27T00:00:00.000Z',workspacePath:'/workspace',trustMethod:'cli-flag'},null,2),{mode:0o600});fs.writeFileSync(project+'/repo.json',JSON.stringify({id:crypto.randomUUID()},null,2),{mode:0o600});fs.writeFileSync(project+'/worker.log','worker log',{mode:0o600})",
      root, chatBucket, chatSession,
    ], { cwd: process.cwd(), env, stdinText: null, timeoutMs: 10_000 });
    assert.equal(seedCache.exitCode, 0, seedCache.stderrTail);
    const staleWorkerSocket = await createStaleUnixSocket(capabilities, root, 'projects/workspace/worker.sock', env);
    assert.equal(staleWorkerSocket.spawnError, null); assert.equal(staleWorkerSocket.timedOut, false); assert.equal(staleWorkerSocket.exitCode, 0, staleWorkerSocket.stderrTail);
    await bridge.inspect(capabilities, root, controller.signal);
    const profileGuardCheck = await runProcess({ file: 'C:\\Windows\\System32\\wsl.exe', prefixArgs: [], via: 'config' }, [
      '-d', capabilities.distro, '--cd', '/home/codex', '--exec', capabilities.nodePath, '--require', `${root}/profile/profile-guard.cjs`, '-e',
      "const target=process.argv[1],chunk=require(target),factory=chunk.modules['./src/local-agent-profile.ts'],out={},wr=()=>{};wr.d=(value,defs)=>{for(const [key,get] of Object.entries(defs))Object.defineProperty(value,key,{enumerable:true,get})};factory({exports:out},out,wr);const direct=out.Rb,selectorA=out.UV,selectorB=out.UV,selected=selectorA({localAgent:false});const disabled=['enableTeamHooks','enableWorkspaceOpenHook','enableManagedSkillsSync','enableMarketplacePlugins','enableUserLocalPlugins','enableFirstPartyPlugins','enableMcp'];process.stdout.write(JSON.stringify({exports:Object.keys(out).sort(),same:direct===selected,stableSelector:selectorA===selectorB,kind:direct.kind,mode:direct.mode,disabled:disabled.every(key=>direct.capabilities[key]===false&&selected.capabilities[key]===false),auth:direct.capabilities.requiresCursorAuth,backend:direct.capabilities.enableCursorBackendServices,web:direct.capabilities.enableWebTools,localMarketplace:direct.capabilities.enableLocalMarketplacePlugins}))",
      capabilities.entryPath.replace(/\/index\.js$/, '/4060.index.js'),
    ], { cwd: process.cwd(), env, stdinText: null, timeoutMs: 10_000 });
    assert.equal(profileGuardCheck.exitCode, 0, profileGuardCheck.stderrTail); assert.deepEqual(JSON.parse(profileGuardCheck.stdoutTail), {
      exports: ['Rb', 'UV'], same: true, stableSelector: true, kind: 'remote', mode: 'normal', disabled: true, auth: true, backend: true, web: true, localMarketplace: false,
    });
    const cacheFile = `${root}/profile/chats/${chatBucket}/${chatSession}/store.db`;
    for (const [kind, program] of [
      ['executable', "import fs from 'node:fs';fs.chmodSync(process.argv[1],0o700)"],
      ['extra', "import fs from 'node:fs';fs.writeFileSync(process.argv[1]+'/config.json','{}')"],
      ['symlink', "import fs from 'node:fs';fs.symlinkSync('store.db',process.argv[1]+'/linked.db')"],
    ] as const) {
      const target = kind === 'executable' ? cacheFile : `${root}/profile/chats/${chatBucket}/${chatSession}`;
      const mutation = await runProcess({ file: 'C:\\Windows\\System32\\wsl.exe', prefixArgs: [], via: 'config' }, [
        '-d', capabilities.distro, '--cd', '/home/codex', '--exec', capabilities.nodePath, '--input-type=module', '-e', program, target,
      ], { cwd: process.cwd(), env, stdinText: null, timeoutMs: 10_000 });
      assert.equal(mutation.exitCode, 0); await assert.rejects(bridge.inspect(capabilities, root, controller.signal), /controlled(?:-| )(?:cache|directory)/);
      const cleanupProgram = kind === 'executable' ? "import fs from 'node:fs';fs.chmodSync(process.argv[1],0o600)" : "import fs from 'node:fs';fs.rmSync(process.argv[1]+'/'+process.argv[2])";
      const cleanupArgs = kind === 'executable' ? [cacheFile] : [target, kind === 'extra' ? 'config.json' : 'linked.db'];
      const mutationCleanup = await runProcess({ file: 'C:\\Windows\\System32\\wsl.exe', prefixArgs: [], via: 'config' }, [
        '-d', capabilities.distro, '--cd', '/home/codex', '--exec', capabilities.nodePath, '--input-type=module', '-e', cleanupProgram, ...cleanupArgs,
      ], { cwd: process.cwd(), env, stdinText: null, timeoutMs: 10_000 });
      assert.equal(mutationCleanup.exitCode, 0); await bridge.inspect(capabilities, root, controller.signal);
    }
    for (const [tool_name, tool_input] of [
      ['WebFetch', { url: 'https://example.com', ignoredCanary: 'MUST_NOT_AUDIT' }],
      ['WebSearch', { searchTerm: 'OpenAI official documentation', ignoredCanary: 'MUST_NOT_AUDIT' }],
    ] as const) {
      const hook = await runProcess({ file: 'C:\\Windows\\System32\\wsl.exe', prefixArgs: [], via: 'config' }, [
        '-d', capabilities.distro, '--cd', '/home/codex', '--exec', capabilities.nodePath, `${root}/profile/deny-native.mjs`,
      ], { cwd: process.cwd(), env, stdinText: JSON.stringify({ tool_name, tool_input: { ...tool_input, nested: { secret: 'SCOPE_VALUE_CANARY' } }, user_email: 'EMAIL_VALUE_CANARY' }), timeoutMs: 10_000 });
      assert.equal(hook.exitCode, 2); assert.equal(hook.stderrTail, '');
      assert.deepEqual(JSON.parse(hook.stdoutTail), { permission: 'deny', user_message: CURSOR_NATIVE_DENY_MARKER, agent_message: 'Native tools are disabled; use host JSON tools.' });
    }
    assert.deepEqual((await bridge.nativeAudit(capabilities, root, controller.signal)).audit, ['WebFetch', 'WebSearch']);
    validateCursorDenyAllSnapshot(await bridge.inspect(capabilities, root, controller.signal));
    const drift = await runProcess({ file: 'C:\\Windows\\System32\\wsl.exe', prefixArgs: [], via: 'config' }, [
      '-d', capabilities.distro, '--cd', '/home/codex', '--exec', capabilities.nodePath, '--input-type=module', '-e',
      "import fs from 'node:fs';fs.appendFileSync(process.argv[1], '\\n')", `${root}/profile/cli-config.json`,
    ], { cwd: process.cwd(), env, stdinText: null, timeoutMs: 10_000 });
    assert.equal(drift.exitCode, 0);
    assert.deepEqual((await bridge.nativeAudit(capabilities, root, controller.signal)).audit, ['WebFetch', 'WebSearch']);
    await bridge.inspect(capabilities, root, controller.signal);
    const legalMetadata = await runProcess({ file: 'C:\\Windows\\System32\\wsl.exe', prefixArgs: [], via: 'config' }, [
      '-d', capabilities.distro, '--cd', '/home/codex', '--exec', capabilities.nodePath, '--input-type=module', '-e',
      "import fs from 'node:fs';const f=process.argv[1];const v=JSON.parse(fs.readFileSync(f,'utf8'));v.authInfo={email:'private@example.invalid',userId:7};v.privacyCache={ghostMode:false,privacyMode:2,updatedAt:1};fs.writeFileSync(f,JSON.stringify(v,null,2)+'\\n')", `${root}/profile/cli-config.json`,
    ], { cwd: process.cwd(), env, stdinText: null, timeoutMs: 10_000 });
    assert.equal(legalMetadata.exitCode, 0); await bridge.inspect(capabilities, root, controller.signal);
    const residue = await runProcess({ file: 'C:\\Windows\\System32\\wsl.exe', prefixArgs: [], via: 'config' }, [
      '-d', capabilities.distro, '--cd', '/home/codex', '--exec', capabilities.nodePath, '--input-type=module', '-e',
      "import fs from 'node:fs';fs.writeFileSync(process.argv[1],'{}')", `${root}/profile/mcp.json`,
    ], { cwd: process.cwd(), env, stdinText: null, timeoutMs: 10_000 });
    assert.equal(residue.exitCode, 0); await assert.rejects(bridge.inspect(capabilities, root, controller.signal), /controlled-directory-drift.*"root":"profile".*"path":"mcp.json".*"type":"unexpected"/s);
    const clearResidue = await runProcess({ file: 'C:\\Windows\\System32\\wsl.exe', prefixArgs: [], via: 'config' }, [
      '-d', capabilities.distro, '--cd', '/home/codex', '--exec', capabilities.nodePath, '--input-type=module', '-e', "import fs from 'node:fs';fs.rmSync(process.argv[1])", `${root}/profile/mcp.json`,
    ], { cwd: process.cwd(), env, stdinText: null, timeoutMs: 10_000 });
    assert.equal(clearResidue.exitCode, 0); await bridge.inspect(capabilities, root, controller.signal);
    const semanticDrift = await runProcess({ file: 'C:\\Windows\\System32\\wsl.exe', prefixArgs: [], via: 'config' }, [
      '-d', capabilities.distro, '--cd', '/home/codex', '--exec', capabilities.nodePath, '--input-type=module', '-e',
      "import fs from 'node:fs';const f=process.argv[1];const v=JSON.parse(fs.readFileSync(f,'utf8'));v.autoAcceptWebSearch=true;fs.writeFileSync(f,JSON.stringify(v,null,2)+'\\n')", `${root}/profile/cli-config.json`,
    ], { cwd: process.cwd(), env, stdinText: null, timeoutMs: 10_000 });
    assert.equal(semanticDrift.exitCode, 0);
    await assert.rejects(bridge.inspect(capabilities, root, controller.signal), /mode=inspect.*mutable-config-projection-drift.*"label":"profileConfig".*"projectionSha256":"[a-f0-9]{64}".*"expectedProjectionSha256":"[a-f0-9]{64}"/s);
  }
  finally { await bridge.cleanup(capabilities, root, marker, controller.signal); }
  await assert.rejects(bridge.inspect(capabilities, root, controller.signal));
});

test('真实 WSL paired proof hook 生成绑定 receipt 并记录两次真实 exit 2（不启动 Cursor CLI）', { skip: process.env.DMW_RUN_WSL_CURSOR_POLICY !== '1' }, async () => {
  const capabilities = loadConfig().adapters.cursorWriter.capabilities; assert.ok(capabilities);
  const id = crypto.randomUUID(); const root = `/home/codex/.dual-model-workbench/writer-${id}`;
  const marker = `DMW_CURSOR_${id.replaceAll('-', '_').toUpperCase()}`; const invocationNonce = crypto.randomUUID();
  const bridge = new SystemWslCursorHookProofBridge({ mode: 'deny', invocationNonce, marker }); const controller = new AbortController();
  const env: NodeJS.ProcessEnv = {}; for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[key] !== undefined) env[key] = process.env[key];
  const artifacts = cursorHookProofArtifacts(capabilities, root, { mode: 'deny', invocationNonce, marker });
  await bridge.setup(capabilities, root, [], controller.signal);
  try {
    await bridge.inspect(capabilities, root, controller.signal); assert.deepEqual((await bridge.receipts(capabilities, root, controller.signal)).receipts, []);
    const chatBucket = crypto.createHash('md5').update('/workspace').digest('hex'); const chatSession = crypto.randomUUID();
    const seedCache = await runProcess({ file: 'C:\\Windows\\System32\\wsl.exe', prefixArgs: [], via: 'config' }, [
      '-d', capabilities.distro, '--cd', '/home/codex', '--exec', capabilities.nodePath, '--input-type=module', '-e',
      "import fs from 'node:fs';import crypto from 'node:crypto';const [root,bucket,session]=process.argv.slice(1),dir=root+'/profile/chats/'+bucket+'/'+session;fs.mkdirSync(dir,{recursive:true,mode:0o700});for(const name of ['store.db','store.db-wal','store.db-shm','meta.json','prompt_history.json','pasted_text.json'])fs.writeFileSync(dir+'/'+name,'',{mode:0o600});fs.writeFileSync(root+'/profile/statsig-cache.json','{}',{mode:0o600});fs.writeFileSync(root+'/project-state/agent-cli-state.json','{}',{mode:0o600});const project=root+'/project-state/projects/workspace',trust=project+'/.workspace-trusted';fs.mkdirSync(project,{recursive:true,mode:0o700});fs.writeFileSync(trust,JSON.stringify({trustedAt:'2026-10-27T00:00:00.000Z',workspacePath:'/workspace',trustMethod:'cli-flag'},null,2),{mode:0o600});fs.writeFileSync(project+'/repo.json',JSON.stringify({id:crypto.randomUUID()},null,2),{mode:0o600});fs.writeFileSync(project+'/worker.log','worker log',{mode:0o600})",
      root, chatBucket, chatSession,
    ], { cwd: process.cwd(), env, stdinText: null, timeoutMs: 10_000 });
    assert.equal(seedCache.exitCode, 0, seedCache.stderrTail);
    const staleWorkerSocket = await createStaleUnixSocket(capabilities, root, 'projects/workspace/worker.sock', env);
    assert.equal(staleWorkerSocket.spawnError, null); assert.equal(staleWorkerSocket.timedOut, false); assert.equal(staleWorkerSocket.exitCode, 0, staleWorkerSocket.stderrTail);
    const initialWorkerInventory = await bridge.inventory(capabilities, root, controller.signal);
    assert.equal(initialWorkerInventory.directorySummary.some(item => item.path === 'projects/workspace/worker.sock' && item.isSocket), true,
      JSON.stringify(initialWorkerInventory.directorySummary));
    await bridge.inspect(capabilities, root, controller.signal);
    const pairedProfileGuard = await runProcess({ file: 'C:\\Windows\\System32\\wsl.exe', prefixArgs: [], via: 'config' }, [
      '-d', capabilities.distro, '--cd', '/home/codex', '--exec', capabilities.nodePath, '--require', `${root}/profile/profile-guard.cjs`, '-e',
      "const chunk=require(process.argv[1]),factory=chunk.modules['./src/local-agent-profile.ts'],out={},wr=()=>{};wr.d=(value,defs)=>{for(const [key,get] of Object.entries(defs))Object.defineProperty(value,key,{enumerable:true,get})};factory({exports:out},out,wr);const direct=out.Rb,selectorA=out.UV,selectorB=out.UV,selected=selectorA({localAgent:false}),disabled=['enableTeamHooks','enableWorkspaceOpenHook','enableManagedSkillsSync','enableMarketplacePlugins','enableUserLocalPlugins','enableFirstPartyPlugins','enableMcp'];process.stdout.write(JSON.stringify({same:direct===selected,stable:selectorA===selectorB,disabled:disabled.every(key=>direct.capabilities[key]===false)}))",
      capabilities.entryPath.replace(/\/index\.js$/, '/4060.index.js'),
    ], { cwd: process.cwd(), env, stdinText: null, timeoutMs: 10_000 });
    assert.equal(pairedProfileGuard.exitCode, 0, pairedProfileGuard.stderrTail); assert.deepEqual(JSON.parse(pairedProfileGuard.stdoutTail), { same: true, stable: true, disabled: true });
    const cacheInventory = await bridge.inventory(capabilities, root, controller.signal);
    for (const expected of ['statsig-cache.json', 'agent-cli-state.json', `chats/${chatBucket}/${chatSession}/store.db`]) assert.equal(cacheInventory.directorySummary.some(item => item.path === expected), true, expected);
    const repoState = cacheInventory.directorySummary.find(item => item.path === 'projects/workspace/repo.json');
    const workerLog = cacheInventory.directorySummary.find(item => item.path === 'projects/workspace/worker.log');
    const workerSocket = cacheInventory.directorySummary.find(item => item.path === 'projects/workspace/worker.sock');
    assert.equal(repoState?.type, 'file'); assert.equal(repoState?.isSocket, false); assert.equal(workerLog?.type, 'file'); assert.equal(workerLog?.isSocket, false);
    assert.equal(workerSocket?.type, 'other', JSON.stringify(cacheInventory.directorySummary)); assert.equal(workerSocket?.isSocket, true); assert.equal(workerSocket?.size, undefined);
    assert.equal(workerSocket?.ownerMatches, true); assert.equal((workerSocket?.mode ?? 0) & 0o022, 0);
    const mutateWorker = async (program: string) => runProcess({ file: 'C:\\Windows\\System32\\wsl.exe', prefixArgs: [], via: 'config' }, [
      '-d', capabilities.distro, '--cd', '/home/codex', '--exec', capabilities.nodePath, '--input-type=module', '-e', program,
      `${root}/project-state/projects/workspace`,
    ], { cwd: process.cwd(), env, stdinText: null, timeoutMs: 10_000 });
    assert.equal((await mutateWorker("import fs from 'node:fs';const p=process.argv[1]+'/worker.sock';fs.rmSync(p);fs.writeFileSync(p,'not-a-socket',{mode:0o600})")).exitCode, 0);
    await assert.rejects(bridge.inspect(capabilities, root, controller.signal), /controlled repo worker invalid projects\/workspace\/worker\.sock/);
    const restoreSocket = async () => { assert.equal((await mutateWorker("import fs from 'node:fs';fs.rmSync(process.argv[1]+'/worker.sock',{force:true})")).exitCode, 0);
      const result = await createStaleUnixSocket(capabilities, root, 'projects/workspace/worker.sock', env); assert.equal(result.exitCode, 0, result.stderrTail); };
    await restoreSocket(); await bridge.inspect(capabilities, root, controller.signal);
    assert.equal((await mutateWorker("import fs from 'node:fs';const p=process.argv[1]+'/worker.sock';fs.rmSync(p);fs.symlinkSync('/dev/null',p)")).exitCode, 0);
    await assert.rejects(bridge.inspect(capabilities, root, controller.signal), /paired controlled directory drift projects\/workspace\/worker\.sock/);
    await restoreSocket(); await bridge.inspect(capabilities, root, controller.signal);
    const otherSocket = await createStaleUnixSocket(capabilities, root, 'projects/workspace/other.sock', env); assert.equal(otherSocket.exitCode, 0, otherSocket.stderrTail);
    await assert.rejects(bridge.inspect(capabilities, root, controller.signal), /paired controlled directory unexpected projects\/workspace\/other\.sock/);
    assert.equal((await mutateWorker("import fs from 'node:fs';fs.rmSync(process.argv[1]+'/other.sock')")).exitCode, 0); await bridge.inspect(capabilities, root, controller.signal);
    const deepUnknown = await runProcess({ file: 'C:\\Windows\\System32\\wsl.exe', prefixArgs: [], via: 'config' }, [
      '-d', capabilities.distro, '--cd', '/home/codex', '--exec', capabilities.nodePath, '--input-type=module', '-e',
      "import fs from 'node:fs';fs.mkdirSync(process.argv[1]+'/unexpected/a/b/c/d/e/f/g/h/i',{recursive:true,mode:0o700})", `${root}/project-state`,
    ], { cwd: process.cwd(), env, stdinText: null, timeoutMs: 10_000 });
    assert.equal(deepUnknown.exitCode, 0);
    const partialInventory = await bridge.inventory(capabilities, root, controller.signal);
    assert.equal(partialInventory.inventoryTruncated, true); assert.deepEqual(partialInventory.inventoryOverflowPaths, ['project-state:unexpected']);
    assert.equal(partialInventory.directorySummary.some(item => item.path === 'unexpected' && item.type === 'directory'), true);
    assert.equal(partialInventory.directorySummary.some(item => item.path.startsWith('unexpected/')), false);
    await assert.rejects(bridge.inspect(capabilities, root, controller.signal), /paired controlled directory unexpected unexpected/);
    const removeDeepUnknown = await runProcess({ file: 'C:\\Windows\\System32\\wsl.exe', prefixArgs: [], via: 'config' }, [
      '-d', capabilities.distro, '--cd', '/home/codex', '--exec', capabilities.nodePath, '--input-type=module', '-e',
      "import fs from 'node:fs';fs.rmSync(process.argv[1],{recursive:true})", `${root}/project-state/unexpected`,
    ], { cwd: process.cwd(), env, stdinText: null, timeoutMs: 10_000 });
    assert.equal(removeDeepUnknown.exitCode, 0); await bridge.inspect(capabilities, root, controller.signal);
    const projectionCanary = 'PRIVATE_MODEL_VALUE_CANARY';
    const driftProjection = await runProcess({ file: 'C:\\Windows\\System32\\wsl.exe', prefixArgs: [], via: 'config' }, [
      '-d', capabilities.distro, '--cd', '/home/codex', '--exec', capabilities.nodePath, '--input-type=module', '-e',
      "import fs from 'node:fs';const f=process.argv[1],v=JSON.parse(fs.readFileSync(f,'utf8'));v.selectedModel.parameters[0].value=process.argv[2];fs.writeFileSync(f,JSON.stringify(v,null,2)+'\\n')",
      `${root}/profile/cli-config.json`, projectionCanary,
    ], { cwd: process.cwd(), env, stdinText: null, timeoutMs: 10_000 });
    assert.equal(driftProjection.exitCode, 0);
    const projectionDiagnostic = await bridge.diagnostics(capabilities, root, controller.signal);
    assert.equal(projectionDiagnostic.diagnosticsTruncated, false); assert.equal(projectionDiagnostic.projectionDiagnostics.length, 1);
    assert.equal(projectionDiagnostic.projectionDiagnostics[0]!.path, '/profileConfig/selectedModel/parameters/0/value');
    assert.equal(projectionDiagnostic.projectionDiagnostics[0]!.beforeType, 'string'); assert.equal(projectionDiagnostic.projectionDiagnostics[0]!.afterType, 'string');
    assert.match(projectionDiagnostic.projectionDiagnostics[0]!.beforeHmac, /^[a-f0-9]{64}$/); assert.match(projectionDiagnostic.projectionDiagnostics[0]!.afterHmac, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(projectionDiagnostic).includes(projectionCanary), false);
    const restoreProjection = await runProcess({ file: 'C:\\Windows\\System32\\wsl.exe', prefixArgs: [], via: 'config' }, [
      '-d', capabilities.distro, '--cd', '/home/codex', '--exec', capabilities.nodePath, '--input-type=module', '-e',
      "import fs from 'node:fs';fs.writeFileSync(process.argv[1],Buffer.from(process.argv[2],'base64url'))", `${root}/profile/cli-config.json`, Buffer.from(artifacts.profileConfig).toString('base64url'),
    ], { cwd: process.cwd(), env, stdinText: null, timeoutMs: 10_000 });
    assert.equal(restoreProjection.exitCode, 0); await bridge.inspect(capabilities, root, controller.signal);
    for (const [tool_name, tool_input, exitCode, permission] of [
      ['WebFetch', { url: 'https://example.com' }, 0, 'allow'],
      ['WebFetch', { url: 'https://example.com/' }, 0, 'allow'],
      ['WebSearch', { searchTerm: 'OpenAI official documentation' }, 0, 'allow'],
      ['WebFetch', { url: 'https://example.org/' }, 2, 'deny'],
      ['Shell', { command: 'true' }, 2, 'deny'],
    ] as const) {
      const guard = await runProcess({ file: 'C:\\Windows\\System32\\wsl.exe', prefixArgs: [], via: 'config' }, [
        '-d', capabilities.distro, '--cd', '/home/codex', '--exec', capabilities.nodePath, `${root}/profile/scope-guard.mjs`,
      ], { cwd: process.cwd(), env, stdinText: JSON.stringify({ tool_name, tool_input }), timeoutMs: 10_000 });
      assert.equal(guard.exitCode, exitCode); assert.equal(JSON.parse(guard.stdoutTail).permission, permission);
    }
    for (const tool_name of ['WebFetch', 'WebSearch']) {
      const hook = await runProcess({ file: 'C:\\Windows\\System32\\wsl.exe', prefixArgs: [], via: 'config' }, [
        '-d', capabilities.distro, '--cd', '/home/codex', '--exec', capabilities.nodePath, `${root}/profile/deny-native.mjs`,
      ], { cwd: process.cwd(), env, stdinText: JSON.stringify({ tool_name }), timeoutMs: 10_000 });
      assert.equal(hook.exitCode, 2); assert.equal(hook.stderrTail, '');
      assert.deepEqual(JSON.parse(hook.stdoutTail), { permission: 'deny', user_message: CURSOR_HOOK_PROOF_MARKER, agent_message: 'Native tools are disabled; use host JSON tools.' });
    }
    const proofState = await bridge.receipts(capabilities, root, controller.signal); const receipts = proofState.receipts;
    assert.equal(proofState.profileGuardAudit.length, 1); assert.deepEqual(proofState.profileGuardAudit[0], {
      version: 1, chunkSha256: artifacts.hashes.profileChunk,
      disabled: ['enableTeamHooks', 'enableWorkspaceOpenHook', 'enableManagedSkillsSync', 'enableMarketplacePlugins', 'enableUserLocalPlugins', 'enableFirstPartyPlugins', 'enableMcp'],
    });
    const scope = await bridge.scopeAudit(capabilities, root, controller.signal);
    assert.equal(scope.scopeAudit.length, 5); assert.equal(scope.directorySummary.some(item => item.path === 'scope-guard-audit.jsonl' && item.type === 'file'), true);
    assert.equal(scope.directorySummary.some(item => item.root === 'workspace' && item.path === '.cursor/cli.json' && item.type === 'file'), true);
    assert.equal(JSON.stringify(scope.scopeAudit).includes('SCOPE_VALUE_CANARY'), false); assert.equal(JSON.stringify(scope.scopeAudit).includes('EMAIL_VALUE_CANARY'), false);
    assert.deepEqual(scope.scopeAudit.map(item => item.allowed), [true, true, true, false, false]);
    assert.deepEqual(receipts.map(item => item.toolName), ['WebFetch', 'WebSearch']);
    for (const receipt of receipts) {
      assert.equal(receipt.invocationNonce, invocationNonce); assert.equal(receipt.scriptSha256, artifacts.hashes.script);
      assert.equal(receipt.profileProjectionSha256, artifacts.hashes.profileProjection); assert.equal(receipt.homeProjectionSha256, artifacts.hashes.homeProjection);
      assert.equal(receipt.profileGuardSha256, artifacts.hashes.profileGuard); assert.equal(receipt.profileChunkSha256, artifacts.hashes.profileChunk);
      assert.equal(receipt.stdoutSha256, artifacts.hashes.fixedStdout); assert.equal(receipt.stdoutCompleted, true); assert.equal(receipt.exitCode, 2);
    }
    await bridge.inspect(capabilities, root, controller.signal);
  } finally { await bridge.cleanup(capabilities, root, marker, controller.signal); }
  await assert.rejects(bridge.inspect(capabilities, root, controller.signal));
});

test('真实 WSL chat readonly sandbox 拒绝所有受控文件写/改名/替换但允许日志追加，并可 control 清理', { skip: process.env.DMW_RUN_WSL_CURSOR_POLICY !== '1' }, async () => {
  const capabilities = loadConfig().adapters.cursorWriter.capabilities; assert.ok(capabilities);
  const env: NodeJS.ProcessEnv = {}; for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[key] !== undefined) env[key] = process.env[key];
  for (const flavor of ['deny', 'paired'] as const) {
    const id = crypto.randomUUID(); const root = `/home/codex/.dual-model-workbench/writer-${id}`; const marker = `DMW_CURSOR_${id.replaceAll('-', '_').toUpperCase()}`;
    const bridge = flavor === 'deny' ? new SystemWslCursorDenyBridge() : new SystemWslCursorHookProofBridge({ mode: 'deny', invocationNonce: crypto.randomUUID(), marker });
    const controller = new AbortController(); const logs = tempDir(); await bridge.setup(capabilities, root, [], controller.signal);
    let run: Promise<RunProcessResult> | null = null; let lifecycle: CursorWriterLifecycle | null = null;
    try {
      type ProbeResult = { attempts: Array<{ path: string; op: string; code: string }>; mutableAttempts: Array<{ path: string; op: string; code: string }>; logAppend: boolean };
      const probeBox: { value: ProbeResult | null } = { value: null };
      run = runCursorReadonlyMountProbe(flavor, capabilities, { root, marker, nodePath: capabilities.nodePath, entryPath: capabilities.entryPath, bwrapPath: capabilities.bwrapPath }, {
        signal: controller.signal, timeoutMs: 30_000, stdoutLogPath: path.join(logs, `${flavor}.out`), stderrLogPath: path.join(logs, `${flavor}.err`),
        onStarted: () => undefined, onStdoutLine: line => { probeBox.value = JSON.parse(line) as ProbeResult; }, onStderrLine: () => undefined,
      });
      for (let attempt = 0; attempt < 40 && !probeBox.value; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const probeResult = probeBox.value;
      assert.ok(probeResult); assert.equal(probeResult.logAppend, true);
      assert.equal(probeResult.attempts.length, (flavor === 'deny' ? 7 : 8) * 3);
      for (const item of probeResult.attempts) assert.ok(['EROFS', 'EBUSY', 'EPERM'].includes(item.code), `${flavor} ${item.path} ${item.op} unexpectedly returned ${item.code}`);
      assert.equal(probeResult.mutableAttempts.length, 6);
      for (const item of probeResult.mutableAttempts) assert.equal(item.code, 'SUCCESS', `${flavor} ${item.path} ${item.op} should be mutable`);
      await bridge.inspect(capabilities, root, controller.signal);
      if (flavor === 'deny') assert.deepEqual((await (bridge as SystemWslCursorDenyBridge).nativeAudit(capabilities, root, controller.signal)).audit, []);
      else assert.deepEqual((await (bridge as SystemWslCursorHookProofBridge).receipts(capabilities, root, controller.signal)).receipts, []);
      lifecycle = await bridge.control(capabilities, root, marker); assert.ok(lifecycle.confirmed && lifecycle.remaining.length === 0 && lifecycle.supervisorGone && lifecycle.bwrapGone);
      await run;
    } finally {
      if (!lifecycle && run) lifecycle = await bridge.control(capabilities, root, marker);
      if (!run || (lifecycle?.confirmed && lifecycle.remaining.length === 0)) await bridge.cleanup(capabilities, root, marker, new AbortController().signal);
    }
    await assert.rejects(bridge.inspect(capabilities, root, controller.signal));
  }
});

test('整体截止时间会中断 probe，不继续创建目录或调用模型', async () => {
  class SlowProbeBridge extends FakeBridge {
    override async probe(_cap?: CursorWriteCapabilities, signal?: AbortSignal): Promise<CursorWriterProbe> {
      this.calls.push('probe');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 1000);
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('probe aborted at deadline')); }, { once: true });
      });
      return probe;
    }
  }
  const bridge = new SlowProbeBridge(); const value = options(bridge); value.timeoutMs = 25;
  await assert.rejects(runIsolatedCursorRound(value), /deadline/);
  assert.deepEqual(bridge.calls, ['exclusion', 'probe']);
});
