import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildClaudeArgs, ClaudeCodeAdapter, DEFAULT_CLAUDE_OPTIONS, useNativeSchema } from '../src/adapters/claude-code.js';
import { buildCodexArgs, CodexAdapter, DEFAULT_CODEX_OPTIONS } from '../src/adapters/codex.js';
import { MockAdapter } from '../src/adapters/mock.js';
import type { ModelTaskSpec } from '../src/adapters/types.js';
import { OUTPUT_SCHEMAS } from '../src/core/schemas.js';
import { toStrictJsonSchema } from '../src/core/strict-json-schema.js';
import { tempDir } from './helpers.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-cli');

function spec(over: Partial<ModelTaskSpec> = {}): ModelTaskSpec {
  const dir = tempDir();
  return {
    taskId: 't-1',
    runId: 'r-1',
    role: 'claude',
    phase: 'probe',
    attempt: 1,
    model: 'claude-opus-5-5',
    effort: 'max',
    prompt: '请只输出 JSON：探测',
    outputSchema: toStrictJsonSchema(OUTPUT_SCHEMAS.probe),
    cwd: path.join(dir, 'cwd'),
    logDir: dir,
    timeoutMs: 20_000,
    sandbox: 'read_only',
    allowNetwork: false,
    allowWeb: true,
    gitRepo: false,
    resumeSessionId: null,
    context: { snapshotRef: null, constraintIds: [], criterionIds: [], knownQuestionIds: [], anonymousMap: null, recheckItems: null, spec: null, mockScenario: null },
    ...over,
  };
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const old: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    old[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

const claudeAdapter = () => new ClaudeCodeAdapter({ ...DEFAULT_CLAUDE_OPTIONS, command: { command: process.execPath, args: [path.join(FAKE, 'fake-claude.mjs')] } });
const codexAdapter = () => new CodexAdapter({ ...DEFAULT_CODEX_OPTIONS, command: { command: process.execPath, args: [path.join(FAKE, 'fake-codex.mjs')] } });

// ------------------------------------------------------------------ Claude Code
test('Claude 参数：完整型号 ID、显式 max、stream-json、隔离个人定制、只读联网工具、禁止换型号', () => {
  const s = spec();
  const args = buildClaudeArgs(s, DEFAULT_CLAUDE_OPTIONS, '/tmp/settings.json', '{"type":"object"}');
  const at = (k: string) => args[args.indexOf(k) + 1];
  assert.equal(args[0], '-p');
  assert.equal(at('--output-format'), 'stream-json');
  assert.equal(at('--model'), 'claude-opus-5-5');
  assert.equal(at('--effort'), 'max');
  assert.equal(at('--json-schema'), '{"type":"object"}');
  assert.ok(args.includes('--safe-mode'));
  assert.equal(at('--tools'), 'WebSearch,WebFetch');
  assert.equal(at('--disallowedTools'), 'mcp__*');
  assert.equal(at('--permission-mode'), 'dontAsk');
  assert.equal(at('--settings'), '/tmp/settings.json');
  assert.ok(!args.includes('--fallback-model'));
  assert.ok(!args.includes('--bare')); // --bare 不读订阅登录
  // 提示词不在命令行里
  assert.ok(!args.some((a) => a.includes('探测')));
  const noWeb = buildClaudeArgs(spec({ allowWeb: false }), DEFAULT_CLAUDE_OPTIONS, 's', null);
  assert.equal(noWeb[noWeb.indexOf('--tools') + 1], '');
  assert.ok(!noWeb.includes('--json-schema'));
});

test('Claude 文档任务不开放文件、命令、联网或 MCP 工具，即使携带参考资料目录', () => {
  const s = spec({ phase: 'handbook', referenceDirectory: 'C:\\isolated\\.workbench-references' });
  const args = buildClaudeArgs(s, DEFAULT_CLAUDE_OPTIONS, 'settings.json', null);
  assert.equal(args[args.indexOf('--tools') + 1], '');
  const blocked = args[args.indexOf('--disallowedTools') + 1]!;
  for (const tool of ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write', 'WebSearch', 'WebFetch', 'mcp__*']) assert.match(blocked, new RegExp(tool.replace('*', '\\*')));
  assert.ok(!args.includes('--restricted'), '文档任务不应切换到参考资料目录');
});

test('Claude 参考附件：restricted 模式只开放文件读取与可选联网工具，显式禁止命令、编辑和 MCP', () => {
  const referenceDirectory = path.join(path.resolve('/tmp/task'), '.workbench-references');
  const withWeb = buildClaudeArgs(spec({ referenceDirectory }), DEFAULT_CLAUDE_OPTIONS, 's', null);
  const at = (args: string[], key: string) => args[args.indexOf(key) + 1];
  assert.ok(withWeb.includes('--restricted'));
  assert.ok(withWeb.includes('--strict-mcp-config'));
  assert.equal(at(withWeb, '--tools'), 'Read,Glob,Grep,WebSearch,WebFetch');
  assert.equal(at(withWeb, '--disallowedTools'), 'Bash,PowerShell,REPL,Edit,Write,NotebookEdit,mcp__*');
  assert.ok(withWeb.includes('--safe-mode'));
  assert.equal(at(withWeb, '--permission-mode'), 'dontAsk');
  assert.equal(at(withWeb, '--permission-prompts'), 'none');
  assert.ok(!withWeb.includes('--fallback-model'));

  const offline = buildClaudeArgs(spec({ referenceDirectory, allowWeb: false }), DEFAULT_CLAUDE_OPTIONS, 's', null);
  assert.equal(at(offline, '--tools'), 'Read,Glob,Grep');

  const withoutReferences = buildClaudeArgs(spec(), DEFAULT_CLAUDE_OPTIONS, 's', null);
  assert.ok(!withoutReferences.includes('--restricted'));
  assert.ok(!withoutReferences.includes('--strict-mcp-config'));
  assert.equal(at(withoutReferences, '--tools'), 'WebSearch,WebFetch');
  assert.equal(at(withoutReferences, '--disallowedTools'), 'mcp__*');
});

test('Claude 参考附件：子进程工作目录收窄到专用参考目录', async () => {
  const s = spec();
  const referenceDirectory = path.join(s.cwd, '.workbench-references');
  mkdirSync(referenceDirectory, { recursive: true });
  writeFileSync(path.join(referenceDirectory, 'original.zip'), 'fake archive bytes');
  const argsFile = path.join(s.logDir, 'args.json');
  const result = await withEnv({ FAKE_MODE: 'ok', FAKE_ARGS_FILE: argsFile }, () =>
    claudeAdapter().run({ ...s, referenceDirectory }, () => undefined, new AbortController().signal),
  );
  assert.equal(result.status, 'succeeded');
  const seen = JSON.parse(readFileSync(argsFile, 'utf8')) as { cwd: string; argv: string[]; prompt: string };
  assert.equal(path.resolve(seen.cwd), path.resolve(referenceDirectory));
  assert.equal(path.resolve(result.meta.cwd), path.resolve(referenceDirectory));
  assert.equal(seen.argv[seen.argv.indexOf('--tools') + 1], 'Read,Glob,Grep,WebSearch,WebFetch');
  assert.equal(seen.prompt, s.prompt);
});

test('Claude 参考附件：拒绝相对路径、工作目录外路径及写入任务', async () => {
  const relative = await claudeAdapter().run(
    spec({ referenceDirectory: '.workbench-references' }),
    () => undefined,
    new AbortController().signal,
  );
  assert.equal(relative.failure?.kind, 'process_error');
  assert.match(relative.failure?.message ?? '', /绝对路径/);

  const outsideSpec = spec();
  const outside = path.join(tempDir(), '.workbench-references');
  mkdirSync(outside, { recursive: true });
  const escaped = await claudeAdapter().run(
    { ...outsideSpec, referenceDirectory: outside },
    () => undefined,
    new AbortController().signal,
  );
  assert.equal(escaped.failure?.kind, 'process_error');
  assert.match(escaped.failure?.message ?? '', /任务工作目录/);

  const writeSpec = spec({ sandbox: 'workspace_write' });
  const referenceDirectory = path.join(writeSpec.cwd, '.workbench-references');
  mkdirSync(referenceDirectory, { recursive: true });
  const writable = await claudeAdapter().run(
    { ...writeSpec, referenceDirectory },
    () => undefined,
    new AbortController().signal,
  );
  assert.equal(writable.failure?.kind, 'process_error');
  assert.match(writable.failure?.message ?? '', /只读设计任务/);
});

test('经 .cmd 垫片调用时自动关闭 --json-schema', () => {
  assert.equal(useNativeSchema({ file: 'C:\\npm\\claude.cmd', prefixArgs: [], via: 'cmd-fallback' }, '{}', 'auto'), false);
  assert.equal(useNativeSchema({ file: 'C:\\x\\claude.exe', prefixArgs: [], via: 'direct' }, '{}', 'auto'), true);
  assert.equal(useNativeSchema({ file: 'C:\\x\\claude.exe', prefixArgs: [], via: 'direct' }, 'x'.repeat(30_000), 'auto'), false);
});

test('Claude 成功：取 structured_output；用服务端用量确认型号；移除 API key 环境变量', async () => {
  const s = spec();
  const argsFile = path.join(s.logDir, 'args.json');
  const r = await withEnv({ FAKE_MODE: 'ok', FAKE_ARGS_FILE: argsFile, ANTHROPIC_API_KEY: 'sk-should-not-leak', DMW_EXA_API_KEY: 'dummy-canary-never-a-real-key' }, () => claudeAdapter().run(s, () => undefined, new AbortController().signal));
  assert.equal(r.status, 'succeeded');
  assert.equal(r.meta.processStarted, true);
  assert.deepEqual(r.structured, { ok: true, note: '探测成功' });
  assert.equal(r.meta.modelConfirmed, true);
  assert.equal(r.meta.reportedModelSource, 'server_usage');
  assert.ok(r.meta.reportedModels.includes('claude-opus-5-5-20260922'));
  assert.equal(r.meta.sessionId, '11111111-2222-3333-4444-555555555555');
  assert.equal(r.meta.cliVersion, '2.1.294');
  assert.ok(r.meta.scrubbedEnv.includes('ANTHROPIC_API_KEY'));
  assert.ok(!r.meta.warnings.some((w) => w.includes('凭证来源')));
  const seen = JSON.parse(readFileSync(argsFile, 'utf8'));
  assert.equal(seen.env.ANTHROPIC_API_KEY, null);
  assert.equal(seen.env.DMW_EXA_API_KEY, undefined);
  assert.ok(r.meta.scrubbedEnv.includes('DMW_EXA_API_KEY'));
  assert.equal(seen.prompt, '请只输出 JSON：探测');
  assert.ok(r.meta.warnings.some((w) => w.includes('多个型号')));
});

test('Claude 凭证来源不是订阅登录时给出计费警告', async () => {
  const r = await withEnv({ FAKE_MODE: 'ok', FAKE_API_KEY_SOURCE: 'ANTHROPIC_API_KEY' }, () => claudeAdapter().run(spec(), () => undefined, new AbortController().signal));
  assert.ok(r.meta.warnings.some((w) => w.includes('按 API 计费')));
});

test('Claude 型号不符：服务端用量里没有请求的型号 → modelConfirmed=false（编排器据此判定 model_mismatch）', async () => {
  const r = await withEnv({ FAKE_MODE: 'mismatch' }, () => claudeAdapter().run(spec(), () => undefined, new AbortController().signal));
  assert.equal(r.status, 'succeeded');
  assert.equal(r.meta.modelConfirmed, false);
  assert.ok(r.meta.reportedModels.includes('claude-opus-4-8'));
});

test('Claude 未登录 / 型号不可用 / 参数不认识：分别归类', async () => {
  const a = await withEnv({ FAKE_MODE: 'auth' }, () => claudeAdapter().run(spec(), () => undefined, new AbortController().signal));
  assert.equal(a.failure?.kind, 'not_logged_in');
  assert.equal(a.meta.processStarted, true, 'CLI 已启动后报告登录失败，仍应计为已启动');
  const m = await withEnv({ FAKE_MODE: 'model' }, () => claudeAdapter().run(spec(), () => undefined, new AbortController().signal));
  assert.equal(m.failure?.kind, 'model_unavailable');
  const u = await withEnv({ FAKE_MODE: 'unknown_flag' }, () => claudeAdapter().run(spec(), () => undefined, new AbortController().signal));
  assert.equal(u.failure?.kind, 'process_error');
  assert.ok(u.failure?.message.includes('版本'));
});

test('Claude 额度用完：归类为 rate_limited，并把 CLI 原话（含恢复时间）带给界面', async () => {
  const r = await withEnv({ FAKE_MODE: 'limit' }, () => claudeAdapter().run(spec(), () => undefined, new AbortController().signal));
  assert.equal(r.failure?.kind, 'rate_limited');
  assert.ok(r.failure?.message.includes('resets 5pm'));
});

test('Claude：别名与不支持的强度在调用前就拒绝（不静默降级）', async () => {
  const a = await claudeAdapter().run(spec({ model: 'opus' }), () => undefined, new AbortController().signal);
  assert.equal(a.failure?.kind, 'model_unavailable');
  const e = await claudeAdapter().run(spec({ effort: 'ultra' }), () => undefined, new AbortController().signal);
  assert.equal(e.failure?.kind, 'effort_unsupported');
});

test('Claude 超时与取消', async () => {
  const t = await withEnv({ FAKE_MODE: 'slow' }, () => claudeAdapter().run(spec({ timeoutMs: 700 }), () => undefined, new AbortController().signal));
  assert.equal(t.status, 'timed_out');
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  const c = await withEnv({ FAKE_MODE: 'slow' }, () => claudeAdapter().run(spec(), () => undefined, ac.signal));
  assert.equal(c.status, 'cancelled');
});

test('Claude 进度事件：工具调用会转成可读进度', async () => {
  const progress: string[] = [];
  await withEnv({ FAKE_MODE: 'ok' }, () => claudeAdapter().run(spec(), (p) => progress.push(p.text), new AbortController().signal));
  assert.ok(progress.some((p) => p.includes('子进程已启动（PID')));
  assert.ok(progress.some((p) => p.includes('调用 WebSearch')));
  assert.ok(progress.some((p) => p.includes('会话已启动')));
});

test('Claude 推理数字心跳：只显示有限非负 token 估计，不泄露事件文本', async () => {
  const progress: { kind: string; text: string }[] = [];
  await withEnv({ FAKE_MODE: 'heartbeat' }, () =>
    claudeAdapter().run(spec(), (p) => progress.push({ kind: p.kind, text: p.text }), new AbortController().signal),
  );
  const heartbeats = progress.filter((p) => p.text.includes('估计已生成'));
  assert.deepEqual(heartbeats, [{ kind: 'info', text: '推理中（估计已生成 47 tokens，非最终用量）' }]);
  assert.ok(progress.every((p) => !p.text.includes('绝不能显示') && !p.text.includes('字符串数字') && !p.text.includes('负数')));
});

// ------------------------------------------------------------------ Codex
test('Codex 参数：exec --json、型号、强度、只读沙箱、--search 放在 exec 之前、schema 文件、最终消息文件、stdin 提示词', () => {
  const args = buildCodexArgs(spec({ role: 'astra', model: 'gpt-6.2-astra' }), DEFAULT_CODEX_OPTIONS, '/s.json', '/o.txt');
  assert.deepEqual(args.slice(0, 2), ['--search', 'exec']);
  assert.ok(args.includes('--json'));
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-6.2-astra');
  assert.ok(args.includes('model_reasoning_effort=max'));
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(args.includes('--skip-git-repo-check'));
  assert.equal(args[args.indexOf('--output-schema') + 1], '/s.json');
  assert.equal(args[args.indexOf('-o') + 1], '/o.txt');
  assert.equal(args.at(-1), '-');
  const build = buildCodexArgs(spec({ role: 'sol', model: 'gpt-6.2-sol', effort: 'ultra', sandbox: 'workspace_write', allowNetwork: true, allowWeb: false, gitRepo: true }), DEFAULT_CODEX_OPTIONS, '/s', '/o');
  assert.equal(build[0], 'exec');
  assert.ok(build.includes('model_reasoning_effort=ultra'));
  assert.equal(build[build.indexOf('--sandbox') + 1], 'workspace-write');
  assert.ok(build.includes('sandbox_workspace_write.network_access=true'));
  assert.ok(!build.includes('--skip-git-repo-check'));
  const offlineBuild = buildCodexArgs(spec({ role: 'sol', sandbox: 'workspace_write', allowNetwork: false }), DEFAULT_CODEX_OPTIONS, '/s', '/o');
  assert.equal(offlineBuild[offlineBuild.indexOf('--sandbox') + 1], 'workspace-write');
  assert.ok(offlineBuild.includes('sandbox_workspace_write.network_access=false'));
  const resume = buildCodexArgs(spec({ resumeSessionId: 'thread-abc' }), DEFAULT_CODEX_OPTIONS, '/s', '/o');
  assert.deepEqual(resume.slice(-3), ['resume', 'thread-abc', '-']);
});

test('Codex 成功：隔离宿主注册标志和 API 计费变量；父环境不变；读取输出与工具日志', async () => {
  const s = spec({ role: 'sol', model: 'gpt-6.2-sol', phase: 'probe', sandbox: 'workspace_write', allowWeb: false });
  const argsFile = path.join(s.logDir, 'args.json');
  const r = await withEnv({ FAKE_MODE: 'ok', FAKE_ARGS_FILE: argsFile, OPENAI_API_KEY: 'sk-no', DMW_EXA_API_KEY: 'dummy-canary-never-a-real-key', CODEX_WINDOWS_REGISTERED_CORE: '1' }, async () => {
    const result = await codexAdapter().run(s, () => undefined, new AbortController().signal);
    assert.equal(process.env.CODEX_WINDOWS_REGISTERED_CORE, '1');
    return result;
  });
  assert.equal(r.status, 'succeeded');
  assert.equal(r.meta.processStarted, true);
  assert.deepEqual(JSON.parse(r.rawText!), { ok: true, note: '探测成功' });
  assert.equal(r.meta.sessionId, 'thread-abc');
  assert.deepEqual(r.meta.reportedModels, ['gpt-6.2-sol']);
  assert.equal(r.meta.reportedModelSource, 'cli_config');
  assert.equal(r.meta.modelConfirmed, false);
  assert.equal(r.meta.reportedEffort, 'max');
  assert.equal(r.meta.usage?.reasoning_output_tokens, 300);
  assert.deepEqual(
    r.toolLog.map((x) => [x.type, x.exitCode]),
    [
      ['file_change', null],
      ['command_execution', 0],
    ],
  );
  const seen = JSON.parse(readFileSync(argsFile, 'utf8'));
  assert.equal(seen.env.OPENAI_API_KEY, null);
  assert.equal(seen.env.DMW_EXA_API_KEY, undefined);
  assert.equal(seen.env.CODEX_WINDOWS_REGISTERED_CORE, null);
  assert.ok(r.meta.scrubbedEnv.includes('CODEX_WINDOWS_REGISTERED_CORE'));
  assert.ok(r.meta.warnings.some((warning) => warning.includes('宿主进程标志') && warning.includes('API 计费变量')));
});

test('Codex 失败归类：型号不可用 / 强度不支持 / 未登录', async () => {
  const m = await withEnv({ FAKE_MODE: 'model' }, () => codexAdapter().run(spec({ role: 'astra', model: 'gpt-6.2-astra' }), () => undefined, new AbortController().signal));
  assert.equal(m.failure?.kind, 'model_unavailable');
  const e = await withEnv({ FAKE_MODE: 'effort' }, () => codexAdapter().run(spec({ role: 'sol', model: 'gpt-6.2-sol', effort: 'ultra' }), () => undefined, new AbortController().signal));
  assert.equal(e.failure?.kind, 'effort_unsupported');
  const a = await withEnv({ FAKE_MODE: 'auth' }, () => codexAdapter().run(spec({ role: 'astra' }), () => undefined, new AbortController().signal));
  assert.equal(a.failure?.kind, 'not_logged_in');
  assert.equal(a.meta.processStarted, true, 'CLI 已启动后报告登录失败，仍应计为已启动');
});

test('找不到 CLI → not_installed（给出安装提示）', async () => {
  const ad = new ClaudeCodeAdapter({ ...DEFAULT_CLAUDE_OPTIONS, command: { command: path.join(tempDir(), 'missing-claude') } });
  const r = await ad.run(spec(), () => undefined, new AbortController().signal);
  assert.equal(r.failure?.kind, 'not_installed');
  assert.equal(r.meta.processStarted, false);
  writeFileSync(path.join(tempDir(), 'x'), '');
});

test('Mock 成功结果明确记录已开始', async () => {
  const progress: string[] = [];
  const r = await new MockAdapter({ delayMs: 0 }).run(spec(), p => progress.push(p.kind), new AbortController().signal);
  assert.equal(r.status, 'succeeded');
  assert.equal(r.meta.processStarted, true);
  assert.ok(progress.includes('started'));
});
