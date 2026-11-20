import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { SandboxRunner, validateSandboxCapability, type CommandSpec, type SandboxCapability } from '../src/chat/runner.js';
import { tempDir } from './helpers.js';

const fileHash = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

function fixture() {
  const root = tempDir('chat-runner-');
  const work = path.join(root, 'work'); mkdirSync(work);
  const policy = path.join(root, 'policy.json'); writeFileSync(policy, '{"network":"none"}\n');
  const wrapper = path.join(root, 'wrapper.cjs');
  writeFileSync(wrapper, [
    "const {spawnSync}=require('node:child_process');",
    "const i=process.argv.indexOf('--');",
    "if(i<0) process.exit(90);",
    "const r=spawnSync(process.argv[i+1],process.argv.slice(i+2),{cwd:process.cwd(),env:process.env,encoding:'utf8'});",
    "process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??91);",
  ].join(''));
  const target = path.join(root, 'target.cjs');
  writeFileSync(target, "process.stdout.write('RUNNER_OK:'+process.argv[2]);\n");
  const capability: SandboxCapability = {
    version: 1, verified: true, verifiedAt: new Date().toISOString(), platform: process.platform === 'win32' ? 'windows' : 'linux',
    wrapper: process.execPath, wrapperSha256: fileHash(process.execPath), wrapperArgs: [wrapper],
    wrapperDependencies: [{ path: wrapper, sha256: fileHash(wrapper) }],
    policyFile: policy, policySha256: fileHash(policy), networkDenied: true, childEscapeDenied: true, credentialReadDenied: true,
    allowedExecutables: [{ path: process.execPath, sha256: fileHash(process.execPath) }], allowedEnv: ['SAFE_VALUE'],
  };
  const spec: CommandSpec = {
    executable: process.execPath, args: [target, 'hello'], cwd: work, env: { SAFE_VALUE: 'ok' }, timeoutMs: 5_000,
    network: 'none', platform: capability.platform,
  };
  return { root, work, policy, wrapper, target, capability, spec };
}

test('未验证、反例缺失与文件哈希漂移时 runner fail closed', () => {
  const f = fixture();
  assert.match(validateSandboxCapability({ ...f.capability, verified: 'false' }) ?? '', /结构无效/);
  assert.match(validateSandboxCapability({ ...f.capability, networkDenied: 'false' }) ?? '', /结构无效/);
  assert.match(validateSandboxCapability({ ...f.capability, version: 2 }) ?? '', /结构无效/);
  assert.match(validateSandboxCapability({ ...f.capability, unexpected: true }) ?? '', /结构无效/);
  assert.match(validateSandboxCapability({ ...f.capability, platform: f.capability.platform === 'windows' ? 'linux' : 'windows' }) ?? '', /平台/);
  assert.match(validateSandboxCapability({ ...f.capability, verified: false }) ?? '', /尚未验证/);
  assert.match(validateSandboxCapability({ ...f.capability, networkDenied: false as true }) ?? '', /反例/);
  writeFileSync(f.policy, '{"network":"changed"}\n');
  assert.match(validateSandboxCapability(f.capability) ?? '', /哈希已漂移/);
  assert.throws(() => new SandboxRunner(f.capability).issueTicket('i-1', f.spec, f.work), /能力不可用/);
});

test('结构化命令只能在已验证副本内使用固定程序与允许环境', () => {
  const f = fixture(); const runner = new SandboxRunner(f.capability);
  assert.throws(() => runner.issueTicket('i-1', { ...f.spec, cwd: f.root }, f.work), /越过/);
  assert.throws(() => runner.issueTicket('i-1', { ...f.spec, env: { OPENAI_API_KEY: 'forbidden' } }, f.work), /环境变量/);
  assert.throws(() => runner.issueTicket('i-1', { ...f.spec, executable: f.target }, f.work), /可执行文件/);
  assert.throws(() => runner.issueTicket('i-1', { ...f.spec, network: 'none', platform: f.capability.platform === 'windows' ? 'linux' : 'windows' }, f.work), /平台/);
});

test('一次性票据绑定 invocation，消费后不能重放', async () => {
  const f = fixture(); const runner = new SandboxRunner(f.capability);
  const ticket = runner.issueTicket('invocation-1', f.spec, f.work);
  await assert.rejects(() => runner.run(ticket, 'other-invocation'), /身份不匹配/);
  const result = await runner.run(ticket, 'invocation-1');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdoutTail, 'RUNNER_OK:hello');
  assert.equal(result.command.includes(f.target), true);
  await assert.rejects(() => runner.run(ticket, 'invocation-1'), /已消费/);
});

test('普通 runner 不把扩展 MCP 的 *_API_KEY 传给受控子进程', async () => {
  const f = fixture();
  const canary = 'dummy-canary-never-a-real-key';
  const target = path.join(f.root, 'env-target.cjs');
  writeFileSync(target, "process.stdout.write(JSON.stringify({safe:process.env.SAFE_VALUE,key:process.env.DMW_EXA_API_KEY}))\n");
  const capability = { ...f.capability, allowedEnv: ['SAFE_VALUE', 'DMW_EXA_API_KEY'] };
  const runner = new SandboxRunner(capability);
  const ticket = runner.issueTicket('env-scrub', { ...f.spec, executable: process.execPath, args: [target], env: { SAFE_VALUE: 'ok', DMW_EXA_API_KEY: canary } }, f.work);
  const result = await runner.run(ticket, 'env-scrub');
  assert.equal(result.exitCode, 0, result.stderrTail);
  assert.deepEqual(JSON.parse(result.stdoutTail), { safe: 'ok' });
  assert.equal(result.removedEnv.includes('DMW_EXA_API_KEY'), true);
  assert.equal(result.removedEnv.some((name) => name.includes(canary)), false);
});

test('wrapper 依赖在签票后漂移，执行前重新核验并拒绝', async () => {
  const f = fixture(); const runner = new SandboxRunner(f.capability);
  const ticket = runner.issueTicket('invocation-2', f.spec, f.work);
  writeFileSync(f.wrapper, 'process.exit(0);\n');
  await assert.rejects(() => runner.run(ticket, 'invocation-2'), /依赖.*漂移/);
});
