import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadChatRunners } from '../src/chat/bootstrap.js';
import type { CommandRunner, RunnerCommandInfo } from '../src/chat/runner-contract.js';
import { RunnerRouter } from '../src/chat/runner-router.js';
import type { CommandSpec, RunnerResult } from '../src/chat/runner.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const spec = (platform: CommandSpec['platform']): CommandSpec => ({ executable: `${platform}-node`, args: [], cwd: '.', timeoutMs: 5000, network: 'none', platform });
const success = (ticketId: string): RunnerResult => ({ ticketId, command: [], removedEnv: [], exitCode: 0, signal: null, timedOut: false, cancelled: false, spawnError: null, stdoutTail: '', stderrTail: '', durationMs: 1, pid: null });

function backend(platform: CommandSpec['platform'], shared: { running: number; max: number; releases: (() => void)[]; starts: string[] }): CommandRunner {
  return {
    capability: { platform },
    issueTicket: () => randomUUID(),
    async run(ticketId) {
      shared.starts.push(platform); shared.running++; shared.max = Math.max(shared.max, shared.running);
      await new Promise<void>(resolve => shared.releases.push(resolve)); shared.running--;
      return success(ticketId);
    },
    commandInfo: (): RunnerCommandInfo[] => [{ platform, executablePaths: [`${platform}-node`], network: 'none', writableScope: 'derived-test-copy' }],
  };
}

test('Windows 与 WSL 共享两个槽；命令按平台路由并公布已验证程序', async () => {
  const shared = { running: 0, max: 0, releases: [] as (() => void)[], starts: [] as string[] };
  const router = new RunnerRouter({ windows: backend('windows', shared), linux: backend('linux', shared) });
  const jobs = ['windows', 'linux', 'windows', 'linux'].map(platform => router.run(router.issueTicket('inv', spec(platform as CommandSpec['platform']), '.'), 'inv'));
  await tick(); assert.equal(shared.running, 2); assert.deepEqual(shared.starts, ['windows', 'linux']);
  shared.releases.shift()!(); await tick(); assert.equal(shared.running, 2); assert.deepEqual(shared.starts, ['windows', 'linux', 'windows']);
  shared.releases.shift()!(); await tick(); assert.equal(shared.running, 2);
  shared.releases.splice(0).forEach(resolve => resolve()); await Promise.all(jobs);
  assert.equal(shared.max, 2); assert.equal(shared.running, 0);
  assert.deepEqual(router.commandInfo().map(info => info.platform), ['windows', 'linux']);
});

test('排队取消不启动后端、不占用或泄漏槽；票据身份和单次消费受保护', async () => {
  const shared = { running: 0, max: 0, releases: [] as (() => void)[], starts: [] as string[] };
  const router = new RunnerRouter({ windows: backend('windows', shared) }, 'windows', 1);
  const firstTicket = router.issueTicket('inv', spec('windows'), '.');
  await assert.rejects(router.run(firstTicket, 'other'), /身份/);
  const first = router.run(firstTicket, 'inv'); await tick();
  await assert.rejects(router.run(firstTicket, 'inv'), /已消费/);
  const abort = new AbortController(); const cancelledTicket = router.issueTicket('inv', spec('windows'), '.');
  const cancelled = router.run(cancelledTicket, 'inv', abort.signal); const checked = assert.rejects(cancelled, /取消/); abort.abort(); await checked;
  const last = router.run(router.issueTicket('inv', spec('windows'), '.'), 'inv');
  shared.releases.shift()!(); await first; await tick();
  assert.equal(shared.starts.length, 2); assert.equal(shared.running, 1);
  shared.releases.shift()!(); await last; assert.equal(shared.running, 0);
  assert.throws(() => router.issueTicket('inv', spec('linux'), '.'), /不可用/);
  assert.throws(() => new RunnerRouter({}, undefined), /没有可用/);
});

test('启动只载入证明；缺失或损坏的双平台证明保持不可用', t => {
  const base = path.join(process.cwd(), 'work'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'chat-runner-load-'));
  t.after(() => { assert.equal(path.dirname(root), base); rmSync(root, { recursive: true, force: true }); });
  mkdirSync(path.join(root, 'work')); mkdirSync(path.join(root, 'capabilities'));
  let loaded = loadChatRunners(root);
  assert.equal(loaded.runner, undefined); assert.equal(loaded.availability.platforms.length, 2);
  writeFileSync(path.join(root, 'capabilities', 'runner-windows.json'), '{"verified":true}');
  writeFileSync(path.join(root, 'capabilities', 'runner-wsl.json'), '{"verified":true}');
  loaded = loadChatRunners(root);
  assert.equal(loaded.runner, undefined); assert.deepEqual(loaded.availability.commands, []);
  assert.ok(loaded.availability.platforms.every(platform => !platform.available && platform.reason));
});
