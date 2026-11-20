import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { buildWindowsJobRequest, createChatWindowsJobReceiptDirectory, runChatWindowsJobProcess, validateChatWindowsJobReceiptRoot, WindowsJobProcessError, windowsJobFinalConfirmed } from '../src/chat/windows-job-process.js';
import { tempDir } from './helpers.js';

const binary = process.env.DMW_WINDOWS_JOB_SUPERVISOR;
const options = (signal?: AbortSignal) => ({ cwd: process.cwd(), env: process.env, stdinText: null, timeoutMs: 5_000, platform: 'win32' as const, signal,
  supervisorPath: binary!, receiptDirectory: tempDir('dmw-job-receipts-') });
function exactLengthDirectory(length: number, prefix: string): string {
  let directory = tempDir(prefix);
  while (directory.length < length) { const size = Math.min(40, length - directory.length - 1); assert.ok(size > 0); directory = path.join(directory, 'x'.repeat(size)); mkdirSync(directory); }
  assert.equal(directory.length, length); return directory;
}

test('Windows Job supervisor preserves stdio and confirms natural exit', { skip: !binary || !existsSync(binary) }, async () => {
  const canary = 'DMW_PUBLIC_ENV_CANARY';
  const result = await runChatWindowsJobProcess({ file: process.execPath, prefixArgs: [], via: 'direct' }, ['-e', `process.stdout.write(process.env.${canary}||'')`], { ...options(), env: { ...process.env, [canary]: 'VISIBLE' } });
  assert.equal(result.stdoutTail, 'VISIBLE', JSON.stringify(result)); assert.equal(result.exitCode, 0); assert.equal(result.terminationWarning, undefined); assert.ok(result.pid);
  assert.deepEqual(buildWindowsJobRequest({ file: process.execPath, prefixArgs: [], via: 'direct' }, [], process.cwd()), { file: process.execPath, args: [], cwd: process.cwd() });
  assert.doesNotMatch(JSON.stringify(buildWindowsJobRequest({ file: process.execPath, prefixArgs: [], via: 'direct' }, [], process.cwd())), /DMW_PUBLIC_ENV_CANARY|env/);
});

test('Windows Job supervisor honors cancellation before READY without resuming target code', { skip: !binary || !existsSync(binary) }, async () => {
  const controller = new AbortController(); controller.abort();
  const directory = tempDir('dmw-job-precancel-'); const marker = path.join(directory, 'must-not-exist.txt'); let started = false;
  const result = await runChatWindowsJobProcess({ file: process.execPath, prefixArgs: [], via: 'direct' }, ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`], { ...options(controller.signal), cwd: directory, onStarted: () => { started = true; } });
  assert.equal(result.cancelled, true); assert.equal(result.terminationWarning, undefined); assert.equal(started, false); assert.equal(existsSync(marker), false);
  assert.ok('windowsJob' in result && result.windowsJob.confirmed && !result.windowsJob.resumed && result.windowsJob.cancelReceived);
});

test('Windows Job supervisor rechecks cancellation after READY while control connection is delayed', { skip: !binary || !existsSync(binary) }, async () => {
  const controller = new AbortController(); const directory = tempDir('dmw-job-ready-cancel-'); const marker = path.join(directory, 'must-not-exist.txt');
  const result = await runChatWindowsJobProcess({ file: process.execPath, prefixArgs: [], via: 'direct' }, ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`], {
    ...options(controller.signal), cwd: directory, testOnlyControlConnectDelayMs: 100, testOnlyOnReady: () => controller.abort(),
  });
  assert.equal(result.cancelled, true); assert.equal(result.terminationWarning, undefined); assert.equal(existsSync(marker), false);
  assert.ok('windowsJob' in result && result.windowsJob.confirmed && !result.windowsJob.resumed && result.windowsJob.cancelReceived);
});

test('Windows Job supervisor cancels a detached child without taskkill', { skip: !binary || !existsSync(binary) }, async () => {
  const controller = new AbortController(); let childPid = 0;
  const program = "const{spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});c.unref();console.log(c.pid);setInterval(()=>{},1000)";
  const resultPromise = runChatWindowsJobProcess({ file: process.execPath, prefixArgs: [], via: 'direct' }, ['-e', program], { ...options(controller.signal), onStdoutLine: line => { childPid = Number(line); controller.abort(); } });
  const result = await resultPromise; assert.equal(result.cancelled, true); assert.equal(result.terminationWarning, undefined); assert.ok(childPid > 0);
  assert.throws(() => process.kill(childPid, 0));
});

test('Windows Job supervisor treats control-channel EOF as cancellation', { skip: !binary || !existsSync(binary) }, async () => {
  const program = "setInterval(()=>{},1000)";
  const result = await runChatWindowsJobProcess({ file: process.execPath, prefixArgs: [], via: 'direct' }, ['-e', program], { ...options(), testOnlyDisconnectControlAfterResume: true });
  assert.equal(result.terminationWarning, undefined);
  assert.ok('windowsJob' in result && result.windowsJob.confirmed && result.windowsJob.resumed && result.windowsJob.cancelReceived);
});

test('Windows Job supervisor terminates a surviving child after the root exits', { skip: !binary || !existsSync(binary) }, async () => {
  let childPid = 0;
  const program = "const{spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});c.unref();console.log(c.pid)";
  const result = await runChatWindowsJobProcess({ file: process.execPath, prefixArgs: [], via: 'direct' }, ['-e', program], { ...options(), onStdoutLine: line => { childPid = Number(line); } });
  assert.equal(result.terminationWarning, undefined);
  assert.ok('windowsJob' in result && result.windowsJob.confirmed);
  assert.ok('windowsJob' in result && (result.windowsJob.activeBeforeStop ?? 0) >= 1);
  assert.ok(childPid > 0);
  assert.throws(() => process.kill(childPid, 0));
});

test('Windows Job wrapper fails closed when the supervisor cannot produce a receipt', async () => {
  const result = await runChatWindowsJobProcess({ file: process.execPath, prefixArgs: [], via: 'direct' }, ['-e', 'process.exit(0)'], { ...options(), supervisorPath: process.execPath, timeoutMs: 500 });
  assert.match(result.terminationWarning ?? '', /未确认/);
  assert.ok('windowsJob' in result && !result.windowsJob.confirmed);
});

test('Windows Job final confirmation also requires a healthy supervisor process', () => {
  const receipt = { version: 1 as const, rootPid: 42, rootExited: true, activeProcesses: 0, activeBeforeStop: 1, jobConfirmed: true, cancelReceived: true, exitCode: 130, helperError: null, ready: true, resumed: true };
  const helper = { exitCode: 1, signal: null, timedOut: false, cancelled: false, spawnError: null, stdoutTail: '', stderrTail: '', durationMs: 1, pid: 10 };
  assert.equal(windowsJobFinalConfirmed(receipt, helper), false);
});

test('Windows Job supervisor terminates a suspended target when assignment fails', { skip: !binary || !existsSync(binary) }, () => {
  const directory = tempDir('dmw-job-assign-fail-'); const receipt = path.join(directory, 'receipt.json');
  const request = Buffer.from(JSON.stringify(buildWindowsJobRequest({ file: process.execPath, prefixArgs: [], via: 'direct' }, ['-e', 'setInterval(()=>{},1000)'], directory))).toString('base64');
  const result = spawnSync(binary!, [request, `unused-${process.pid}`, receipt, '--test-assign-failure'], { cwd: directory, env: process.env, encoding: 'utf8', timeout: 5_000 });
  assert.equal(result.status, 125);
  const value = JSON.parse(readFileSync(receipt, 'utf8')) as { rootPid: number; rootExited: boolean; helperError: string };
  assert.equal(value.rootExited, true); assert.match(value.helperError, /test assign failure/); assert.throws(() => process.kill(value.rootPid, 0));
});

test('Windows Job supervisor times out waiting for the initial control connection and cleans the suspended target', { skip: !binary || !existsSync(binary) }, () => {
  const directory = tempDir('dmw-job-no-control-'); const receipt = path.join(directory, 'receipt.json');
  const request = Buffer.from(JSON.stringify(buildWindowsJobRequest({ file: process.execPath, prefixArgs: [], via: 'direct' }, ['-e', 'setInterval(()=>{},1000)'], directory))).toString('base64');
  const result = spawnSync(binary!, [request, `never-connected-${process.pid}`, receipt], { cwd: directory, env: process.env, encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.status, 125);
  const value = JSON.parse(readFileSync(receipt, 'utf8')) as { rootPid: number; rootExited: boolean; helperError: string; resumed: boolean };
  assert.equal(value.resumed, false); assert.equal(value.rootExited, true); assert.match(value.helperError, /control pipe connection timeout/); assert.throws(() => process.kill(value.rootPid, 0));
});

test('Windows Job one-shot normal and cancel succeed from a 208-character private control directory', { skip: !binary || !existsSync(binary) }, async () => {
  const receiptDirectory = exactLengthDirectory(208, 'dmw-job-long-');
  const normal = await runChatWindowsJobProcess({ file: process.execPath, prefixArgs: [], via: 'direct' }, ['-e', 'process.stdout.write("LONG_OK")'], { ...options(), receiptDirectory });
  assert.equal(normal.stdoutTail, 'LONG_OK'); assert.equal(normal.terminationWarning, undefined);
  const controller = new AbortController();
  const cancelled = await runChatWindowsJobProcess({ file: process.execPath, prefixArgs: [], via: 'direct' }, ['-e', 'setInterval(()=>{},1000)'], { ...options(controller.signal), receiptDirectory, onStarted: () => controller.abort() });
  assert.equal(cancelled.cancelled, true); assert.equal(cancelled.terminationWarning, undefined);
});

test('Windows Job one-shot rejects a 213-character control directory before target dispatch', { skip: !binary || !existsSync(binary) }, async () => {
  const receiptDirectory = exactLengthDirectory(213, 'dmw-job-too-long-'); const marker = path.join(tempDir('dmw-job-marker-'), 'must-not-exist');
  await assert.rejects(runChatWindowsJobProcess({ file: process.execPath, prefixArgs: [], via: 'direct' }, ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`], { ...options(), receiptDirectory }), /legacy safe limit/);
  assert.equal(existsSync(marker), false);
});

test('Windows Job pre-dispatch rejection is explicitly confirmed and phased', async () => {
  const receiptDirectory = exactLengthDirectory(213, 'dmw-job-phase-');
  await assert.rejects(
    runChatWindowsJobProcess({ file: process.execPath, prefixArgs: [], via: 'direct' }, ['--version'], { ...options(), supervisorPath: process.execPath, receiptDirectory }),
    (error: unknown) => error instanceof WindowsJobProcessError && error.exitConfirmed === true && error.phase === 'pre_dispatch' && /legacy safe limit/.test(error.message),
  );
});

test('controlled Claude and Codex receipt directories are short and private-rooted', () => {
  const receiptRoot = tempDir('dmw-controlled-receipt-root-');
  for (const prefix of ['claude-job-control-', 'codex-job-control-'] as const) {
    const receiptDirectory = createChatWindowsJobReceiptDirectory(prefix, receiptRoot);
    try {
      assert.ok(path.isAbsolute(receiptDirectory));
      assert.ok(receiptDirectory.length + 1 + 46 < 260);
      assert.match(path.basename(receiptDirectory), new RegExp(`^${prefix}.+`));
      assert.equal(path.dirname(receiptDirectory), validateChatWindowsJobReceiptRoot(receiptRoot));
    } finally { rmSync(receiptDirectory, { recursive: true, force: true }); }
  }
});

test('Windows Job errors after the process boundary remain unconfirmed', async () => {
  const receiptDirectory = createChatWindowsJobReceiptDirectory('claude-job-control-', tempDir('dmw-controlled-receipt-root-'));
  try {
    await assert.rejects(
      runChatWindowsJobProcess({ file: process.execPath, prefixArgs: [], via: 'direct' }, ['--version'], {
        ...options(), supervisorPath: process.execPath, receiptDirectory,
        testOnlyRunProcess: async () => { throw new Error('fake supervisor dispatch failed'); },
      }),
      (error: unknown) => error instanceof WindowsJobProcessError && error.exitConfirmed === false && error.phase === 'post_dispatch' && /fake supervisor/.test(error.message),
    );
  } finally { rmSync(receiptDirectory, { recursive: true, force: true }); }
});

test('controlled receipt root rejects missing, long, symlinked and unwritable parents before dispatch', () => {
  const missing = path.join(tempDir('dmw-receipt-missing-parent-'), 'missing');
  assert.throws(() => createChatWindowsJobReceiptDirectory('claude-job-control-', missing), confirmedPreDispatch);

  const long = exactLengthDirectory(213, 'dmw-receipt-long-parent-');
  assert.throws(() => createChatWindowsJobReceiptDirectory('claude-job-control-', long), confirmedPreDispatch);

  const target = tempDir('dmw-receipt-link-target-'); const link = path.join(tempDir('dmw-receipt-link-parent-'), 'linked');
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => createChatWindowsJobReceiptDirectory('codex-job-control-', link), confirmedPreDispatch);

  const unwritable = tempDir('dmw-receipt-unwritable-');
  assert.throws(() => validateChatWindowsJobReceiptRoot(unwritable, () => { throw new Error('EACCES: synthetic unwritable root'); }), confirmedPreDispatch);
});

function confirmedPreDispatch(error: unknown): boolean {
  return error instanceof WindowsJobProcessError && error.exitConfirmed === true && error.phase === 'pre_dispatch';
}
