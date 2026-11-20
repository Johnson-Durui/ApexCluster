import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadWslTestRunner } from '../src/chat/runner-wsl.js';
import type { CommandSpec } from '../src/chat/runner.js';
import { tempDir } from './helpers.js';

const real = process.env.DMW_RUN_WSL_TESTS === '1';
const workRoot = path.resolve(process.env.DMW_WORK_ROOT ?? 'work');
const proofFile = path.resolve(process.env.DMW_WSL_TEST_PROOF ?? path.join('data', 'capabilities', 'runner-wsl.json'));
const linuxNode = '/opt/cursor-agent/versions/2026.10.22-27dcf5f/node';

test('同步 loader 对缺失或无效 proof 保持 unavailable', () => {
  const root = tempDir('wsl-runner-loader-');
  const missing = loadWslTestRunner(path.join(root, 'missing.json'), { workRootWindows: root });
  assert.equal(missing.runner, null);
  assert.equal(missing.availability.available, false);
  const invalid = path.join(root, 'invalid.json');
  writeFileSync(invalid, '{"verified":true}\n');
  const loaded = loadWslTestRunner(invalid, { workRootWindows: root });
  assert.equal(loaded.runner, null);
  assert.match(loaded.availability.reason ?? '', /proof/i);
  const tooWide = loadWslTestRunner(invalid, { workRootWindows: root, concurrency: 3 });
  assert.equal(tooWide.availability.available, false);
  assert.match(tooWide.availability.reason ?? '', /并发/);
  for (const key of ['DMW_EXA_API_KEY', 'dmw_exa_api_key', 'VENDOR_API_KEY']) {
    const credentialEnv = loadWslTestRunner(invalid, { workRootWindows: root, allowedEnv: ['CI', key] });
    assert.equal(credentialEnv.runner, null);
    assert.match(credentialEnv.availability.reason ?? '', /环境变量允许清单/);
  }
});

test('真实 WSL runner：结构化命令、一次性 caller ticket 与全部运行时反例', { skip: !real }, async () => {
  const root = path.join(workRoot, `wsl-runner-test-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  try {
    const script = path.join(root, 'canary.mjs');
    writeFileSync(script, String.raw`
      import fs from 'node:fs'; import net from 'node:net'; import {spawnSync} from 'node:child_process';
      fs.writeFileSync('/workspace/inside.txt','ok');
      const out={inside:fs.readFileSync('/workspace/inside.txt','utf8')==='ok'};
      try{fs.readFileSync('/home/tester/.config/fake-auth.json');out.fakeCredential=false}catch{out.fakeCredential=true}
      try{fs.writeFileSync('/outside.txt','bad');out.outsideWrite=false}catch{out.outsideWrite=true}
      const shell=spawnSync('/bin/sh',['-c','echo bad']);out.subprocessEscape=Boolean(shell.error)&&shell.error.code==='ENOENT';
      out.networkDenied=await new Promise(resolve=>{const s=net.connect({host:'1.1.1.1',port:53});const done=v=>{s.destroy();resolve(v)};s.setTimeout(700,()=>done(true));s.once('connect',()=>done(false));s.once('error',()=>done(true))});
      process.stdout.write(JSON.stringify(out));
    `);
    const loaded = loadWslTestRunner(proofFile, { workRootWindows: workRoot });
    assert.equal(loaded.availability.available, true, loaded.availability.reason);
    assert.equal(loaded.proof?.outsideSampleHostReadable, true);
    assert.equal(loaded.proof?.outsideSampleHostWritable, true);
    assert.equal(loaded.proof?.fakeCredentialSampleHostReadable, true);
    assert.equal(loaded.proof?.networkControlReachable, true);
    assert.equal(loaded.proof?.childProcessWorks, true);
    assert.equal(loaded.proof?.earlyParentTreeTerminationConfirmed, true);
    assert.equal(loaded.proof?.cancelTreeTerminationConfirmed, true);
    assert.deepEqual(loaded.runner?.commandInfo(), [{ platform: 'linux', executablePaths: [linuxNode], network: 'none', writableScope: 'derived-test-copy' }]);
    const spec: CommandSpec = { executable: linuxNode, args: ['canary.mjs'], cwd: root, timeoutMs: 10_000, network: 'none', platform: 'linux' };
    const ticket = loaded.runner!.issueTicket('invocation-a', spec, root);
    await assert.rejects(() => loaded.runner!.run(ticket, 'invocation-b'), /身份不匹配/);
    const result = await loaded.runner!.run(ticket, 'invocation-a');
    assert.equal(result.exitCode, 0, result.stderrTail);
    assert.equal(result.terminationWarning, undefined);
    assert.deepEqual(JSON.parse(result.stdoutTail), { inside: true, fakeCredential: true, outsideWrite: true, subprocessEscape: true, networkDenied: true });
    assert.equal(existsHost(path.join(root, 'inside.txt')), false, 'guest writes must not mutate the host test snapshot');
    await assert.rejects(() => loaded.runner!.run(ticket, 'invocation-a'), /已消费/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('真实 WSL runner：正常退出与取消均确认 guest 进程树收口', { skip: !real }, async () => {
  const root = path.join(workRoot, `wsl-runner-tree-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  try {
    writeFileSync(path.join(root, 'tree.mjs'), String.raw`
      import {spawn} from 'node:child_process';
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});child.unref();
      if(process.argv[2]==='wait')setInterval(()=>{},1000);else process.stdout.write('parent-done');
    `);
    const loaded = loadWslTestRunner(proofFile, { workRootWindows: workRoot });
    assert.equal(loaded.availability.available, true, loaded.availability.reason);
    const base: CommandSpec = { executable: linuxNode, args: ['tree.mjs', 'exit'], cwd: root, timeoutMs: 10_000, network: 'none', platform: 'linux' };
    const normalTicket = loaded.runner!.issueTicket('normal-tree', base, root);
    const normal = await loaded.runner!.run(normalTicket, 'normal-tree');
    assert.equal(normal.exitCode, 0, normal.stderrTail);
    assert.equal(normal.terminationWarning, undefined);
    const alreadyAborted = new AbortController(); alreadyAborted.abort();
    const alreadyAbortedTicket = loaded.runner!.issueTicket('already-aborted', { ...base, args: ['tree.mjs', 'wait'], timeoutMs: 30_000 }, root);
    await assert.rejects(() => loaded.runner!.run(alreadyAbortedTicket, 'already-aborted', alreadyAborted.signal), /测试请求已取消/);
    const earlyController = new AbortController();
    const earlyTicket = loaded.runner!.issueTicket('early-cancel-tree', { ...base, args: ['tree.mjs', 'wait'], timeoutMs: 30_000 }, root);
    const earlyPending = loaded.runner!.run(earlyTicket, 'early-cancel-tree', earlyController.signal);
    setTimeout(() => earlyController.abort(), 1);
    const earlyCancelled = await earlyPending;
    assert.equal(earlyCancelled.cancelled, true);
    assert.equal(earlyCancelled.terminationWarning, undefined, earlyCancelled.stderrTail);
    const controller = new AbortController();
    const cancelTicket = loaded.runner!.issueTicket('cancel-tree', { ...base, args: ['tree.mjs', 'wait'], timeoutMs: 30_000 }, root);
    const pending = loaded.runner!.run(cancelTicket, 'cancel-tree', controller.signal);
    setTimeout(() => controller.abort(), 800);
    const cancelled = await pending;
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.terminationWarning, undefined, cancelled.stderrTail);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('真实 WSL runner 在 guest 工具哈希漂移时于不可信代码前拒绝', { skip: !real }, async () => {
  const root = path.join(workRoot, `wsl-runner-drift-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  try {
    writeFileSync(path.join(root, 'must-not-run.mjs'), "process.stdout.write('UNTRUSTED_RAN')\n");
    const original = JSON.parse(readFileSync(proofFile, 'utf8')) as Record<string, unknown>;
    for (const [name, change] of [
      ['version', { version: 2 }], ['policy', { policySha256: '0'.repeat(64) }],
      ['runtime', { runtimeSha256: '0'.repeat(64) }], ['host-runner', { hostRunnerSha256: '0'.repeat(64) }],
    ] as const) {
      const invalidProof = path.join(root, `${name}-proof.json`);
      writeFileSync(invalidProof, `${JSON.stringify({ ...original, ...change })}\n`);
      const invalid = loadWslTestRunner(invalidProof, { workRootWindows: workRoot });
      assert.equal(invalid.availability.available, false, `${name} drift must fail closed`);
    }
    const driftProof = path.join(root, 'drift-proof.json');
    const proof = { ...original };
    proof.nodeSha256 = '0'.repeat(64);
    writeFileSync(driftProof, `${JSON.stringify(proof)}\n`);
    const loaded = loadWslTestRunner(driftProof, { workRootWindows: workRoot });
    assert.equal(loaded.availability.available, true, loaded.availability.reason);
    const spec: CommandSpec = { executable: linuxNode, args: ['must-not-run.mjs'], cwd: root, timeoutMs: 10_000, network: 'none', platform: 'linux' };
    const ticket = loaded.runner!.issueTicket('drift', spec, root);
    const result = await loaded.runner!.run(ticket, 'drift');
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.stdoutTail.includes('UNTRUSTED_RAN'), false);
    assert.match(result.stderrTail, /bound tool drifted/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function existsHost(file: string): boolean {
  try { readFileSync(file); return true; } catch { return false; }
}
