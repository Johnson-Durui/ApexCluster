import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';
import { killTree, resolveCommand, runProcess } from '../src/adapters/process.js';
import type { ModelTaskSpec } from '../src/adapters/types.js';
import { OUTPUT_SCHEMAS } from '../src/core/schemas.js';
import { toStrictJsonSchema } from '../src/core/strict-json-schema.js';
import { tempDir } from './helpers.js';

const windowsOnly = { skip: process.platform !== 'win32', timeout: 20_000 };
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-cli');

test('Windows：从 PATH 解析真实 npm 风格 .cmd 垫片并运行假 Claude CLI', windowsOnly, async (t) => {
  const root = tempDir('dmw-中文 垫片-');
  const bin = path.join(root, 'npm bin');
  const target = path.join(bin, 'node_modules', 'fake-claude', 'fake-claude.mjs');
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(path.join(fixtures, 'fake-claude.mjs'), target);
  writeFileSync(path.join(bin, 'claude.cmd'), [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\node_modules\\fake-claude\\fake-claude.mjs" %*',
    '',
  ].join('\r\n'), 'utf8');

  const argsFile = path.join(root, '收到 参数.json');
  const envPatch: Record<string, string | undefined> = {
    // 隔离 PATH，绝不因本机存在 claude.exe 而误调用真实 CLI。
    PATH: bin, FAKE_MODE: 'ok', FAKE_ARGS_FILE: argsFile,
    FAKE_OUTPUT_FILE: undefined, FAKE_API_KEY_SOURCE: undefined,
  };
  const previous = Object.fromEntries(Object.keys(envPatch).map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const [key, value] of Object.entries(envPatch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const expectedCommand = { file: process.execPath, prefixArgs: [target], via: 'node-shim' };
  assert.deepEqual(resolveCommand('claude'), expectedCommand);
  const adapter = new ClaudeCodeAdapter();
  assert.deepEqual(adapter.resolve(), expectedCommand);
  const spec: ModelTaskSpec = {
    taskId: 'windows-shim', runId: 'windows-t1', role: 'claude', phase: 'probe', attempt: 1,
    model: 'claude-opus-5-5', effort: 'max',
    prompt: '中文 空格 🌏 “引号” C:\\测试 目录\\输入\n& | < > %PATH% 原样经 stdin 传入',
    outputSchema: toStrictJsonSchema(OUTPUT_SCHEMAS.probe),
    cwd: path.join(root, '测试 工作目录'), logDir: path.join(root, '输出 日志'), timeoutMs: 10_000,
    sandbox: 'read_only', allowNetwork: false, allowWeb: false, gitRepo: false, resumeSessionId: null,
    context: { snapshotRef: null, constraintIds: [], criterionIds: [], knownQuestionIds: [], anonymousMap: null, recheckItems: null, spec: null, mockScenario: null },
  };
  const result = await adapter.run(spec, () => undefined, new AbortController().signal);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.failure, null);
  assert.equal(result.meta.exitCode, 0);
  assert.deepEqual(result.structured, { ok: true, note: '探测成功' });
  const seen = JSON.parse(readFileSync(argsFile, 'utf8')) as { prompt: string; cwd: string; argv: string[] };
  assert.equal(seen.prompt, spec.prompt);
  assert.equal(seen.cwd, spec.cwd);
  assert.ok(!seen.argv.includes(spec.prompt), '提示词必须经 stdin 传输');
  assert.deepEqual(result.meta.command.slice(0, 2), [process.execPath, target]);
  assert.equal(result.meta.nativeSchema, true, 'node-shim 不经过 cmd.exe，保留原生 schema');
});

test('Windows：中文与空格的工作目录、脚本路径、日志路径中逐字节 UTF-8 往返', windowsOnly, async () => {
  const cwd = tempDir('dmw-测试 目录-');
  const script = path.join(cwd, '回显 脚本.mjs');
  copyFileSync(path.join(fixtures, 'echo-stdin.mjs'), script);
  const prompt = '中文 空格 🌏 “引号” C:\\中文 路径\\文件\r\n第二行 & | %PATH%';
  const stdoutLogPath = path.join(cwd, '标准 输出.log');
  const stderrLogPath = path.join(cwd, '错误 输出.log');
  const lines: string[] = [];
  const errors: string[] = [];
  const result = await runProcess({ file: process.execPath, prefixArgs: [script], via: 'config' }, ['bytewise'], {
    cwd, env: process.env, stdinText: prompt, timeoutMs: 10_000, stdoutLogPath, stderrLogPath,
    onStdoutLine: (line) => lines.push(line), onStderrLine: (line) => errors.push(line),
  });
  assert.equal(result.spawnError, null);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdoutTail, `GOT:${prompt}\n`);
  assert.deepEqual(lines, ['GOT:中文 空格 🌏 “引号” C:\\中文 路径\\文件', '第二行 & | %PATH%']);
  assert.deepEqual(errors, ['stderr 行']);
  assert.deepEqual(readFileSync(stdoutLogPath), Buffer.from(`GOT:${prompt}\n`, 'utf8'));
  assert.deepEqual(readFileSync(stderrLogPath), Buffer.from('stderr 行\r\n', 'utf8'));
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // 权限错误不能当作“进程已退出”的证据。
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

for (const mode of ['timeout', 'cancel'] as const) {
  test(`Windows：${mode === 'timeout' ? '超时' : '取消'}后父进程及工具子进程都结束`, windowsOnly, async (t) => {
    const ac = new AbortController();
    const box: { pids?: { parent: number; child: number }; bothAlive: boolean } = { bothAlive: false };
    // 清理只在断言结束后执行，不能靠清理使“进程已结束”断言通过。
    t.after(async () => {
      ac.abort();
      if (box.pids) {
        for (const pid of [box.pids.parent, box.pids.child]) {
          if (alive(pid)) await killTree(pid);
        }
      }
    });
    const result = await runProcess({ file: process.execPath, prefixArgs: [path.join(fixtures, 'spawn-child.mjs')], via: 'config' }, [], {
      cwd: tempDir('dmw-进程 树-'), env: process.env, stdinText: null,
      timeoutMs: mode === 'timeout' ? 2_000 : 10_000, signal: ac.signal,
      onStdoutLine: (line) => {
        box.pids = JSON.parse(line) as { parent: number; child: number };
        box.bothAlive = alive(box.pids.parent) && alive(box.pids.child);
        if (mode === 'cancel') ac.abort();
      },
    });
    assert.equal(result.spawnError, null);
    assert.ok(box.pids, '必须收到父子 PID，不能仅验证启动失败');
    assert.equal(box.bothAlive, true, '终止前父子进程必须都曾存活');
    assert.equal(result.pid, box.pids.parent);
    assert.equal(result.timedOut, mode === 'timeout');
    assert.equal(result.cancelled, mode === 'cancel');
    const deadline = Date.now() + 5_000;
    while ((alive(box.pids.parent) || alive(box.pids.child)) && Date.now() < deadline) await delay(25);
    assert.equal(alive(box.pids.parent), false, '父进程应已结束');
    assert.equal(alive(box.pids.child), false, '工具子进程应已结束');
  });
}
