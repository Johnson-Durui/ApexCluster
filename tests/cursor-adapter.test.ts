import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCursorArgs,
  cursorCommandBindingMatches,
  cursorInvocationDirectory,
  cursorProfileDirectory,
  CursorAdapter,
  DEFAULT_CURSOR_OPTIONS,
  handleCursorLine,
  newCursorState,
  recordCursorVersionLifecycle,
  resolveCursorCommand,
  type CursorCapabilities,
} from '../src/adapters/cursor.js';
import type { ModelTaskSpec } from '../src/adapters/types.js';
import { emptyMeta } from '../src/adapters/types.js';
import { OUTPUT_SCHEMAS } from '../src/core/schemas.js';
import { toStrictJsonSchema } from '../src/core/strict-json-schema.js';
import { tempDir } from './helpers.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-cli', 'cursor.mjs');
const VERSION = 'cursor-agent 2026.10.0';

function capabilities(overrides: Partial<CursorCapabilities> = {}): CursorCapabilities {
  return {
    verifiedAt: '2026-10-23T00:00:00.000Z',
    cliVersion: VERSION,
    model: 'grok-4.7-high-fast',
    reportedModel: 'Grok 4.7 256K High Fast',
    toolPolicy: 'deny_all',
    commandBinding: { file: process.execPath, prefixArgs: [FIXTURE] },
    stdinPromptVerified: true,
    readOnlyToolsVerified: true,
    commandExitEventsVerified: false,
    fileChangesVerified: false,
    ...overrides,
  };
}

function spec(overrides: Partial<ModelTaskSpec> = {}): ModelTaskSpec {
  const root = tempDir();
  return {
    taskId: 't-cursor-1', runId: 'r-1', role: 'grok', phase: 'digest', attempt: 1,
    model: 'grok-4.7-high-fast', effort: 'high', prompt: '只读摘要，不得改文件',
    outputSchema: toStrictJsonSchema(OUTPUT_SCHEMAS.probe),
    cwd: path.join(root, 'task'), logDir: path.join(root, 'logs'), timeoutMs: 20_000,
    sandbox: 'read_only', allowNetwork: false, allowWeb: false, gitRepo: false,
    resumeSessionId: null,
    context: { snapshotRef: null, constraintIds: [], criterionIds: [], knownQuestionIds: [], anonymousMap: null, recheckItems: null, spec: null, mockScenario: null },
    ...overrides,
  };
}

function adapter(caps: CursorCapabilities | null = capabilities(), command = process.execPath): CursorAdapter {
  return new CursorAdapter({
    ...DEFAULT_CURSOR_OPTIONS,
    command: { command, args: command === process.execPath ? [FIXTURE] : [] },
    capabilities: caps,
  });
}

function withEnv<T>(values: Record<string, string | undefined>, callback: () => Promise<T>): Promise<T> {
  const old: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    old[key] = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  return callback().finally(() => {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

test('Cursor 参数固定且 prompt 不进 argv', () => {
  const task = spec();
  const args = buildCursorArgs(task, { ...DEFAULT_CURSOR_OPTIONS, capabilities: capabilities() });
  assert.deepEqual(args, ['--print', '--output-format', 'stream-json', '--mode', 'ask', '--trust', '--model', task.model, '--workspace', cursorInvocationDirectory(task)]);
  assert.ok(!args.some((value) => value.includes(task.prompt)));
  assert.equal(args.includes('--force'), false);
  assert.equal(args.includes('--yolo'), false);
  assert.equal(args.includes('--sandbox'), false);
  assert.throws(() => buildCursorArgs(task, { ...DEFAULT_CURSOR_OPTIONS, capabilities: capabilities(), extraArgs: ['--force'] }), /extraArgs/);
});

test('Cursor 成功：stdin、秘密移除、固定只读配置、元数据保守', async () => {
  const task = spec();
  mkdirSync(path.join(task.cwd, '.cursor'), { recursive: true });
  const sourceConfig = path.join(task.cwd, '.cursor', 'cli.json');
  writeFileSync(sourceConfig, 'source-sentinel', 'utf8');
  const argsFile = path.join(task.logDir, 'seen.json');
  const versionFile = path.join(task.cwd, 'version-env.json');
  const progress: string[] = [];
  let parentProfileDuringRun: string | undefined;
  const result = await withEnv({ FAKE_ARGS_FILE: argsFile, FAKE_VERSION_FILE: versionFile, FAKE_MODE: 'ok', CURSOR_API_KEY: 'must-not-leak', CURSOR_API_ENDPOINT: 'https://unverified.invalid', CURSOR_CONFIG_DIR: 'parent-profile' }, async () => {
    const adapterResult = await adapter().run(task, (event) => progress.push(`${event.kind}:${event.text}`), new AbortController().signal);
    parentProfileDuringRun = process.env.CURSOR_CONFIG_DIR;
    return adapterResult;
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.rawText, '{"digest":"ok"}');
  assert.equal(result.meta.processStarted, true);
  assert.equal(result.meta.cliVersion, VERSION);
  assert.equal(result.meta.reportedModelSource, 'init_event');
  assert.equal(result.meta.modelConfirmed, false);
  assert.deepEqual(result.meta.usage, { inputTokens: 12, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 0 });
  assert.equal(result.meta.costUsd, null);
  assert.ok(result.meta.scrubbedEnv.includes('CURSOR_API_KEY'));
  assert.ok(result.meta.scrubbedEnv.includes('CURSOR_API_ENDPOINT'));
  assert.ok(progress.some((text) => text.includes('Cursor 子进程已启动')));
  const seen = JSON.parse(readFileSync(argsFile, 'utf8')) as { argv: string[]; prompt: string; env: { CURSOR_API_KEY: string | null; CURSOR_API_ENDPOINT: string | null; CURSOR_CONFIG_DIR: string | null }; cwd: string };
  assert.equal(seen.prompt, task.prompt);
  assert.equal(seen.env.CURSOR_API_KEY, null);
  assert.equal(seen.env.CURSOR_API_ENDPOINT, null);
  const versionEnv = JSON.parse(readFileSync(versionFile, 'utf8')) as { CURSOR_API_KEY: string | null; CURSOR_API_ENDPOINT: string | null; CURSOR_CONFIG_DIR: string | null };
  const profilePrefix = cursorProfileDirectory(task);
  const profileDir = versionEnv.CURSOR_CONFIG_DIR!;
  assert.equal(versionEnv.CURSOR_API_KEY, null);
  assert.equal(versionEnv.CURSOR_API_ENDPOINT, null);
  assert.ok(path.resolve(profileDir).startsWith(path.resolve(profilePrefix)));
  assert.equal(path.resolve(seen.env.CURSOR_CONFIG_DIR!), path.resolve(profileDir));
  assert.equal(existsSync(profileDir), false, '调用完成后必须移除本次随机 profile');
  assert.equal(parentProfileDuringRun, 'parent-profile');
  const invocationDir = cursorInvocationDirectory(task);
  assert.deepEqual(seen.argv, ['--print', '--output-format', 'stream-json', '--mode', 'ask', '--trust', '--model', task.model, '--workspace', invocationDir]);
  assert.equal(path.resolve(seen.cwd), path.resolve(invocationDir));
  assert.equal(result.meta.cwd, invocationDir);
  assert.equal(readFileSync(sourceConfig, 'utf8'), 'source-sentinel');
  const cliConfig = JSON.parse(readFileSync(path.join(invocationDir, '.cursor', 'cli.json'), 'utf8'));
  assert.deepEqual(cliConfig.permissions.allow, []);
  assert.deepEqual(cliConfig.permissions.deny, ['Read(**)', 'Write(**)', 'Shell(*)', 'WebFetch(*)', 'Mcp(*:*)']);
  const profile = JSON.parse(readFileSync(path.join(task.logDir, 'cursor-policy.json'), 'utf8'));
  assert.deepEqual(profile, {
    version: 1,
    editor: { vimMode: false },
    autoAcceptWebSearch: false,
    permissions: cliConfig.permissions,
  });
});

test('Cursor 能力未证时零推理；版本或型号记录不符也关闭', async () => {
  const task = spec();
  const argsFile = path.join(task.logDir, 'must-not-exist.json');
  const missing = await withEnv({ FAKE_ARGS_FILE: argsFile }, () => adapter(null).run(task, () => undefined, new AbortController().signal));
  assert.equal(missing.failure?.kind, 'unknown');
  assert.equal(missing.meta.processStarted, false);
  assert.equal(existsSync(argsFile), false);

  const wrongModel = await adapter(capabilities({ model: 'some-other-model' })).run(task, () => undefined, new AbortController().signal);
  assert.equal(wrongModel.failure?.kind, 'model_unavailable');
  assert.equal(wrongModel.meta.processStarted, false);

  for (const legacy of [
    capabilities({ reportedModel: null }),
    capabilities({ toolPolicy: null }),
    capabilities({ reportedModel: '   ' }),
    capabilities({ commandBinding: null }),
    (() => { const { reportedModel: _omitted, ...rest } = capabilities(); return rest as CursorCapabilities; })(),
    (() => { const { toolPolicy: _omitted, ...rest } = capabilities(); return rest as CursorCapabilities; })(),
    (() => { const { commandBinding: _omitted, ...rest } = capabilities(); return rest as CursorCapabilities; })(),
  ]) {
    const stale = await adapter(legacy).run(task, () => undefined, new AbortController().signal);
    assert.equal(stale.status, 'failed');
    assert.equal(stale.meta.processStarted, false);
  }

  const wrongVersion = await withEnv({ FAKE_CURSOR_VERSION: 'cursor-agent changed' }, () => adapter().run(task, () => undefined, new AbortController().signal));
  assert.equal(wrongVersion.failure?.kind, 'unknown');
  assert.equal(wrongVersion.meta.processStarted, false);
  assert.match(wrongVersion.failure?.message ?? '', /版本已变化/);
});

test('Cursor 不把同名 Grok Build CLI 当作 Cursor，即使能力记录版本相同也不启动推理', async () => {
  const task = spec();
  const argsFile = path.join(task.logDir, 'must-not-start.json');
  const version = 'grok 1.0.0 (3cd0d0cbce)';
  const result = await withEnv({ FAKE_CURSOR_VERSION: version, FAKE_ARGS_FILE: argsFile }, () =>
    adapter(capabilities({ cliVersion: version })).run(task, () => undefined, new AbortController().signal));
  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.kind, 'not_installed');
  assert.match(result.failure?.message ?? '', /Grok Build CLI.*并非 Cursor Agent/);
  assert.equal(result.meta.processStarted, false);
  assert.equal(existsSync(argsFile), false);
});

test('Cursor 命令优先采用 cursor-agent，显式路径仍优先且不回退', () => {
  const dir = tempDir();
  const suffix = process.platform === 'win32' ? '.exe' : '';
  for (const name of ['agent', 'cursor-agent']) writeFileSync(path.join(dir, `${name}${suffix}`), 'resolver-only fixture');
  const env = { PATH: dir };
  assert.equal(resolveCursorCommand(null, env)?.file, path.join(dir, `cursor-agent${suffix}`));
  const explicit = path.join(dir, `configured${suffix}`);
  assert.equal(resolveCursorCommand({ command: explicit }, env)?.file, explicit);
});

test('Cursor H7 命令绑定只接受精确绝对二进制或唯一 JS 入口', () => {
  const nativeEntry = path.resolve('fixtures/cursor-agent/versions/test/index.js');
  assert.equal(cursorCommandBindingMatches(
    { file: process.execPath, prefixArgs: [nativeEntry], via: 'config' },
    capabilities({ commandBinding: { file: process.execPath, prefixArgs: [nativeEntry] } }),
  ), true);
  assert.equal(cursorCommandBindingMatches(
    { file: process.execPath, prefixArgs: [FIXTURE], via: 'config' },
    capabilities(),
  ), true);
  assert.equal(cursorCommandBindingMatches(
    { file: path.resolve('cursor-agent.exe'), prefixArgs: [], via: 'direct' },
    capabilities({ commandBinding: { file: path.resolve('cursor-agent.exe'), prefixArgs: [] } }),
  ), true);
  for (const prefixArgs of [
    ['--force'], ['--approve-mcps'], ['--plugin-dir', path.resolve('plugin')],
    ['--endpoint', 'https://untrusted.invalid'], ['agent'], ['relative/index.js'],
    [FIXTURE, '--force'],
  ]) {
    assert.equal(cursorCommandBindingMatches(
      { file: process.execPath, prefixArgs, via: 'config' },
      capabilities({ commandBinding: { file: process.execPath, prefixArgs } }),
    ), false, prefixArgs.join(' '));
  }
  assert.equal(cursorCommandBindingMatches(
    { file: 'relative-node', prefixArgs: [FIXTURE], via: 'config' },
    capabilities({ commandBinding: { file: 'relative-node', prefixArgs: [FIXTURE] } }),
  ), false);
});

test('Cursor 危险或相对入口绑定在版本查询前关闭', async () => {
  for (const prefixArgs of [['--force'], ['--approve-mcps'], ['--plugin-dir'], ['--endpoint'], ['agent'], ['relative.mjs'], [FIXTURE, '--force']]) {
    const task = spec();
    const versionFile = path.join(task.logDir, 'must-not-version.json');
    const argsFile = path.join(task.logDir, 'must-not-infer.json');
    const guarded = new CursorAdapter({
      ...DEFAULT_CURSOR_OPTIONS,
      command: { command: process.execPath, args: prefixArgs },
      capabilities: capabilities({ commandBinding: { file: process.execPath, prefixArgs } }),
    });
    const result = await withEnv({ FAKE_VERSION_FILE: versionFile, FAKE_ARGS_FILE: argsFile }, () =>
      guarded.run(task, () => undefined, new AbortController().signal));
    assert.equal(result.status, 'failed', prefixArgs.join(' '));
    assert.equal(result.meta.processStarted, false, prefixArgs.join(' '));
    assert.equal(existsSync(versionFile), false, prefixArgs.join(' '));
    assert.equal(existsSync(argsFile), false, prefixArgs.join(' '));
  }
});

test('Cursor 拒绝写任务、未允许阶段和未验证stdin', async () => {
  const writable = await adapter().run(spec({ sandbox: 'workspace_write' }), () => undefined, new AbortController().signal);
  assert.equal(writable.failure?.kind, 'unknown');
  assert.equal(writable.meta.processStarted, false);
  const build = await adapter().run(spec({ phase: 'build' }), () => undefined, new AbortController().signal);
  assert.equal(build.failure?.kind, 'unknown');
  assert.equal(build.meta.processStarted, false);
  const noStdin = await adapter(capabilities({ stdinPromptVerified: false })).run(spec(), () => undefined, new AbortController().signal);
  assert.equal(noStdin.failure?.kind, 'unknown');
  assert.equal(noStdin.meta.processStarted, false);
  const wrongEffort = await adapter().run(spec({ effort: 'ultra' }), () => undefined, new AbortController().signal);
  assert.equal(wrongEffort.failure?.kind, 'unknown');
  assert.equal(wrongEffort.meta.processStarted, false);
  assert.match(wrongEffort.failure?.message ?? '', /effort=high/);
});

test('Cursor 启动失败与 auth 失败分类，已启动进程计数准确', async () => {
  const missingCommand = path.join(tempDir(), 'missing-agent');
  const missing = await adapter(capabilities({ commandBinding: { file: missingCommand, prefixArgs: [] } }), missingCommand).run(spec(), () => undefined, new AbortController().signal);
  assert.equal(missing.failure?.kind, 'not_installed');
  assert.equal(missing.meta.processStarted, false);
  const auth = await withEnv({ FAKE_MODE: 'auth' }, () => adapter().run(spec(), () => undefined, new AbortController().signal));
  assert.equal(auth.failure?.kind, 'auth_failed');
  assert.equal(auth.meta.processStarted, true);
});

test('Cursor 未知事件不猜 usage；非法 usage 保守丢弃；缺 terminal result 失败', async () => {
  const unknown = await withEnv({ FAKE_MODE: 'unknown' }, () => adapter().run(spec(), () => undefined, new AbortController().signal));
  assert.equal(unknown.status, 'succeeded');
  assert.deepEqual(unknown.meta.usage, { inputTokens: 12, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 0 });
  const invalidUsage = await withEnv({ FAKE_MODE: 'invalid_usage' }, () => adapter().run(spec(), () => undefined, new AbortController().signal));
  assert.equal(invalidUsage.status, 'succeeded');
  assert.equal(invalidUsage.meta.usage, null);
  assert.ok(invalidUsage.meta.warnings.some((warning) => /usage/.test(warning)));
  const missingTerminal = await withEnv({ FAKE_MODE: 'no_terminal' }, () => adapter().run(spec(), () => undefined, new AbortController().signal));
  assert.equal(missingTerminal.failure?.kind, 'unknown');
  assert.match(missingTerminal.failure?.message ?? '', /terminal result/);
});

test('Cursor 任何工具、init cwd 漂移、会话串线和冲突终态全部 fail closed', async () => {
  for (const [mode, expected] of [
    ['read', /tool_call:read/],
    ['edit', /tool_call:edit/],
    ['unknown_tool', /tool_call:unknown_tool/],
    ['cwd_mismatch', /init_cwd_mismatch/],
    ['missing_cwd', /init_cwd_missing/],
    ['session_mismatch', /session_mismatch/],
    ['duplicate_result', /duplicate_result/],
    ['error_conflict', /result_success_is_error/],
    ['missing_is_error', /result_success_is_error/],
    ['string_is_error', /result_success_is_error/],
    ['missing_init_session', /session_id/],
    ['missing_result_session', /session_id/],
  ] as const) {
    const result = await withEnv({ FAKE_MODE: mode }, () => adapter().run(spec(), () => undefined, new AbortController().signal));
    assert.equal(result.status, 'failed', mode);
    assert.match(result.failure?.message ?? '', expected, mode);
  }
});

test('Cursor 受控权限配置不覆盖既有文件，版本进程树未知状态会向上传递', async () => {
  const task = spec();
  const controlledConfig = path.join(cursorInvocationDirectory(task), '.cursor', 'cli.json');
  mkdirSync(path.dirname(controlledConfig), { recursive: true });
  writeFileSync(controlledConfig, 'controlled-sentinel', 'utf8');
  const result = await adapter().run(task, () => undefined, new AbortController().signal);
  assert.equal(result.status, 'failed');
  assert.equal(result.meta.processStarted, false);
  assert.equal(readFileSync(controlledConfig, 'utf8'), 'controlled-sentinel');

  const meta = emptyMeta('cursor', task, '2026-10-23T00:00:00.000Z');
  recordCursorVersionLifecycle(meta, { durationMs: 123, terminationWarning: '版本进程树退出未知' });
  assert.equal(meta.processStarted, false, '版本检测不能计作模型推理启动');
  assert.equal(meta.durationMs, 123);
  assert.equal(meta.terminationWarning, '版本进程树退出未知');
  assert.ok(meta.warnings.includes('版本进程树退出未知'));
});

test('Cursor 已保留的非敏感策略摘要漂移时在版本查询和模型推理前关闭', async () => {
  const task = spec();
  const policyFile = path.join(task.logDir, 'cursor-policy.json');
  mkdirSync(path.dirname(policyFile), { recursive: true });
  writeFileSync(policyFile, 'policy-sentinel', 'utf8');
  const argsFile = path.join(task.logDir, 'must-not-start.json');
  const versionFile = path.join(task.logDir, 'must-not-version.json');
  const result = await withEnv({ FAKE_ARGS_FILE: argsFile, FAKE_VERSION_FILE: versionFile }, () =>
    adapter().run(task, () => undefined, new AbortController().signal));
  assert.equal(result.status, 'failed');
  assert.equal(result.meta.processStarted, false);
  assert.match(result.failure?.message ?? '', /临时受控 profile/);
  assert.equal(readFileSync(policyFile, 'utf8'), 'policy-sentinel');
  assert.deepEqual(readdirSync(task.logDir).filter((name) => name.startsWith('cursor-profile-')), []);
  assert.equal(existsSync(argsFile), false);
  assert.equal(existsSync(versionFile), false);
});

test('Cursor 版本检测超时不会记作模型推理启动', async () => {
  const guardedTask = spec();
  const guarded = new CursorAdapter({
    ...DEFAULT_CURSOR_OPTIONS,
    command: { command: process.execPath, args: [FIXTURE] },
    capabilities: capabilities(),
    versionTimeoutMs: 30,
  });
  const result = await withEnv({ FAKE_VERSION_HANG: '1' }, () => guarded.run(guardedTask, () => undefined, new AbortController().signal));
  assert.equal(result.status, 'timed_out');
  assert.equal(result.failure?.kind, 'timeout');
  assert.equal(result.meta.processStarted, false);
  assert.ok(result.meta.durationMs >= 0);
  const retainedProfiles = readdirSync(path.dirname(cursorProfileDirectory(guardedTask))).filter((name) => name.startsWith('cursor-profile-'));
  assert.equal(retainedProfiles.length, result.meta.terminationWarning ? 1 : 0, '只有进程树终止状态未确认时才保留随机 profile');
});

test('Cursor 同一受控目录只复用完全相同的权限文件，支持同任务结构修复再次调用', async () => {
  const task = spec();
  const firstSeen = path.join(task.logDir, 'first-seen.json');
  const secondSeen = path.join(task.logDir, 'second-seen.json');
  const first = await withEnv({ FAKE_ARGS_FILE: firstSeen }, () => adapter().run(task, () => undefined, new AbortController().signal));
  const second = await withEnv({ FAKE_ARGS_FILE: secondSeen }, () => adapter().run(task, () => undefined, new AbortController().signal));
  assert.equal(first.status, 'succeeded');
  assert.equal(second.status, 'succeeded');
  const firstProfile = JSON.parse(readFileSync(firstSeen, 'utf8')).env.CURSOR_CONFIG_DIR as string;
  const secondProfile = JSON.parse(readFileSync(secondSeen, 'utf8')).env.CURSOR_CONFIG_DIR as string;
  assert.notEqual(firstProfile, secondProfile);
  assert.equal(existsSync(firstProfile), false);
  assert.equal(existsSync(secondProfile), false);
  assert.deepEqual(readdirSync(task.logDir).filter((name) => name.startsWith('cursor-profile-')), []);
});

test('Cursor 成功或失败后均清理 CLI 写入的伪账户与缓存文件', async () => {
  for (const mode of ['ok', 'auth']) {
    const task = spec();
    const versionFile = path.join(task.logDir, 'version-profile.json');
    const seenFile = path.join(task.logDir, 'seen-profile.json');
    const result = await withEnv({ FAKE_MODE: mode, FAKE_VERSION_FILE: versionFile, FAKE_ARGS_FILE: seenFile }, () =>
      adapter().run(task, () => undefined, new AbortController().signal));
    const observed = JSON.parse(readFileSync(versionFile, 'utf8')).CURSOR_CONFIG_DIR as string;
    assert.equal(existsSync(observed), false, mode);
    assert.deepEqual(readdirSync(task.logDir).filter((name) => name.startsWith('cursor-profile-')), [], mode);
    assert.equal(JSON.stringify(result).includes('fixture@example.invalid'), false, mode);
    assert.equal(JSON.stringify(result).includes('fixture-secret'), false, mode);
  }
});

test('Cursor 事件流出现写工具即使进程成功也判只读调用无效', async () => {
  const result = await withEnv({ FAKE_MODE: 'write' }, () => adapter().run(spec(), () => undefined, new AbortController().signal));
  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.kind, 'process_error');
  assert.match(result.failure?.message ?? '', /write/);
  assert.deepEqual(result.toolLog.map((item) => [item.type, item.exitCode]), [['file_change', null]]);
});

test('Cursor 收到禁止工具事件后立即终止进程且不冒充用户取消', async () => {
  const result = await withEnv({ FAKE_MODE: 'tool_hang' }, () =>
    adapter().run(spec(), () => undefined, new AbortController().signal));
  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.kind, 'process_error');
  assert.match(result.failure?.message ?? '', /tool_call:read/);
  assert.ok(result.meta.durationMs < 10_000, `禁止工具后应提前终止，实际 ${result.meta.durationMs}ms`);
});

test('Cursor init 显示名必须与 H7 能力记录精确一致，缺名也失败', async () => {
  const mismatch = await withEnv({ FAKE_MODE: 'mismatch' }, () => adapter().run(spec(), () => undefined, new AbortController().signal));
  assert.equal(mismatch.failure?.kind, 'model_mismatch');
  assert.match(mismatch.failure?.message ?? '', /显示名/);
  const missing = await withEnv({ FAKE_MODE: 'missing_model' }, () => adapter().run(spec(), () => undefined, new AbortController().signal));
  assert.equal(missing.status, 'failed');
  assert.match(missing.failure?.message ?? '', /缺少 system\/init 型号记录/);
});

test('Cursor stream parser 不从未知字段推测出口码或用量', () => {
  const state = newCursorState();
  assert.equal(handleCursorLine('{"type":"future","exit_code":0,"usage":{"tokens":1}}', state), null);
  assert.equal(state.result, null);
  assert.deepEqual(state.toolLog, []);
});
