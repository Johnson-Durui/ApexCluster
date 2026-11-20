import { spawn, type ChildProcessByStdio } from 'node:child_process';
import assert from 'node:assert/strict';
import fs, { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { writeFileAtomicSync } from '../src/orchestrator/store.js';
import { tempDir } from './helpers.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hold-file.ps1');

function windowsPowerShell(): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function waitForReady(child: ChildProcessByStdio<null, Readable, Readable>, stdout: { value: string }, stderr: { value: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => finish(new Error(`等待文件锁 READY 超时；stdout=${stdout.value}; stderr=${stderr.value}`)), 10_000);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      error ? reject(error) : resolve();
    };
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout.value += chunk.toString();
      if (stdout.value.split(/\r?\n/).includes('READY')) finish();
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr.value += chunk.toString();
    });
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => finish(new Error(`文件锁进程在 READY 前退出：code=${code}, signal=${signal}; stderr=${stderr.value}`)));
  });
}

interface ProcessCompletion {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

function waitForCompletion(child: ChildProcessByStdio<null, Readable, Readable>, timeoutMs = 5000): Promise<ProcessCompletion> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => finish(undefined, new Error('等待文件锁进程结束超时')), timeoutMs);
    const finish = (result?: ProcessCompletion, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      error ? reject(error) : resolve(result!);
    };
    child.once('error', (error) => finish({ code: null, signal: null, error }));
    child.once('exit', (code, signal) => finish({ code, signal }));
    child.once('close', (code, signal) => finish({ code, signal }));
  });
}

test('Windows：目标文件被禁止删除的共享句柄占用时，原子写入会重试并在解锁后成功', { skip: process.platform !== 'win32', timeout: 15_000 }, async (t: TestContext) => {
  const dir = tempDir('dmw-windows-store-');
  const target = path.join(dir, 'run.json');
  const releaseRequest = path.join(dir, 'release-request.txt');
  const released = path.join(dir, 'released.txt');
  const oldContent = '{"version":"old"}\n';
  const newContent = '{"version":"new","text":"中文 ✅"}\n';
  writeFileSync(target, oldContent, 'utf8');

  const stdout = { value: '' };
  const stderr = { value: '' };
  const child = spawn(
    windowsPowerShell(),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixture, target, releaseRequest, released],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const completed = waitForCompletion(child);
  const realRenameSync = fs.renameSync;
  let retryableRenameFailure: NodeJS.ErrnoException | null = null;

  try {
    await waitForReady(child, stdout, stderr);

    assert.equal(readFileSync(target, 'utf8'), oldContent, '取得锁后、开始原子写入前必须仍是旧内容');
    assert.throws(
      () => unlinkSync(target),
      (error: unknown) => error instanceof Error && ['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? ''),
      '共享句柄必须真实禁止删除，避免测试在未取得有效锁时误通过',
    );
    assert.equal(readFileSync(target, 'utf8'), oldContent, '删除被拒绝后旧内容必须保持不变');

    t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
      try {
        return realRenameSync(...args);
      } catch (error) {
        const errno = error as NodeJS.ErrnoException;
        if (['EPERM', 'EACCES', 'EBUSY'].includes(errno.code ?? '')) {
          retryableRenameFailure = errno;
          writeFileSync(releaseRequest, errno.code ?? 'retryable', 'utf8');
        }
        throw error;
      }
    });
    syncBuiltinESMExports();

    writeFileAtomicSync(target, newContent);

    const result = await completed;
    assert.ok(retryableRenameFailure, '必须先真实观察到至少一次可重试 rename 失败，fixture 才能释放锁');
    assert.deepEqual(result, { code: 0, signal: null }, `锁进程应正常退出；stderr=${stderr.value}`);
    assert.equal(existsSync(released), true, '原子替换成功前，锁进程应已明确释放句柄');
    assert.equal(readFileSync(target, 'utf8'), newContent, '解锁后必须准确写入全部新内容');
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.endsWith('.tmp')),
      [],
      '成功后不应残留原子写入临时文件',
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await completed;
  }
});
