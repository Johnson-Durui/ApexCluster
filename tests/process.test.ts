import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killTree, parseCmdShim, resolveCommand, runProcess, scrubEnv } from '../src/adapters/process.js';
import { tempDir } from './helpers.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-cli');
const node = (script: string) => ({ file: process.execPath, prefixArgs: [path.join(FAKE, script)], via: 'config' as const });

/** 进程是否仍在运行。Linux 上僵尸进程（已结束、等待回收；容器的 1 号进程可能不回收）视为已结束 */
function alive(pid: number): boolean {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
      return state !== 'Z' && state !== 'X';
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('提示词经 stdin 以 UTF-8 传入；中文/表情/大输入不截断', async () => {
  const text = `你好，世界 🌏 “引号” \\ 路径 X:\\Profiles\\张三\\项目\n${'长'.repeat(300_000)}`;
  const lines: string[] = [];
  let startedPid: number | null = null;
  const r = await runProcess(node('echo-stdin.mjs'), [], { cwd: process.cwd(), env: process.env, stdinText: text, timeoutMs: 20_000,
    onStarted: (pid) => { startedPid = pid; }, onStdoutLine: (l) => lines.push(l) });
  assert.equal(r.exitCode, 0);
  assert.equal(r.pid, startedPid);
  assert.equal(typeof r.pid, 'number');
  assert.equal(r.stdoutTail, `GOT:${text}\n`);
  assert.equal(lines[0], 'GOT:你好，世界 🌏 “引号” \\ 路径 X:\\Profiles\\张三\\项目');
});

test('多字节字符被拆到不同数据块时也能正确解码；\\r\\n 行尾被处理', async () => {
  const lines: string[] = [];
  const errLines: string[] = [];
  const r = await runProcess(node('echo-stdin.mjs'), ['bytewise'], {
    cwd: process.cwd(),
    env: process.env,
    stdinText: '架构工作台',
    timeoutMs: 20_000,
    onStdoutLine: (l) => lines.push(l),
    onStderrLine: (l) => errLines.push(l),
  });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(lines, ['GOT:架构工作台']);
  assert.deepEqual(errLines, ['stderr 行']);
});

test('非零退出码被如实返回', async () => {
  const r = await runProcess(node('echo-stdin.mjs'), ['normal', '3'], { cwd: process.cwd(), env: process.env, stdinText: 'x', timeoutMs: 20_000 });
  assert.equal(r.exitCode, 3);
});

test('超时：结束整个进程树并标记 timedOut', async () => {
  const box: { pids: { parent: number; child: number } | null } = { pids: null };
  const r = await runProcess(node('spawn-child.mjs'), [], {
    cwd: process.cwd(),
    env: process.env,
    stdinText: null,
    timeoutMs: 800,
    onStdoutLine: (l) => (box.pids = JSON.parse(l)),
  });
  assert.equal(r.timedOut, true);
  assert.ok(box.pids);
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(alive(box.pids!.parent), false, '父进程应已结束');
  assert.equal(alive(box.pids!.child), false, '子进程（工具进程）也应已结束');
});

test('取消：AbortSignal 触发后结束整个进程树并标记 cancelled', async () => {
  const ac = new AbortController();
  const box: { pids: { parent: number; child: number } | null } = { pids: null };
  const p = runProcess(node('spawn-child.mjs'), [], {
    cwd: process.cwd(),
    env: process.env,
    stdinText: null,
    timeoutMs: 30_000,
    signal: ac.signal,
    onStdoutLine: (l) => {
      box.pids = JSON.parse(l);
      ac.abort();
    },
  });
  const r = await p;
  assert.equal(r.cancelled, true);
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(alive(box.pids!.parent), false);
  assert.equal(alive(box.pids!.child), false);
});

test('Windows taskkill 确定失败时终止直接子进程并明确警告无法确认孙进程', async () => {
  const started = Date.now();
  const r = await runProcess(node('fake-claude.mjs'), [], {
    cwd: process.cwd(),
    env: { ...process.env, FAKE_MODE: 'slow' },
    stdinText: 'x',
    timeoutMs: 150,
    platform: 'win32',
    taskkillCommand: path.join(tempDir(), 'missing-taskkill.exe'),
  });
  assert.equal(r.timedOut, true);
  assert.match(r.terminationWarning ?? '', /无法确认整个子进程树.*孙进程可能仍在运行/);
  assert.ok(Date.now() - started < 5_000, 'taskkill 失败后应回退到直接子进程句柄，不能挂住调用');
});

test('找不到可执行文件时返回 spawnError 而不是抛异常', async () => {
  let started = false;
  const r = await runProcess({ file: path.join(tempDir(), 'no-such-cli'), prefixArgs: [], via: 'direct' }, [], { cwd: process.cwd(), env: process.env,
    stdinText: null, timeoutMs: 5000, onStarted: () => { started = true; } });
  assert.ok(r.spawnError);
  assert.equal(r.exitCode, null);
  assert.equal(r.pid, null);
  assert.equal(started, false);
});

test('解析 npm 生成的 .cmd 垫片：JS 目标改用 node 直接运行，exe 目标直接运行（都不经过 cmd.exe）', () => {
  const js = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`;
  const r1 = parseCmdShim(js, 'X:\\Profiles\\张三\\AppData\\Roaming\\npm');
  assert.deepEqual(r1, { target: 'X:\\Profiles\\张三\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js', isNode: true });
  const exe = `@ECHO off\r\n"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n`;
  const r2 = parseCmdShim(exe, 'C:\\npm');
  assert.deepEqual(r2, { target: 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe', isNode: false });
  assert.equal(parseCmdShim('@echo off\r\necho hi\r\n', 'C:\\x'), null);
});

test('resolveCommand：配置覆盖优先；按本机 PATH 分隔符和可执行文件名查找', () => {
  const dir = tempDir();
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  // Windows 盘符中的冒号不是 POSIX PATH 分隔符；按宿主平台构造文件名和 PATH。
  const executable = path.join(bin, process.platform === 'win32' ? 'claude.exe' : 'claude');
  writeFileSync(executable, '#!/bin/sh\n', { mode: 0o755 });
  const env = { PATH: [path.join(dir, 'missing'), bin].join(path.delimiter) };
  const r = resolveCommand('claude', { env });
  assert.deepEqual(r, { file: executable, prefixArgs: [], via: 'direct' });
  assert.equal(resolveCommand('codex', { env }), null);
  const o = resolveCommand('claude', { override: { command: 'C:\\tools\\claude.exe', args: [] } });
  assert.deepEqual(o, { file: 'C:\\tools\\claude.exe', prefixArgs: [], via: 'config' });
});

test('Windows resolveCommand：PATH 为空时发现最新的 Codex 桌面安装，并跳过不完整目录', { skip: process.platform !== 'win32' }, () => {
  const localAppData = tempDir('dmw-codex-appdata-');
  const bin = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  const older = path.join(bin, '1111111111111111');
  const newer = path.join(bin, '2222222222222222');
  const incomplete = path.join(bin, '3333333333333333');
  for (const dir of [older, newer, incomplete]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(older, 'codex.exe'), 'old');
  writeFileSync(path.join(newer, 'codex.exe'), 'new');
  utimesSync(older, new Date(1_000), new Date(1_000));
  utimesSync(newer, new Date(2_000), new Date(2_000));
  utimesSync(incomplete, new Date(3_000), new Date(3_000));

  assert.deepEqual(resolveCommand('codex', { env: { PATH: '', LOCALAPPDATA: localAppData }, platform: 'win32' }), {
    file: path.join(newer, 'codex.exe'), prefixArgs: [], via: 'direct',
  });
});

test('Windows resolveCommand：桌面更新删除旧 hash 后重新发现新版本且不缓存', { skip: process.platform !== 'win32' }, () => {
  const localAppData = tempDir('dmw-codex-update-');
  const bin = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  const oldDir = path.join(bin, 'aaaaaaaaaaaaaaaa');
  const newDir = path.join(bin, 'bbbbbbbbbbbbbbbb');
  mkdirSync(oldDir, { recursive: true });
  mkdirSync(newDir, { recursive: true });
  const oldCommand = path.join(oldDir, 'codex.exe');
  const newCommand = path.join(newDir, 'codex.exe');
  writeFileSync(oldCommand, 'old');
  writeFileSync(newCommand, 'new');
  utimesSync(newDir, new Date(1_000), new Date(1_000));
  utimesSync(oldDir, new Date(2_000), new Date(2_000));
  const env = { PATH: '', LOCALAPPDATA: path.join(localAppData, 'sandbox-remapped-localappdata') };
  const override = { command: oldCommand, args: ['--managed-flag'] };

  assert.deepEqual(resolveCommand('codex', { override, env, platform: 'win32' }), { file: oldCommand, prefixArgs: override.args, via: 'config' });
  rmSync(oldDir, { recursive: true });
  assert.deepEqual(resolveCommand('codex', { override, env, platform: 'win32' }), { file: newCommand, prefixArgs: override.args, via: 'direct' });

  const pathBin = path.join(localAppData, 'path-bin');
  const shimTarget = path.join(pathBin, 'codex.js');
  mkdirSync(pathBin);
  writeFileSync(shimTarget, '');
  writeFileSync(path.join(pathBin, 'codex.cmd'), '@ECHO off\r\n"%dp0%\\codex.js" %*\r\n');
  assert.deepEqual(resolveCommand('codex', { override, env: { ...env, PATH: pathBin }, platform: 'win32' }), {
    file: process.execPath, prefixArgs: [shimTarget, ...override.args], via: 'node-shim',
  });
});

test('Windows resolveCommand：失效的非托管自定义覆盖保持原行为', { skip: process.platform !== 'win32' }, () => {
  const custom = { command: 'C:\\custom-tools\\missing-codex.exe', args: ['--custom'] };
  assert.deepEqual(resolveCommand('codex', { override: custom, env: { PATH: '', LOCALAPPDATA: 'X:\\Profiles\\test\\AppData\\Local' }, platform: 'win32' }), {
    file: custom.command, prefixArgs: custom.args, via: 'config',
  });
});

test('scrubEnv：移除计费相关变量（大小写不敏感），只返回变量名', () => {
  const { env, removed } = scrubEnv({ ANTHROPIC_API_KEY: 'sk-x', openai_api_key: 'sk-y', PATH: '/bin' }, ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY']);
  assert.deepEqual(removed.sort(), ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.openai_api_key, undefined);
  assert.equal(env.PATH, '/bin');
});

test('scrubEnv：移除任意大小写的 *_API_KEY 及重复大小写变量且保留普通运行环境', () => {
  const canary = 'dummy-canary-never-a-real-key';
  const { env, removed } = scrubEnv({
    DMW_EXA_API_KEY: canary,
    dmw_exa_api_key: `${canary}-duplicate`,
    VENDOR_API_KEY: `${canary}-vendor`,
    ANTHROPIC_AUTH_TOKEN: `${canary}-explicit`,
    CI: '1',
    NODE_ENV: 'test',
    PATH: '/bin',
  }, ['ANTHROPIC_AUTH_TOKEN']);
  assert.equal(env.DMW_EXA_API_KEY, undefined);
  assert.equal(env.dmw_exa_api_key, undefined);
  assert.equal(env.VENDOR_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.deepEqual({ CI: env.CI, NODE_ENV: env.NODE_ENV, PATH: env.PATH }, { CI: '1', NODE_ENV: 'test', PATH: '/bin' });
  assert.equal(removed.includes('ANTHROPIC_AUTH_TOKEN'), true);
  assert.equal(removed.includes('DMW_EXA_API_KEY'), true);
  assert.equal(removed.includes('dmw_exa_api_key'), true);
  assert.equal(removed.includes('VENDOR_API_KEY'), true);
  assert.equal(removed.some((name) => name.includes(canary)), false, 'removed must contain names only, never values');
});

test('killTree 对已退出的进程是安全的', async () => {
  await killTree(999_999);
});
