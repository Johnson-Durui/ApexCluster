import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { WindowsJobAppServerProcess } from '../src/chat/windows-job-app-server.js';
import { tempDir } from './helpers.js';

const supervisor = process.env.DMW_WINDOWS_JOB_SUPERVISOR;
function exactLengthDirectory(length: number, prefix: string): string {
  let directory = tempDir(prefix);
  while (directory.length < length) { const size = Math.min(40, length - directory.length - 1); assert.ok(size > 0); directory = path.join(directory, 'x'.repeat(size)); mkdirSync(directory); }
  assert.equal(directory.length, length); return directory;
}

test('interactive Job app-server preserves JSONL stdio and confirms stop', { skip: !supervisor || !existsSync(supervisor) }, async () => {
  const directory = tempDir('dmw-job-app-server-'); const fake = path.join(directory, 'fake.mjs');
  writeFileSync(fake, `import readline from 'node:readline'; readline.createInterface({input:process.stdin}).on('line', line => { const v=JSON.parse(line); console.log(JSON.stringify({id:v.id,result:{ok:true}})); }); setInterval(()=>{},1000);`);
  const child = new WindowsJobAppServerProcess({ file: process.execPath, prefixArgs: [fake], via: 'config' }, [], { cwd: directory, env: process.env, receiptDirectory: directory, supervisorPath: supervisor! });
  const response = new Promise<any>((resolve, reject) => createInterface({ input: child.stdout }).once('line', line => { try { resolve(JSON.parse(line)); } catch (error) { reject(error); } }));
  child.stdin.write(`${JSON.stringify({ id: 7, method: 'ping' })}\n`);
  assert.deepEqual(await response, { id: 7, result: { ok: true } }); assert.equal(await child.stop(), true);
});

test('interactive Job app-server pre-stop never executes target code', { skip: !supervisor || !existsSync(supervisor) }, async () => {
  const directory = tempDir('dmw-job-app-server-prestop-'); const marker = path.join(directory, 'must-not-exist'); const fake = path.join(directory, 'fake.mjs');
  writeFileSync(fake, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran'); setInterval(()=>{},1000);`);
  const child = new WindowsJobAppServerProcess({ file: process.execPath, prefixArgs: [fake], via: 'config' }, [], { cwd: directory, env: process.env, receiptDirectory: directory, supervisorPath: supervisor! });
  assert.equal(await child.stop(), true); assert.equal(existsSync(marker), false);
});

test('interactive Job app-server confirms cancellation while a request is pending', { skip: !supervisor || !existsSync(supervisor) }, async () => {
  const directory = tempDir('dmw-job-app-server-pending-'); const fake = path.join(directory, 'fake.mjs');
  writeFileSync(fake, `process.stdin.resume(); setInterval(()=>{},1000);`);
  const child = new WindowsJobAppServerProcess({ file: process.execPath, prefixArgs: [fake], via: 'config' }, [], { cwd: directory, env: process.env, receiptDirectory: directory, supervisorPath: supervisor! });
  child.stdin.write(`${JSON.stringify({ id: 1, method: 'pending' })}\n`);
  assert.equal(await child.stop(), true); assert.equal(child.evidence().cancelReceived, true);
});

test('interactive Job app-server reports helper crash as unconfirmed while Job close removes targets', { skip: !supervisor || !existsSync(supervisor) }, async () => {
  const directory = tempDir('dmw-job-app-server-helper-crash-'); const fake = path.join(directory, 'fake.mjs'); let target = 0;
  writeFileSync(fake, `console.log(process.pid); setInterval(()=>{},1000);`);
  const child = new WindowsJobAppServerProcess({ file: process.execPath, prefixArgs: [fake], via: 'config' }, [], { cwd: directory, env: process.env, receiptDirectory: directory, supervisorPath: supervisor! });
  await new Promise<void>(resolve => createInterface({ input: child.stdout }).once('line', line => { target = Number(line); resolve(); }));
  assert.ok(child.helperPid); process.kill(child.helperPid!);
  assert.equal(await child.stop(), false); assert.equal(child.evidence().confirmed, false); assert.throws(() => process.kill(target, 0));
});

test('interactive Job app-server normal and pending cancel succeed from a 208-character private control directory', { skip: !supervisor || !existsSync(supervisor) }, async () => {
  const receiptDirectory = exactLengthDirectory(208, 'dmw-job-app-long-'); const fake = path.join(tempDir('dmw-job-app-code-'), 'fake.mjs');
  writeFileSync(fake, `import readline from 'node:readline';readline.createInterface({input:process.stdin}).on('line',line=>console.log(JSON.stringify({id:JSON.parse(line).id,result:{ok:true}})));setInterval(()=>{},1000);`);
  const normal = new WindowsJobAppServerProcess({ file: process.execPath, prefixArgs: [fake], via: 'config' }, [], { cwd: path.dirname(fake), env: process.env, receiptDirectory, supervisorPath: supervisor! });
  const response = new Promise<void>(resolve => createInterface({ input: normal.stdout }).once('line', () => resolve())); normal.stdin.write('{"id":1}\n'); await response; assert.equal(await normal.stop(), true);
  const pending = new WindowsJobAppServerProcess({ file: process.execPath, prefixArgs: [fake], via: 'config' }, [], { cwd: path.dirname(fake), env: process.env, receiptDirectory, supervisorPath: supervisor! });
  pending.stdin.write('{"id":2}\n'); assert.equal(await pending.stop(), true); assert.equal(pending.evidence().cancelReceived, true);
});

test('interactive Job app-server rejects a 213-character control directory before target dispatch', { skip: !supervisor || !existsSync(supervisor) }, () => {
  const receiptDirectory = exactLengthDirectory(213, 'dmw-job-app-too-long-'); const marker = path.join(tempDir('dmw-job-app-marker-'), 'must-not-exist'); const fake = path.join(tempDir('dmw-job-app-code-'), 'fake.mjs');
  writeFileSync(fake, `require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`);
  assert.throws(() => new WindowsJobAppServerProcess({ file: process.execPath, prefixArgs: [fake], via: 'config' }, [], { cwd: path.dirname(fake), env: process.env, receiptDirectory, supervisorPath: supervisor! }), /legacy safe limit/);
  assert.equal(existsSync(marker), false);
});
