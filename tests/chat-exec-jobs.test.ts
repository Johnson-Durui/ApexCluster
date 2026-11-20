import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { CommandRunner } from '../src/chat/runner-contract.js';
import type { CommandSpec, RunnerResult } from '../src/chat/runner.js';
import { ExecJobs } from '../src/exec/jobs.js';
import { BoundedOutputCapture } from '../src/exec/output-limit.js';
import { RunnerExecBackend } from '../src/exec/runner-backend.js';
import type { ExecBackend, ExecResult } from '../src/exec/types.js';

const spec = { argv: ['node', '--version'], cwd: '.', timeoutMs: 1_000 };

test('bounded output capture handles early stream errors once and surfaces them on close', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'chat-exec-output-error-'));
  try {
    const stdout = path.join(root, 'stdout.txt');
    const stderr = path.join(root, 'stderr.txt');
    writeFileSync(stdout, 'occupied');
    writeFileSync(stderr, 'occupied');
    let terminations = 0;
    const capture = new BoundedOutputCapture(stdout, stderr, () => { terminations++; });

    await assert.rejects(capture.close(), (error: NodeJS.ErrnoException) => error.code === 'EEXIST');
    assert.equal(terminations, 1);
    assert.equal(readFileSync(stdout, 'utf8'), 'occupied');
    assert.equal(readFileSync(stderr, 'utf8'), 'occupied');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const cancelledResult = (directory: string): ExecResult => ({
  exitCode: null,
  timedOut: false,
  cancelled: true,
  exitConfirmed: true,
  durationMs: 1,
  stdoutRef: path.join(directory, 'stdout.txt'),
  stderrRef: path.join(directory, 'stderr.txt'),
  network: 'none',
});

function abortOnlyBackend(): ExecBackend {
  return {
    id: 'windows-mxc',
    async probe() { return { ok: true }; },
    async run(_spec, context) {
      await new Promise<void>((resolve) => {
        if (context.signal.aborted) resolve();
        else context.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return cancelledResult(context.outputDir);
    },
  };
}

function runnerResult(overrides: Partial<RunnerResult> = {}): RunnerResult {
  return {
    ticketId: 'ticket-1',
    command: [],
    removedEnv: [],
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    spawnError: null,
    stdoutTail: 'verified output',
    stderrTail: '',
    durationMs: 7,
    pid: 123,
    ...overrides,
  };
}

test('exec jobs isolate status and running jobs by task owner', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'chat-exec-owner-'));
  try {
    const jobs = new ExecJobs(abortOnlyBackend(), path.join(root, 'scratch'));
    const first = jobs.start('task-a', spec, root, new AbortController().signal);
    const second = jobs.start('task-b', spec, root, new AbortController().signal);

    assert.deepEqual(jobs.running('task-a'), [first]);
    assert.deepEqual(jobs.running('task-b'), [second]);
    assert.throws(() => jobs.status('task-b', first), /不存在或不属于当前任务/);

    await Promise.all([jobs.stop('task-a', first), jobs.stop('task-b', second)]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stopping an exec job cancels it and returns confirmed exit status', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'chat-exec-stop-'));
  try {
    const jobs = new ExecJobs(abortOnlyBackend(), path.join(root, 'scratch'));
    const id = jobs.start('task-a', spec, root, new AbortController().signal);

    const status = await jobs.stop('task-a', id);

    assert.equal(status.status, 'finished');
    assert.equal(status.result?.cancelled, true);
    assert.equal(status.result?.exitConfirmed, true);
    assert.deepEqual(jobs.running('task-a'), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runner backend selects the matching verified executable and forwards the isolated cwd', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'chat-exec-runner-'));
  const copyDir = path.join(root, 'copy');
  const outputDir = path.join(root, 'output');
  const nested = path.join(copyDir, 'nested');
  mkdirSync(nested, { recursive: true });
  mkdirSync(outputDir);
  let issued: { invocationId: string; spec: CommandSpec; allowedRoot: string } | undefined;
  let runCall: { ticketId: string; invocationId: string; signal?: AbortSignal } | undefined;
  const runner: CommandRunner = {
    capability: { platform: 'windows' },
    commandInfo: () => [{
      platform: 'windows',
      executablePaths: ['C:\\verified\\python.exe', 'C:\\verified\\node.exe'],
      network: 'none',
      writableScope: 'derived-test-copy',
    }],
    issueTicket(invocationId, command, allowedRoot) {
      issued = { invocationId, spec: command, allowedRoot };
      return 'ticket-1';
    },
    async run(ticketId, invocationId, signal) {
      runCall = { ticketId, invocationId, signal };
      return runnerResult();
    },
  };
  const signal = new AbortController().signal;

  try {
    const result = await new RunnerExecBackend('windows-mxc', runner).run(
      { argv: ['node', '--version'], cwd: 'nested', env: { SAFE: 'yes' }, timeoutMs: 2_000 },
      { copyDir, outputDir, signal },
    );

    assert.equal(issued?.spec.executable, 'C:\\verified\\node.exe');
    assert.equal(issued?.spec.cwd, nested);
    assert.deepEqual(issued?.spec.args, ['--version']);
    assert.equal(issued?.allowedRoot, copyDir);
    assert.equal(issued?.spec.network, 'none');
    assert.equal(runCall?.ticketId, 'ticket-1');
    assert.equal(runCall?.invocationId, issued?.invocationId);
    assert.equal(runCall?.signal, signal);
    assert.equal(readFileSync(result.stdoutRef, 'utf8'), 'verified output');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runner backend rejects an executable absent from the verified command list', async () => {
  let issued = false;
  const runner: CommandRunner = {
    capability: { platform: 'windows' },
    commandInfo: () => [{
      platform: 'windows',
      executablePaths: ['C:\\verified\\node.exe'],
      network: 'none',
      writableScope: 'derived-test-copy',
    }],
    issueTicket() {
      issued = true;
      return 'unexpected-ticket';
    },
    async run() { throw new Error('runner must not be called'); },
  };

  await assert.rejects(
    () => new RunnerExecBackend('windows-mxc', runner).run(
      { argv: ['python', '--version'], cwd: '.', timeoutMs: 1_000 },
      { copyDir: process.cwd(), outputDir: process.cwd(), signal: new AbortController().signal },
    ),
    /没有当前隔离执行端的证明/,
  );
  assert.equal(issued, false);
});

test('runner backend reports an unconfirmed exit when the runner returns a termination warning', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'chat-exec-warning-'));
  const outputDir = path.join(root, 'output');
  mkdirSync(outputDir);
  const runner: CommandRunner = {
    capability: { platform: 'windows' },
    commandInfo: () => [{
      platform: 'windows', executablePaths: ['C:\\verified\\node.exe'], network: 'none', writableScope: 'derived-test-copy',
    }],
    issueTicket() { return 'ticket-1'; },
    async run() { return runnerResult({ terminationWarning: 'process tree exit was not confirmed' }); },
  };

  try {
    const result = await new RunnerExecBackend('windows-mxc', runner).run(
      spec,
      { copyDir: root, outputDir, signal: new AbortController().signal },
    );

    assert.equal(result.exitConfirmed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
