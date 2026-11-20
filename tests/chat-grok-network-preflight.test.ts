import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { RunProcessResult } from '../src/adapters/process.js';
import type { CursorWriteCapabilities } from '../src/adapters/cursor-writer.js';
import { dispatchGrokSegment, runGrokNetworkPreflight } from '../scripts/chat-grok-network-preflight.js';

const capabilities = { distro: 'codex-cursor-h7', nodePath: '/opt/cursor-agent/versions/fixed/node' } as CursorWriteCapabilities;
const result = (patch: Partial<RunProcessResult> = {}): RunProcessResult => ({ exitCode: 0, signal: null, timedOut: false,
  cancelled: false, spawnError: null, stdoutTail: '{"ok":true,"authorized":true,"protocol":"TLSv1.3","resolvLayout":"root-regular-v2"}', stderrTail: '',
  durationMs: 12, pid: 7, ...patch });

test('Grok network preflight uses fixed zero-inference TLS command and scrubbed environment', async () => {
  let captured: any;
  const checked = await runGrokNetworkPreflight(capabilities, { env: { SystemRoot: 'C:\\Windows', PATH: 'safe', CURSOR_API_KEY: 'secret', HTTPS_PROXY: 'secret' },
    cwd: 'C:\\work', run: async (command, args, options) => { captured = { command, args, options }; return result(); } });
  assert.equal(checked.passed, true); assert.equal(checked.zeroInference, true); assert.equal(checked.protocol, 'TLSv1.3');
  assert.equal(captured.command.file, 'C:\\Windows\\System32\\wsl.exe');
  assert.deepEqual(captured.args.slice(0, 6), ['-d', capabilities.distro, '--cd', '/home/codex', '--exec', capabilities.nodePath]);
  assert.ok(captured.args.some((arg: string) => arg.includes('node:tls') && arg.includes('servername:host') && arg.includes('rejectUnauthorized:true')
    && arg.includes('timer=setTimeout') && arg.includes('clearTimeout(timer)') && !arg.includes('socket.setTimeout')));
  assert.ok(captured.args.includes('-e'));
  assert.ok(!captured.args.some((arg: string) => /cursor.*index\.js|--model|--print|https?:\/\//i.test(arg)));
  assert.equal(captured.options.stdinText, null); assert.equal(captured.options.timeoutMs, 10_000);
  assert.equal(captured.options.env.CURSOR_API_KEY, undefined); assert.equal(captured.options.env.HTTPS_PROXY, undefined);
  assert.deepEqual(Object.keys(captured.options.env).sort(), ['PATH', 'SystemRoot']);
});

test('Grok segment gate owns preflight evidence, accounting and dispatch order for every segment', async () => {
  const blocked: Record<string, any> = { paidSegmentsAttempted: 0 };
  let blockedDispatches = 0;
  await assert.rejects(() => dispatchGrokSegment(blocked, () => undefined, capabilities,
    async () => { blockedDispatches += 1; },
    { run: async () => result({ exitCode: 2, stdoutTail: '{"ok":false,"error":"network_timeout"}' }) }), /network_timeout/);
  assert.equal(blocked.paidSegmentsAttempted, 0); assert.equal(blockedDispatches, 0);

  const evidence: Record<string, any> = { paidSegmentsAttempted: 0 };
  const persisted: Record<string, any>[] = [];
  let dispatches = 0; let preflights = 0;
  const run = async () => ++preflights === 1 ? result() : result({ exitCode: 2, stdoutTail: '{"ok":false,"error":"network_timeout"}' });
  const first = await dispatchGrokSegment(evidence, () => persisted.push(structuredClone(evidence)), capabilities,
    async () => { dispatches += 1; return 'first'; }, { run });
  assert.equal(first, 'first'); assert.equal(evidence.paidSegmentsAttempted, 1); assert.equal(dispatches, 1);
  await assert.rejects(() => dispatchGrokSegment(evidence, () => persisted.push(structuredClone(evidence)), capabilities,
    async () => { dispatches += 1; return 'second'; }, { run }), /network_timeout/);
  assert.equal(evidence.paidSegmentsAttempted, 1); assert.equal(dispatches, 1); assert.equal(evidence.networkPreflights.length, 2);
  assert.deepEqual(evidence.networkPreflights.map((item: any) => [item.segment, item.passed]), [[1, true], [2, false]]);
  assert.ok(persisted.some(item => item.networkPreflights?.at(-1)?.passed === false && item.paidSegmentsAttempted === 1));
});

test('Grok segment gate refuses missing or relative capability binding before process or dispatch', async () => {
  for (const invalid of [{ ...capabilities, distro: '' }, { ...capabilities, nodePath: 'relative/node' }]) {
    let processes = 0; let dispatches = 0;
    await assert.rejects(() => dispatchGrokSegment({ paidSegmentsAttempted: 0 }, () => undefined, invalid as CursorWriteCapabilities,
      async () => { dispatches += 1; }, { run: async () => { processes += 1; return result(); } }));
    assert.equal(processes, 0); assert.equal(dispatches, 0);
  }
});

test('Grok segment gate rejects a frozen candidate without regular resolv support before accounting or dispatch', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'grok-old-runtime-'));
  try {
    const runtimeFile = path.join(root, 'cursor-writer-runtime.mjs'); writeFileSync(runtimeFile, 'old strict symlink runtime');
    const evidence: Record<string, any> = { paidSegmentsAttempted: 0 }; let dispatches = 0;
    await assert.rejects(() => dispatchGrokSegment(evidence, () => undefined, capabilities,
      async () => { dispatches += 1; }, { runtimeFile, run: async () => result() }), /candidate_resolv_layout_unsupported/);
    assert.equal(evidence.paidSegmentsAttempted, 0); assert.equal(dispatches, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Grok network preflight fails closed for timeout, malformed output, cancellation and unknown exit', async () => {
  for (const bad of [
    result({ exitCode: 2, stdoutTail: '{"ok":false,"error":"network_timeout"}' }),
    result({ stdoutTail: 'not-json' }),
    result({ exitCode: null, cancelled: true }),
    result({ exitCode: null }),
    result({ terminationWarning: 'process tree unknown' }),
  ]) {
    const checked = await runGrokNetworkPreflight(capabilities, { run: async () => bad });
    assert.equal(checked.passed, false); assert.ok(checked.failure);
  }
});
