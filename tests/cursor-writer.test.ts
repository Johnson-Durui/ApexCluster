import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {
  cursorWriteAvailability,
  importRecoveryWarning,
  CursorWslWriterAdapter,
  type CursorWriteCapabilities,
  type CursorWriterBridge,
  type CursorWriterLifecycle,
  type CursorWriterProbe,
  type CursorWriterSnapshot,
} from '../src/adapters/cursor-writer.js';
import type { RunProcessResult } from '../src/adapters/process.js';
import type { ModelTaskSpec } from '../src/adapters/types.js';
import { OUTPUT_SCHEMAS } from '../src/core/schemas.js';
import { toStrictJsonSchema } from '../src/core/strict-json-schema.js';
import { tempDir } from './helpers.js';

const CLI_VERSION = 'cursor-agent 2026.10.22-27dcf5f';
const REPORTED_MODEL = 'Grok 4.7 256K High Fast';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function runtimeResolvResolver(): (fileSystem: any) => { sourcePath: string; sandboxPath: string; mountOption: string; layout: string } {
  const source = readFileSync(path.resolve('src/adapters/cursor-writer-runtime.mjs'), 'utf8');
  const match = /function resolveResolvConf\(fileSystem = fs\) \{[\s\S]*?\n\}/.exec(source);
  assert.ok(match, 'runtime resolv resolver missing');
  return vm.runInNewContext(`(${match[0]})`);
}

const resolvStat = (type: 'file' | 'link' | 'other', uid = 0, mode = 0o100644) => ({
  uid, mode, isFile: () => type === 'file', isSymbolicLink: () => type === 'link',
});

test('Cursor runtime accepts only the strict WSL symlink or secure root regular resolv layouts', () => {
  const resolve = runtimeResolvResolver();
  const symlink = resolve({
    lstatSync: (file: string) => file === '/etc/resolv.conf' ? resolvStat('link') : resolvStat('file'),
    realpathSync: () => '/mnt/wsl/resolv.conf',
  });
  assert.deepEqual({ ...symlink }, { sourcePath: '/mnt/wsl/resolv.conf', sandboxPath: '/mnt/wsl/resolv.conf', mountOption: '--file', layout: 'wsl-symlink-v1' });
  const regular = resolve({ lstatSync: () => resolvStat('file') });
  assert.deepEqual({ ...regular }, { sourcePath: '/etc/resolv.conf', sandboxPath: '/etc/resolv.conf', mountOption: '--ro-bind-data', layout: 'root-regular-v2' });
  for (const fileSystem of [
    { lstatSync: (file: string) => file === '/etc/resolv.conf' ? resolvStat('link') : resolvStat('file'), realpathSync: () => '/tmp/escape' },
    { lstatSync: (file: string) => file === '/etc/resolv.conf' ? resolvStat('link') : resolvStat('file', 1000), realpathSync: () => '/mnt/wsl/resolv.conf' },
    { lstatSync: () => resolvStat('file', 1000) }, { lstatSync: () => resolvStat('file', 0, 0o100666) },
    { lstatSync: () => resolvStat('other') },
  ]) assert.throws(() => resolve(fileSystem));
  const source = readFileSync(path.resolve('src/adapters/cursor-writer-runtime.mjs'), 'utf8');
  assert.match(source, /'--ro-bind', '\/etc', '\/etc'/); assert.match(source, /resolv\.mountOption, '3', resolv\.sandboxPath/);
  assert.match(source, /O_RDONLY \| fs\.constants\.O_NOFOLLOW/); assert.match(source, /fs\.fstatSync\(resolvFd\)/); assert.match(source, /'--remount-ro', '\/'/);
});

function capabilities(overrides: Partial<CursorWriteCapabilities> = {}): CursorWriteCapabilities {
  return {
    verifiedAt: '2026-10-23T00:00:00.000Z', cliVersion: CLI_VERSION,
    model: 'grok-4.7-high-fast', reportedModel: REPORTED_MODEL,
    distro: 'codex-cursor-h7', machineId: '1'.repeat(32),
    nodePath: '/opt/cursor-agent/versions/2026.10.22-27dcf5f/node',
    entryPath: '/opt/cursor-agent/versions/2026.10.22-27dcf5f/index.js',
    nodeSha256: HASH_A, entrySha256: HASH_B, bwrapPath: '/usr/bin/bwrap', bwrapSha256: 'c'.repeat(64),
    setsidPath: '/usr/bin/setsid', setsidSha256: 'd'.repeat(64), kernel: '6.6.87.2-microsoft-standard-WSL2',
    toolPolicy: 'workspace_edits_only', commandExitEventsVerified: true, fileChangesVerified: true,
    workspaceWriteVerified: true, isolatedWorkspaceVerified: true, terminationVerified: true,
    ...overrides,
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function fixture(): { root: string; workspace: string; logDir: string; commit: string; tree: string } {
  const root = tempDir();
  const workspace = path.join(root, 'workspace');
  const logDir = path.join(root, 'logs');
  mkdirSync(workspace); mkdirSync(logDir);
  git(workspace, 'init', '-q');
  git(workspace, 'config', 'user.email', 'fixture@example.invalid');
  git(workspace, 'config', 'user.name', 'Cursor Writer Fixture');
  writeFileSync(path.join(workspace, 'src.ts'), 'export const value = 1;\n');
  writeFileSync(path.join(workspace, 'other.ts'), 'export const other = 1;\n');
  git(workspace, 'add', 'src.ts', 'other.ts');
  git(workspace, 'commit', '-q', '-m', 'fixture');
  return { root, workspace, logDir, commit: git(workspace, 'rev-parse', 'HEAD'), tree: git(workspace, 'rev-parse', 'HEAD^{tree}') };
}

function spec(f: ReturnType<typeof fixture>, overrides: Partial<ModelTaskSpec> = {}): ModelTaskSpec {
  return {
    taskId: 't-grok-light-1', runId: 'r-1', role: 'grok', phase: 'build', attempt: 1,
    model: 'grok-4.7-high-fast', effort: 'high', prompt: '把 value 改为 2，只改允许文件。',
    outputSchema: toStrictJsonSchema(OUTPUT_SCHEMAS.probe), cwd: f.workspace, logDir: f.logDir,
    timeoutMs: 20_000, sandbox: 'workspace_write', allowNetwork: false, gitRepo: true, allowWeb: false,
    resumeSessionId: null,
    context: {
      snapshotRef: null, constraintIds: [], criterionIds: [], knownQuestionIds: [], anonymousMap: null,
      recheckItems: null, spec: null, mockScenario: null,
      lightRework: { allowedFiles: ['src.ts'], workspaceCommit: f.commit, treeHash: f.tree, specRef: 'spec-1', round: 1 },
    } as ModelTaskSpec['context'],
    ...overrides,
  };
}

function policy(): Buffer {
  return Buffer.from(`${JSON.stringify({ sandbox: { readBoundary: 'workspace' }, permissions: { allow: ['Read(/workspace/src.ts)', 'Write(/workspace/src.ts)'], deny: [
    'Shell(*)', 'WebFetch(*)', 'Mcp(*:*)',
    'Read(/workspace/.cursor/**)', 'Write(/workspace/.cursor/**)',
    'Read(/cursor-profile/**)', 'Write(/cursor-profile/**)',
    'Read(/home/codex/.cursor/**)', 'Write(/home/codex/.cursor/**)',
    'Read(/home/**)', 'Write(/home/**)', 'Read(/root/**)', 'Write(/root/**)',
    'Read(/proc/**)', 'Write(/proc/**)', 'Read(/tmp/**)', 'Write(/tmp/**)',
    'Read(/etc/**)', 'Write(/etc/**)', 'Read(/usr/**)', 'Write(/usr/**)',
    'Read(/opt/**)', 'Write(/opt/**)', 'Read(/bin/**)', 'Write(/bin/**)',
    'Read(/sbin/**)', 'Write(/sbin/**)', 'Read(/lib/**)', 'Write(/lib/**)',
    'Read(/lib64/**)', 'Write(/lib64/**)', 'Read(/dev/**)', 'Write(/dev/**)',
    'Read(/run/**)', 'Write(/run/**)', 'Read(/sys/**)', 'Write(/sys/**)',
    'Read(/var/**)', 'Write(/var/**)', 'Read(/mnt/**)', 'Write(/mnt/**)',
  ] } }, null, 2)}\n`);
}

type FakeMode = 'success' | 'shell' | 'outside' | 'new_file' | 'delete' | 'symlink' | 'bad_policy' | 'lifecycle' | 'control_throw' | 'probe_drift' | 'windows_drift' | 'bad_init' | 'unknown_event' | 'cleanup_fail';

class FakeBridge implements CursorWriterBridge {
  calls: string[] = [];
  prompt = '';
  request: unknown = null;
  root = '';
  staged = new Map<string, Buffer>();
  cleanupCalled = false;
  constructor(readonly mode: FakeMode = 'success', readonly windowsFile?: string) {}

  async probe(cap: CursorWriteCapabilities): Promise<CursorWriterProbe> {
    this.calls.push('probe');
    return {
      uid: 1000, machineId: this.mode === 'probe_drift' ? '2'.repeat(32) : cap.machineId,
      kernel: cap.kernel, nodeSha256: cap.nodeSha256, entrySha256: cap.entrySha256, version: cap.cliVersion!,
      bwrapSha256: cap.bwrapSha256, setsidSha256: cap.setsidSha256, bwrapSecure: true, setsidSecure: true,
      automountDisabled: true, interopDisabled: true, drvfsAbsent: true,
    };
  }

  async setup(_cap: CursorWriteCapabilities, root: string, files: { path: string; base64: string }[]): Promise<void> {
    this.calls.push('setup'); this.root = root;
    for (const file of files) this.staged.set(file.path, Buffer.from(file.base64, 'base64'));
  }

  async run(_cap: CursorWriteCapabilities, request: Parameters<CursorWriterBridge['run']>[1], prompt: string, callbacks: Parameters<CursorWriterBridge['run']>[3]): Promise<RunProcessResult> {
    this.calls.push('run'); this.request = request; this.prompt = prompt; callbacks.onStarted(1234);
    const workspace = '/workspace';
    const emit = (value: object) => callbacks.onStdoutLine(JSON.stringify(value));
    emit({ type: 'system', subtype: 'init', model: this.mode === 'bad_init' ? 'Wrong Model' : REPORTED_MODEL, cwd: workspace, session_id: 'session-1' });
    if (this.mode === 'unknown_event') emit({ type: 'mystery', subtype: 'credential_probe' });
    if (this.mode === 'shell') emit({ type: 'tool_call', subtype: 'started', tool_call: { shellToolCall: { args: { command: 'echo forbidden' } } } });
    else if (this.mode === 'outside') emit({ type: 'tool_call', subtype: 'started', tool_call: { editToolCall: { args: { path: `${this.root}/outside.txt` } } } });
    else {
      emit({ type: 'tool_call', subtype: 'completed', tool_call: { editToolCall: { args: { path: `${workspace}/src.ts` } } } });
      this.staged.set('src.ts', Buffer.from('export const value = 2;\n'));
    }
    if (this.mode === 'windows_drift' && this.windowsFile) writeFileSync(this.windowsFile, 'external drift\n');
    emit({ type: 'result', subtype: 'success', is_error: false, result: '已修改允许文件。', session_id: 'session-1', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 0 } });
    return { exitCode: 0, signal: null, timedOut: false, cancelled: callbacks.signal.aborted, spawnError: null, stdoutTail: '', stderrTail: '', durationMs: 12, pid: 1234 };
  }

  async control(): Promise<CursorWriterLifecycle> {
    this.calls.push('control');
    if (this.mode === 'control_throw') throw new Error('control unavailable');
    return this.mode === 'lifecycle'
      ? { confirmed: false, before: [9], remaining: [9], supervisorGone: false, bwrapGone: false }
      : { confirmed: true, before: [], remaining: [], supervisorGone: true, bwrapGone: true };
  }

  async inspect(): Promise<CursorWriterSnapshot> {
    this.calls.push('inspect');
    const files: CursorWriterSnapshot['files'] = [...this.staged].map(([filePath, data]) => ({ path: filePath, type: 'file', size: data.length, sha256: cryptoHash(data), base64: data.toString('base64') }));
    if (this.mode === 'delete') files.splice(files.findIndex((item) => item.path === 'src.ts'), 1);
    if (this.mode === 'new_file') files.push({ path: 'surprise.ts', type: 'file', size: 1, sha256: cryptoHash(Buffer.from('x')), base64: Buffer.from('x').toString('base64') });
    if (this.mode === 'symlink') files.push({ path: 'link.ts', type: 'symlink' });
    const policyData = this.mode === 'bad_policy' ? Buffer.from('changed') : policy();
    files.push({ path: '.cursor/cli.json', type: 'file', size: policyData.length, sha256: cryptoHash(policyData), base64: policyData.toString('base64') });
    return { files };
  }

  async cleanup(): Promise<void> { this.calls.push('cleanup'); this.cleanupCalled = true; if (this.mode === 'cleanup_fail') throw new Error('cleanup unavailable'); }
}

function cryptoHash(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

test('能力门禁严格校验全部 H7 字段', () => {
  assert.equal(cursorWriteAvailability(capabilities()).available, true);
  for (const cap of [
    null,
    capabilities({ verifiedAt: 'not-a-date' }), capabilities({ cliVersion: null }),
    capabilities({ model: 'grok-other' }), capabilities({ reportedModel: ' ' }),
    capabilities({ distro: 'Ubuntu' }), capabilities({ machineId: 'bad' }),
    capabilities({ nodePath: '/tmp/node' }), capabilities({ entryPath: '/other/index.js' }),
    capabilities({ nodeSha256: 'bad' }), capabilities({ bwrapPath: '/tmp/bwrap' }), capabilities({ setsidSha256: 'bad' }), capabilities({ toolPolicy: null as never }),
    capabilities({ terminationVerified: false }), capabilities({ isolatedWorkspaceVerified: false }),
  ]) assert.equal(cursorWriteAvailability(cap).available, false);
});

test('残留共享导入 journal 在模型启动前阻断并可供重启恢复扫描', async () => {
  const f = fixture();
  const journal = path.join(f.workspace, '.git', 'cursor-writer-import.lock');
  writeFileSync(journal, `${JSON.stringify({ version: 1, state: 'rollback_uncertain', entries: [] })}\n`);
  assert.match(importRecoveryWarning(f.workspace) ?? '', /rollback_uncertain/);
  const bridge = new FakeBridge();
  const result = await new CursorWslWriterAdapter({ capabilities: capabilities(), bridge }).run(spec(f), () => undefined, new AbortController().signal);
  assert.equal(result.status, 'failed');
  assert.match(result.failure?.message ?? '', /共享导入 journal/);
  assert.deepEqual(bridge.calls, []);
});

test('错误 init 型号与未知事件在导入前立即失败', async () => {
  for (const mode of ['bad_init', 'unknown_event'] as const) {
    const f = fixture(); const bridge = new FakeBridge(mode);
    const result = await new CursorWslWriterAdapter({ capabilities: capabilities(), bridge }).run(spec(f), () => undefined, new AbortController().signal);
    assert.equal(result.status, 'failed', mode);
    assert.equal(bridge.calls.includes('inspect'), false, mode);
    assert.equal(readFileSync(path.join(f.workspace, 'src.ts'), 'utf8'), 'export const value = 1;\n');
  }
});

test('control 抛错与 cleanup 失败都会留下全局终止警告', async () => {
  for (const mode of ['control_throw', 'cleanup_fail'] as const) {
    const f = fixture(); const bridge = new FakeBridge(mode);
    const result = await new CursorWslWriterAdapter({ capabilities: capabilities(), bridge }).run(spec(f), () => undefined, new AbortController().signal);
    assert.equal(result.status, 'failed', mode);
    assert.ok(result.meta.terminationWarning, mode);
  }
});

test('成功路径只导入程序枚举的允许文件，prompt 经独立参数传给 bridge', async () => {
  const f = fixture(); const bridge = new FakeBridge();
  const result = await new CursorWslWriterAdapter({ capabilities: capabilities(), bridge }).run(spec(f), () => undefined, new AbortController().signal);
  assert.equal(result.status, 'succeeded');
  assert.equal(readFileSync(path.join(f.workspace, 'src.ts'), 'utf8'), 'export const value = 2;\n');
  assert.equal(readFileSync(path.join(f.workspace, 'other.ts'), 'utf8'), 'export const other = 1;\n');
  assert.deepEqual(result.toolLog.map((item) => item.paths), [['src.ts']]);
  assert.deepEqual(bridge.calls, ['probe', 'setup', 'run', 'control', 'inspect', 'cleanup']);
  assert.match(bridge.prompt, /把 value 改为 2/);
  assert.equal(JSON.stringify(bridge.request).includes('把 value 改为 2'), false);
  assert.equal(result.meta.command.some((arg) => arg.includes('把 value 改为 2')), false);
  assert.equal(result.meta.modelConfirmed, false);
});

test('Shell 或允许清单外工具事件立即关闭且绝不导入', async () => {
  for (const mode of ['shell', 'outside'] as const) {
    const f = fixture(); const bridge = new FakeBridge(mode);
    const result = await new CursorWslWriterAdapter({ capabilities: capabilities(), bridge }).run(spec(f), () => undefined, new AbortController().signal);
    assert.equal(result.status, 'failed', mode);
    assert.match(result.failure?.message ?? '', /事件违反写入契约/, mode);
    assert.equal(readFileSync(path.join(f.workspace, 'src.ts'), 'utf8'), 'export const value = 1;\n');
    assert.equal(bridge.calls.includes('inspect'), false);
    assert.equal(bridge.cleanupCalled, true);
  }
});

test('Linux 生命周期未确认时禁止枚举、导入和清理敏感目录', async () => {
  const f = fixture(); const bridge = new FakeBridge('lifecycle');
  const result = await new CursorWslWriterAdapter({ capabilities: capabilities(), bridge }).run(spec(f), () => undefined, new AbortController().signal);
  assert.equal(result.status, 'failed');
  assert.match(result.failure?.message ?? '', /终止状态未确认/);
  assert.equal(result.meta.terminationWarning !== undefined, true);
  assert.equal(bridge.calls.includes('inspect'), false);
  assert.equal(bridge.cleanupCalled, false);
  assert.equal(readFileSync(path.join(f.workspace, 'src.ts'), 'utf8'), 'export const value = 1;\n');
});

test('独立枚举拒绝新文件、删除、符号链接与策略文件漂移', async () => {
  for (const mode of ['new_file', 'delete', 'symlink', 'bad_policy'] as const) {
    const f = fixture(); const bridge = new FakeBridge(mode);
    const result = await new CursorWslWriterAdapter({ capabilities: capabilities(), bridge }).run(spec(f), () => undefined, new AbortController().signal);
    assert.equal(result.status, 'failed', mode);
    assert.equal(readFileSync(path.join(f.workspace, 'src.ts'), 'utf8'), 'export const value = 1;\n');
    assert.deepEqual(result.toolLog, []);
    assert.equal(bridge.cleanupCalled, true);
  }
});

test('运行环境或 Windows 二次锚点漂移时零导入', async () => {
  const probeFixture = fixture(); const probeBridge = new FakeBridge('probe_drift');
  const probe = await new CursorWslWriterAdapter({ capabilities: capabilities(), bridge: probeBridge }).run(spec(probeFixture), () => undefined, new AbortController().signal);
  assert.equal(probe.status, 'failed');
  assert.deepEqual(probeBridge.calls, ['probe']);

  const f = fixture(); const target = path.join(f.workspace, 'src.ts'); const driftBridge = new FakeBridge('windows_drift', target);
  const drift = await new CursorWslWriterAdapter({ capabilities: capabilities(), bridge: driftBridge }).run(spec(f), () => undefined, new AbortController().signal);
  assert.equal(drift.status, 'failed');
  assert.match(drift.failure?.message ?? '', /Windows 工作区不是 clean|内容锚点已漂移/);
  assert.equal(readFileSync(target, 'utf8'), 'external drift\n');
  assert.deepEqual(drift.toolLog, []);
});

test('非精确任务形状、危险文件与脏工作区在模型启动前关闭', async () => {
  const cases: ((base: ModelTaskSpec) => ModelTaskSpec)[] = [
    (base) => ({ ...base, model: 'grok-other' }),
    (base) => ({ ...base, sandbox: 'read_only' }),
    (base) => ({ ...base, allowWeb: true }),
    (base) => ({ ...base, resumeSessionId: 'old-session' }),
    (base) => ({ ...base, context: { ...base.context, lightRework: { ...(base.context as never as { lightRework: object }).lightRework, allowedFiles: ['.env'] } } as ModelTaskSpec['context'] }),
  ];
  for (const mutate of cases) {
    const f = fixture(); const bridge = new FakeBridge();
    const result = await new CursorWslWriterAdapter({ capabilities: capabilities(), bridge }).run(mutate(spec(f)), () => undefined, new AbortController().signal);
    assert.equal(result.status, 'failed');
    assert.equal(bridge.calls.includes('run'), false);
  }
  const f = fixture(); writeFileSync(path.join(f.workspace, 'untracked.txt'), 'dirty');
  const bridge = new FakeBridge();
  const dirty = await new CursorWslWriterAdapter({ capabilities: capabilities(), bridge }).run(spec(f), () => undefined, new AbortController().signal);
  assert.equal(dirty.status, 'failed');
  assert.equal(bridge.calls.length, 0);
});
