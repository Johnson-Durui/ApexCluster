import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ModelAdapter } from '../src/adapters/types.js';
import { assertDispatchSafe, dispatchBlockReason, recordUnconfirmedProcess } from '../src/adapters/dispatch-safety.js';
import type { RunProcessResult } from '../src/adapters/process.js';
import { defaultConfig } from '../src/config.js';
import { emptyMeta } from '../src/adapters/types.js';
import { liveProbe, probeEnvironment } from '../src/probe.js';
import { tempDir } from './helpers.js';

function processResult(patch: Partial<RunProcessResult> = {}): RunProcessResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    spawnError: null,
    stdoutTail: 'tool 1.2.3\n',
    stderrTail: '',
    durationMs: 1,
    pid: 123,
    ...patch,
  };
}

function config() {
  const root = tempDir('dmw-probe-dispatch-');
  const cfg = defaultConfig(root);
  cfg.dataDir = path.join(root, 'data');
  cfg.adapters.claude.command = { command: path.join(root, 'claude.exe') };
  cfg.adapters.codex.command = { command: path.join(root, 'codex.exe') };
  cfg.adapters.cursor.command = { command: process.execPath, args: [path.join(root, 'cursor.mjs')] };
  cfg.adapters.cursor.capabilities = null;
  return cfg;
}

test('历史未确认进程登记跨新调用阻断环境和 live，零进程零 adapter', async () => {
  const cfg = config();
  recordUnconfirmedProcess(cfg.dataDir, 'previous:server', 'process tree unknown');
  assert.match(dispatchBlockReason(cfg.dataDir) ?? '', /previous:server/);
  assert.throws(() => assertDispatchSafe(cfg.dataDir), /模型派发已锁定/);

  let simpleCalls = 0;
  await assert.rejects(() => probeEnvironment(cfg, { runSimple: async () => { simpleCalls += 1; return processResult(); } }), /模型派发已锁定/);
  let adapters = 0;
  await assert.rejects(() => liveProbe(cfg, [{ role: 'claude' }], { adapterFor: () => { adapters += 1; throw new Error('不得创建'); } }), /模型派发已锁定/);
  assert.equal(simpleCalls, 0);
  assert.equal(adapters, 0);
});

test('版本探测出现 terminationWarning 后立即登记并阻断同次后续和 live', async () => {
  const cfg = config();
  let calls = 0;
  await assert.rejects(() => probeEnvironment(cfg, {
    runSimple: async () => {
      calls += 1;
      return processResult({ terminationWarning: 'version tree unknown' });
    },
  }), /模型派发已锁定/);
  assert.equal(calls, 1);
  assert.match(dispatchBlockReason(cfg.dataDir) ?? '', /probe:claude:version.*version tree unknown/);

  let adapters = 0;
  await assert.rejects(() => liveProbe(cfg, [{ role: 'claude' }], { adapterFor: () => { adapters += 1; throw new Error('不得创建'); } }), /模型派发已锁定/);
  assert.equal(adapters, 0);
});

test('live terminationWarning 阻断同次后续角色以及新实例', async () => {
  const cfg = config();
  let runs = 0;
  const adapter: ModelAdapter = {
    kind: 'mock',
    async run(spec) {
      runs += 1;
      const meta = emptyMeta('mock', spec, new Date().toISOString());
      meta.terminationWarning = 'live tree unknown';
      meta.warnings.push('live tree unknown');
      return { status: 'succeeded', failure: null, rawText: '{"ok":true}', structured: { ok: true }, meta, toolLog: [], simulated: true };
    },
  };
  await assert.rejects(() => liveProbe(cfg, [{ role: 'claude' }, { role: 'astra' }], { adapterFor: () => adapter }), /模型派发已锁定/);
  assert.equal(runs, 1);
  assert.match(dispatchBlockReason(cfg.dataDir) ?? '', /probe:claude:live.*live tree unknown/);

  let freshRuns = 0;
  await assert.rejects(() => liveProbe(cfg, [{ role: 'sol' }], { adapterFor: () => ({ ...adapter, run: async (...args) => { freshRuns += 1; return adapter.run(...args); } }) }), /模型派发已锁定/);
  assert.equal(freshRuns, 0);
});

test('损坏或形状异常的持久化登记 fail closed', async () => {
  for (const content of ['{broken', '{"schema":1,"records":[]}']) {
    const cfg = config();
    recordUnconfirmedProcess(cfg.dataDir, 'seed', 'seed warning');
    const registry = readdirSync(cfg.dataDir).find((name) => name.includes('unconfirmed-processes'))!;
    writeFileSync(path.join(cfg.dataDir, registry), content, 'utf8');
    assert.match(dispatchBlockReason(cfg.dataDir) ?? '', /损坏/);
    let calls = 0;
    await assert.rejects(() => probeEnvironment(cfg, { runSimple: async () => { calls += 1; return processResult(); } }), /模型派发已锁定/);
    assert.equal(calls, 0);
    assert.throws(() => recordUnconfirmedProcess(cfg.dataDir, 'replacement', 'must not overwrite'), /损坏/);
  }
});

test('Cursor 环境探测移除 endpoint，危险 prefixArgs 在版本前关闭', async () => {
  const cfg = config();
  const oldEndpoint = process.env.CURSOR_API_ENDPOINT;
  process.env.CURSOR_API_ENDPOINT = 'https://secret.invalid';
  const seen: Array<{ file: string; args: string[]; endpoint: string | undefined }> = [];
  try {
    await probeEnvironment(cfg, {
      runSimple: async (command, args, opts) => {
        seen.push({ file: command.file, args, endpoint: opts?.env?.CURSOR_API_ENDPOINT });
        return processResult({ stdoutTail: args.includes('status') ? '{}' : 'tool 1.2.3\n' });
      },
    });
  } finally {
    if (oldEndpoint === undefined) delete process.env.CURSOR_API_ENDPOINT;
    else process.env.CURSOR_API_ENDPOINT = oldEndpoint;
  }
  const cursorCall = seen.find((item) => item.args.length === 1 && item.args[0] === '--version' && item.file === process.execPath);
  assert.ok(cursorCall);
  assert.equal(cursorCall.endpoint, undefined);

  const unsafe = config();
  unsafe.adapters.cursor.command = { command: process.execPath, args: ['--force'] };
  let unsafeCursorCalls = 0;
  await probeEnvironment(unsafe, {
    runSimple: async (command, args) => {
      if (command.file === process.execPath && args[0] === '--version') unsafeCursorCalls += 1;
      return processResult({ stdoutTail: args.includes('status') ? '{}' : 'tool 1.2.3\n' });
    },
  });
  assert.equal(unsafeCursorCalls, 0);
});
