import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { startWorkbench } from '../src/server/main.js';
import { makeHarness, runInput, tempDir } from './helpers.js';

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runBackground(script: string, nodePath: string, cwd: string): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      backgroundArgs(script, nodePath),
      { cwd, encoding: 'utf8', timeout: 15_000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && !('code' in error)) return reject(error);
        resolve({
          code: error && typeof error.code === 'number' ? error.code : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

function backgroundArgs(script: string, nodePath: string): string[] {
  return [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-Action',
    'Run',
    '-NodePath',
    nodePath,
  ];
}

async function waitUntil(check: () => boolean, message: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(check(), true, message);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processStartTicks(pid: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks.ToString()`],
      { encoding: 'utf8', windowsHide: true },
      (error, stdout) => error ? reject(error) : resolve(stdout.trim()),
    );
  });
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as T;
}

function snapshotFiles(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!existsSync(root)) return result;
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else result[path.relative(root, full)] = readFileSync(full, 'utf8');
    }
  };
  visit(root);
  return result;
}

function createFakeProject(prefix: string, port: number, fakeLoader: string) {
  const root = tempDir(prefix);
  const project = path.join(root, '中文 工作台');
  const scripts = path.join(project, 'scripts');
  const cliDir = path.join(project, 'node_modules', 'tsx', 'dist');
  const dataDir = path.join(project, 'data');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(cliDir, { recursive: true });
  mkdirSync(path.join(project, 'src', 'server'), { recursive: true });
  mkdirSync(path.join(project, 'web', 'dist'), { recursive: true });
  mkdirSync(path.join(project, 'config'), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  copyFileSync(path.join(process.cwd(), 'scripts', 'background.ps1'), path.join(scripts, 'background.ps1'));
  writeFileSync(path.join(project, 'web', 'dist', 'index.html'), '<!doctype html>', 'utf8');
  writeFileSync(path.join(cliDir, 'loader.mjs'), fakeLoader, 'utf8');
  writeFileSync(path.join(project, 'src', 'server', 'main.ts'), '', 'utf8');
  // 生产配置使用绝对 dataDir；后台脚本必须保留它，不能再次拼接 projectDir。
  writeFileSync(path.join(project, 'config', 'workbench.config.json'), JSON.stringify({ port, dataDir }), 'utf8');
  writeFileSync(path.join(dataDir, 'existing-record.json'), '{"status":"running","note":"保留原记录"}\n', 'utf8');
  return { root, project, dataDir, script: path.join(scripts, 'background.ps1') };
}

test('Windows：后台子进程异常退出会保留数据并写入 stdout、runtime 与 lifecycle', { skip: process.platform !== 'win32', timeout: 20_000 }, async () => {
  const port = await unusedPort();
  const fixture = createFakeProject(
    'dmw-background-退出 中文 空格-',
    port,
    [
      "import path from 'node:path';",
      "console.log('FAKE_TSX:' + JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(1).map(value => path.relative(process.cwd(), value)) }));",
      'process.exit(7);',
    ].join('\n'),
  );
  const before = snapshotFiles(fixture.dataDir);

  const result = await runBackground(fixture.script, process.execPath, fixture.root);

  assert.notEqual(result.code, 0, `后台包装器必须把子进程退出视为失败\n${result.stdout}\n${result.stderr}`);
  assert.deepEqual(snapshotFiles(fixture.dataDir), before, '包装器不得恢复或改写现有任务记录');

  const logs = path.join(fixture.project, 'work', 'background-service');
  const runtime = readJson<{ WrapperPid: number; ServerPid: number; Stdout: string; Stderr: string }>(path.join(logs, 'runtime.json'));
  assert.ok(Number.isInteger(runtime.WrapperPid));
  assert.ok(Number.isInteger(runtime.ServerPid));
  assert.equal(path.dirname(runtime.Stdout), logs);
  assert.equal(path.dirname(runtime.Stderr), logs);
  assert.ok(existsSync(runtime.Stdout), '必须保留服务标准输出');
  assert.ok(existsSync(runtime.Stderr), '必须保留服务标准错误');
  assert.match(readFileSync(path.join(logs, 'lifecycle.log'), 'utf8'), /server exited: 7/);

  const marker = readFileSync(runtime.Stdout, 'utf8').split(/\r?\n/).find(line => line.startsWith('FAKE_TSX:'));
  assert.ok(marker, '必须实际执行复制项目里的假 tsx');
  const seen = JSON.parse(marker.slice('FAKE_TSX:'.length)) as { cwd: string; argv: string[] };
  assert.equal(path.resolve(seen.cwd), path.resolve(fixture.project));
  assert.deepEqual(seen.argv, ['src\\server\\main.ts']);
});

test('Windows：端口已占用时不会执行 tsx 或改写现有任务记录', { skip: process.platform !== 'win32', timeout: 20_000 }, async t => {
  const occupied = createServer();
  await new Promise<void>((resolve, reject) => {
    occupied.once('error', reject);
    occupied.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise<void>(resolve => occupied.close(() => resolve())));
  const address = occupied.address();
  assert.ok(address && typeof address !== 'string');

  const fixture = createFakeProject(
    'dmw-background-占用 中文 空格-',
    address.port,
    [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync('FAKE_TSX_EXECUTED', 'yes');",
      "writeFileSync('data/existing-record.json', 'changed');",
      'process.exit(0);',
    ].join('\n'),
  );
  const before = snapshotFiles(fixture.dataDir);

  const result = await runBackground(fixture.script, process.execPath, fixture.root);

  assert.notEqual(result.code, 0);
  assert.equal(existsSync(path.join(fixture.project, 'FAKE_TSX_EXECUTED')), false, '端口检查必须发生在启动 tsx 之前');
  assert.deepEqual(snapshotFiles(fixture.dataDir), before);
  const logs = path.join(fixture.project, 'work', 'background-service');
  assert.equal(existsSync(path.join(logs, 'runtime.json')), false, '未启动服务时不得生成 runtime');
  assert.match(readFileSync(path.join(logs, 'lifecycle.log'), 'utf8'), new RegExp(`Port ${address.port} is occupied`));
});

test('Windows：接管健康的本机服务，原进程退出后才启动新服务', { skip: process.platform !== 'win32', timeout: 30_000 }, async t => {
  const port = await unusedPort();
  const fixture = createFakeProject(
    'dmw-background-接管 中文 空格-',
    port,
    [
      "import { writeFileSync } from 'node:fs';",
      "import path from 'node:path';",
      "writeFileSync('FAKE_TSX_EXECUTED', JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(1).map(value => path.relative(process.cwd(), value)) }));",
      "console.log('replacement server started');",
      'process.exit(7);',
    ].join('\n'),
  );
  const before = snapshotFiles(fixture.dataDir);
  const healthCode = [
    "const http = require('node:http');",
    "const port = Number(process.argv[1]);",
    "const server = http.createServer((req, res) => {",
    "  if (req.url !== '/api/health') { res.writeHead(404); res.end(); return; }",
    "  res.writeHead(200, { 'content-type': 'application/json' });",
    "  res.end(JSON.stringify({ ok: true, mode: 'local' }));",
    "});",
    "server.listen(port, '127.0.0.1', () => console.log('READY:' + process.pid));",
    "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
  ].join('\n');
  const health = spawn(process.execPath, ['-e', healthCode, String(port)], {
    cwd: fixture.root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.ok(health.pid);
  const ready = await once(health.stdout, 'data') as [Buffer];
  assert.match(ready[0].toString('utf8'), new RegExp(`READY:${health.pid}`));
  const beforeAdoption = await runBackground(fixture.script, process.execPath, fixture.root);
  assert.notEqual(beforeAdoption.code, 0);
  assert.equal(existsSync(path.join(fixture.project, 'FAKE_TSX_EXECUTED')), false);
  assert.deepEqual(snapshotFiles(fixture.dataDir), before);
  const logs = path.join(fixture.project, 'work', 'background-service');
  assert.match(readFileSync(path.join(logs, 'lifecycle.log'), 'utf8'), /explicit adoption is required/);

  const ticks = await processStartTicks(health.pid!);
  assert.match(ticks, /^\d+$/);
  const adoptionFile = path.join(logs, 'adopt-once.json');
  // .NET ticks 超过 JS 安全整数范围，凭据按字符串保存，避免 JSON 往返损失精度。
  writeFileSync(adoptionFile, `{"ServerPid":${health.pid},"ServerStartedAtTicks":"${ticks}"}`, 'utf8');

  const wrapper = spawn('powershell.exe', backgroundArgs(fixture.script, process.execPath), {
    cwd: fixture.root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let wrapperStdout = '';
  let wrapperStderr = '';
  wrapper.stdout.setEncoding('utf8').on('data', chunk => { wrapperStdout += String(chunk); });
  wrapper.stderr.setEncoding('utf8').on('data', chunk => { wrapperStderr += String(chunk); });
  t.after(async () => {
    if (wrapper.exitCode === null && wrapper.pid && alive(wrapper.pid)) wrapper.kill();
    if (health.exitCode === null && health.pid && alive(health.pid)) health.kill();
  });
  const runtimeFile = path.join(logs, 'runtime.json');
  await waitUntil(
    () => {
      try {
        return existsSync(runtimeFile) && readJson<{ Adopted?: boolean }>(runtimeFile).Adopted === true && !existsSync(adoptionFile);
      } catch {
        return false;
      }
    },
    '包装器必须记录已接管现有健康服务',
  );

  const adopted = readJson<{ ServerPid: number; Adopted: boolean }>(runtimeFile);
  assert.equal(adopted.Adopted, true);
  assert.equal(adopted.ServerPid, health.pid);
  assert.equal(existsSync(adoptionFile), false, '匹配的一次性接管凭据必须在接管后消费');
  assert.equal(health.exitCode, null, '接管期间不得结束原服务');
  assert.equal(alive(health.pid!), true);
  assert.equal(existsSync(path.join(fixture.project, 'FAKE_TSX_EXECUTED')), false, '原服务仍运行时不得启动替代服务');
  assert.deepEqual(snapshotFiles(fixture.dataDir), before, '接管期间不得恢复或改写任务记录');

  health.kill();
  await once(health, 'close');
  const [wrapperCode] = await once(wrapper, 'close') as [number | null];
  assert.notEqual(wrapperCode, 0, `替代服务退出后包装器必须请求重启\n${wrapperStdout}\n${wrapperStderr}`);

  const markerFile = path.join(fixture.project, 'FAKE_TSX_EXECUTED');
  assert.equal(existsSync(markerFile), true, '原服务退出后必须启动临时项目里的假 tsx');
  const marker = readJson<{ cwd: string; argv: string[] }>(markerFile);
  assert.equal(path.resolve(marker.cwd), path.resolve(fixture.project));
  assert.deepEqual(marker.argv, ['src\\server\\main.ts']);
  assert.deepEqual(snapshotFiles(fixture.dataDir), before);
  const lifecycle = readFileSync(path.join(logs, 'lifecycle.log'), 'utf8');
  assert.match(lifecycle, new RegExp(`observing existing server: ${health.pid}`));
  assert.match(lifecycle, /server exited: 7/);
  assert.equal(readJson<{ Adopted: boolean }>(runtimeFile).Adopted, false);
});

test('主入口重复启动失败时不会 recover 并改动已有任务状态', { timeout: 15_000 }, async t => {
  const h = makeHarness({ delayMs: 0 });
  const run = h.orch.createRun(runInput('preference'));
  h.orch.cancelRun(run.id);
  await h.orch.idle();
  const persisted = h.orch.getRun(run.id);
  assert.ok(persisted.tasks.length > 0);
  persisted.terminal = null;
  persisted.phaseStatus = 'running';
  persisted.tasks[0]!.status = 'running';
  persisted.tasks[0]!.failure = null;
  persisted.tasks[0]!.endedAt = null;
  h.store.save(persisted);
  const runFile = path.join(h.store.runDir(run.id), 'run.json');
  const before = readFileSync(runFile, 'utf8');

  const occupied = createServer();
  await new Promise<void>((resolve, reject) => {
    occupied.once('error', reject);
    occupied.listen(0, '127.0.0.1', resolve);
  });
  const address = occupied.address();
  assert.ok(address && typeof address !== 'string');
  t.after(() => new Promise<void>(resolve => occupied.close(() => resolve())));

  mkdirSync(path.join(h.dir, 'config'), { recursive: true });
  writeFileSync(path.join(h.dir, 'config', 'workbench.config.json'), JSON.stringify({
    port: address.port,
    dataDir: h.config.dataDir,
    workspacesRoot: h.config.workspacesRoot,
    adapters: { mock: { delayMs: 0 } },
  }), 'utf8');

  const previousCwd = process.cwd();
  const sigintBefore = new Set(process.listeners('SIGINT'));
  const sigtermBefore = new Set(process.listeners('SIGTERM'));
  let duplicate: ReturnType<typeof startWorkbench> | undefined;
  try {
    process.chdir(h.dir);
    duplicate = startWorkbench();
    const [error] = await once(duplicate.server, 'error') as [NodeJS.ErrnoException];
    assert.equal(error.code, 'EADDRINUSE');
  } finally {
    process.chdir(previousCwd);
    for (const listener of process.listeners('SIGINT')) if (!sigintBefore.has(listener)) process.removeListener('SIGINT', listener);
    for (const listener of process.listeners('SIGTERM')) if (!sigtermBefore.has(listener)) process.removeListener('SIGTERM', listener);
  }

  assert.equal(duplicate?.server.listening, false);
  assert.equal(readFileSync(runFile, 'utf8'), before, 'listen 成功前不得执行 recover');
  const unchanged = readJson<typeof persisted>(runFile);
  assert.equal(unchanged.tasks[0]!.status, 'running');
  assert.equal(statSync(runFile).isFile(), true);
});
