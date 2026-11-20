import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveCommand } from '../src/adapters/process.js';
import { createWindowsMxcRunner, WindowsMxcRunner, type WindowsMxcCapability } from '../src/chat/runner-windows.js';
import { tempDir } from './helpers.js';

const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const runnerSource = fileURLToPath(new URL('../src/chat/runner-windows.ts', import.meta.url));
const policyHash = (profile: string, roots: string[]) => createHash('sha256').update(JSON.stringify({ version: 'windows-mxc-v2', profile, filesystem: [':root=deny', ':minimal=read', ':workspace_roots=write', ':ticket_root=read', ...roots.map(root => `${path.resolve(root)}=read`)], network: false, webSearch: 'disabled', probe: 'loopback-listener+explicit-denials+detached-tree-v2' })).digest('hex');
function proof(codexPath: string): WindowsMxcCapability {
  const readonlyRoots = [{ path: path.dirname(process.execPath) }]; const profile = 'workbench-runner-test';
  return { version: 3, verified: true, verifiedAt: new Date().toISOString(), policyVersion: 'windows-mxc-v2', policySha256: policyHash(profile, readonlyRoots.map(root => root.path)), codexVersion: 'test-codex-version', codex: { path: codexPath, sha256: hash(codexPath) }, runnerCode: { path: runnerSource, sha256: hash(runnerSource) }, profile, allowedExecutable: { path: process.execPath, sha256: hash(process.execPath) }, readonlyRoots, allowedEnv: ['LANG'], tests: { insideRead: true, insideWrite: true, outsideReadDenied: true, outsideWriteDenied: true, credentialReadDenied: true, networkDenied: true, childProcessWorks: true, childEscapeDenied: true, normalTreeConfirmed: true, cancelTreeConfirmed: true, runnerModuleVerified: true } };
}

function nativeProof(t: TestContext): WindowsMxcCapability | undefined {
  if (process.platform !== 'win32') { t.skip('Windows only'); return; }
  const codex = resolveCommand('codex');
  if (!codex || codex.prefixArgs.length || codex.via === 'cmd-fallback') {
    t.skip('Requires a directly executable Codex CLI for native Windows MXC');
    return;
  }
  return proof(codex.file);
}

test('Windows MXC ticket is invocation-bound, one-shot, and hash-gated', async t => {
  const native = nativeProof(t);
  if (!native) return;
  const root = tempDir('mxc-runner-'); const runner = new WindowsMxcRunner(native);
  assert.equal(runner.availability.available, true);
  const spec = { executable: process.execPath, args: ['-e', 'process.stdout.write("ok")'], cwd: root, timeoutMs: 10_000, network: 'none' as const, platform: 'windows' as const };
  const ticket = runner.issueTicket('invocation-a', spec, root);
  await assert.rejects(runner.run(ticket, 'invocation-b'), /票据/);
  const result = await runner.run(ticket, 'invocation-a');
  assert.equal(result.exitCode, 0, result.stderrTail); assert.equal(result.stdoutTail.trim(), 'ok', result.stderrTail); assert.equal(result.terminationWarning, undefined);
  await assert.rejects(runner.run(ticket, 'invocation-a'), /票据/);
});
test('Windows MXC refuses missing evidence, credentials and the wrong invocation before dispatch', async t => {
  if (process.platform !== 'win32') { t.skip('Windows only'); return; }
  // These checks stop before spawn, so the local Node binary supplies a stable file hash.
  const fixtureProof = () => proof(process.execPath);
  const weak = fixtureProof(); weak.tests.networkDenied = false; const root = tempDir('mxc-runner-');
  assert.equal(new WindowsMxcRunner(weak).availability.available, false);
  const stalePolicy = fixtureProof(); stalePolicy.policyVersion = 'windows-mxc-v0' as 'windows-mxc-v2';
  assert.equal(new WindowsMxcRunner(stalePolicy).availability.available, false);
  const staleHash = fixtureProof(); staleHash.codex.sha256 = '0'.repeat(64);
  assert.equal(new WindowsMxcRunner(staleHash).availability.available, false);
  const staleRunner = fixtureProof(); staleRunner.runnerCode.sha256 = '0'.repeat(64);
  assert.equal(new WindowsMxcRunner(staleRunner).availability.available, false);
  const genericApiKey = fixtureProof(); genericApiKey.allowedEnv = ['DMW_EXA_API_KEY'];
  assert.equal(new WindowsMxcRunner(genericApiKey).availability.available, false);
  const runner = new WindowsMxcRunner(fixtureProof());
  const spec = { executable: process.execPath, args: [], cwd: root, timeoutMs: 1, network: 'none' as const, platform: 'windows' as const };
  assert.throws(() => runner.issueTicket('invocation', { ...spec, env: { OPENAI_API_KEY: 'never' } }, root), /环境变量/);
  const ticket = runner.issueTicket('invocation', spec, root);
  await assert.rejects(runner.run(ticket, 'other-invocation'), /票据/);
});
test('Windows MXC cancellation confirms the sandbox process tree exit', async t => {
  const native = nativeProof(t);
  if (!native) return;
  const root = tempDir('mxc-runner-cancel-'); const runner = new WindowsMxcRunner(native);
  const marker = path.join(root, 'cancel-child.json'); const token = 'cancel-test-token'; const controller = new AbortController();
  const program = `const fs=require('fs'),{spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});c.unref();fs.writeFileSync(process.argv[1],JSON.stringify({pid:c.pid,token:process.argv[2]}));setInterval(()=>{},1000)`;
  const ticket = runner.issueTicket('invocation-cancel', { executable: process.execPath, args: ['-e', program, marker, token], cwd: root, timeoutMs: 20_000, network: 'none', platform: 'windows' }, root);
  const pending = runner.run(ticket, 'invocation-cancel', controller.signal);
  const started = await new Promise<boolean>(resolve => { const deadline = Date.now() + 2_000; const poll = () => { if (existsSync(marker)) { resolve(true); return; } if (Date.now() > deadline) { resolve(false); return; } setTimeout(poll, 25); }; poll(); }); assert.equal(started, true);
  const child = JSON.parse(readFileSync(marker, 'utf8')); assert.equal(child.token, token); controller.abort(); const result = await pending;
  let gone = false; const deadline = Date.now() + 2_000; while (Date.now() < deadline && !gone) { try { process.kill(child.pid, 0); await new Promise(resolve => setTimeout(resolve, 25)); } catch (error) { gone = (error as NodeJS.ErrnoException).code === 'ESRCH'; } }
  assert.equal(result.cancelled, true); assert.equal(result.terminationWarning, undefined); assert.equal(gone, true, 'cancel left detached child alive');
});
test('Windows MXC preserves a ticket subdirectory cwd and grants parent copy read-only', async t => {
  const native = nativeProof(t);
  if (!native) return;
  const root = tempDir('mxc-runner-cwd-'); const cwd = path.join(root, 'nested'); mkdirSync(cwd); const parentFile = path.join(root, 'parent.txt'); writeFileSync(parentFile, 'parent');
  const runner = new WindowsMxcRunner(native); const command = `const fs=require('fs'),path=require('path');const ok=process.cwd()===process.argv[1]&&fs.readFileSync(process.argv[2],'utf8')==='parent';process.stdout.write(String(ok));`;
  const ticket = runner.issueTicket('invocation-cwd', { executable: process.execPath, args: ['-e', command, cwd, parentFile], cwd, timeoutMs: 10_000, network: 'none', platform: 'windows' }, root);
  const result = await runner.run(ticket, 'invocation-cwd'); assert.equal(result.exitCode, 0, result.stderrTail); assert.equal(result.stdoutTail.trim(), 'true');
});
test('Windows MXC runs a relative Node entry with a relative module and child file', async t => {
  const native = nativeProof(t);
  if (!native) return;
  const root = tempDir('mxc-runner-files-'); const cwd = path.join(root, 'nested'); mkdirSync(cwd);
  writeFileSync(path.join(cwd, 'module.cjs'), 'module.exports="module-ok"');
  writeFileSync(path.join(cwd, 'child.cjs'), 'process.stdout.write("child-ok")');
  writeFileSync(path.join(cwd, 'check.cjs'), 'const {spawnSync}=require("child_process");const r=spawnSync(process.execPath,["child.cjs"],{cwd:process.cwd(),encoding:"utf8"});process.stdout.write(String(process.cwd()===process.argv[2])+":"+require("./module.cjs")+":"+(r.stdout||""))');
  const runner = new WindowsMxcRunner(native); const ticket = runner.issueTicket('invocation-files', { executable: process.execPath, args: ['check.cjs', cwd], cwd, timeoutMs: 10_000, network: 'none', platform: 'windows' }, root);
  const result = await runner.run(ticket, 'invocation-files'); assert.equal(result.exitCode, 0, result.stderrTail); assert.equal(result.stdoutTail.trim(), 'true:module-ok:child-ok');
});
test('Windows MXC factory rejects malformed proof without throwing', () => {
  assert.equal(createWindowsMxcRunner(null), null);
  assert.equal(createWindowsMxcRunner({ version: 3, readonlyRoots: ['C:\\Users'] }), null);
});
test('Windows MXC normal parent exit also closes its child tree', async t => {
  const native = nativeProof(t);
  if (!native) return;
  const root = tempDir('mxc-runner-tree-'); const marker = path.join(root, 'child.pid'); const runner = new WindowsMxcRunner(native);
  const parent = `const fs=require('fs'),{spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});c.unref();fs.writeFileSync(process.argv[1],String(c.pid));process.exit(0)`;
  const ticket = runner.issueTicket('invocation-tree', { executable: process.execPath, args: ['-e', parent, marker], cwd: root, timeoutMs: 10_000, network: 'none', platform: 'windows' }, root);
  const result = await runner.run(ticket, 'invocation-tree'); assert.equal(result.exitCode, 0, result.stderrTail);
  const pid = Number(readFileSync(marker, 'utf8')); await new Promise(resolve => setTimeout(resolve, 300));
  let alive = true; try { process.kill(pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  if (alive) { try { process.kill(pid); } catch { /* already gone */ } }
  assert.equal(alive, false, `normal MXC parent exit left child ${pid} running`);
});
