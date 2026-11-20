import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, get } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { killTree, runProcess } from '../src/adapters/process.js';
import { emptyMeta, type ModelAdapter } from '../src/adapters/types.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { createShutdownHandler } from '../src/server/main.js';
import { makeHarness, runInput, tempDir } from './helpers.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-cli');

test('进程树终止未确认时关闭不得报告成功，已取消的任务也保留诊断', { timeout: 10_000 }, async t => {
  for (const cancelBeforeShutdown of [false, true]) await t.test(cancelBeforeShutdown ? '先取消再关闭' : '关闭时取消', async () => {
    const h = makeHarness();
    let startedCount = 0;
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const warning = '无法确认整个子进程树已结束；孙进程可能仍在运行。';
    const adapter: ModelAdapter = {
      kind: 'mock',
      async run(spec, progress, signal) {
        progress({ at: new Date().toISOString(), kind: 'started', text: '假 CLI 已启动' });
        if (++startedCount === 2) ready();
        await new Promise<void>(resolve => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        const meta = emptyMeta('mock', spec, new Date().toISOString());
        meta.terminationWarning = warning;
        meta.warnings.push(warning);
        return { status: 'cancelled', failure: { kind: 'cancelled', message: '已取消' }, rawText: null, structured: null, meta, toolLog: [], simulated: true };
      },
    };
    h.orch = new Orchestrator({ config: h.config, store: h.store, bus: h.bus, adapterFor: () => adapter });
    const run = h.orch.createRun(runInput('preference'));
    await started;
    if (cancelBeforeShutdown) { h.orch.cancelRun(run.id); await h.orch.idle(); }
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const logs: string[] = [];
    const exitCodes: number[] = [];
    const handler = createShutdownHandler({ server, orchestrator: h.orch }, {
      log: message => logs.push(message), error: (message, error) => logs.push(`${message}${String(error)}`), setExitCode: code => exitCodes.push(code),
    });
    await assert.rejects(handler(), /无法确认全部模型子进程树已结束/);
    assert.deepEqual(exitCodes, [1]);
    assert.equal(logs.some(message => message.startsWith('工作台已停止')), false);
    assert.equal(server.listening, false);
    assert.ok(h.orch.getRun(run.id).tasks.every(task => task.meta?.terminationWarning === warning));
  });
});

function runStartScript(script: string, cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile('cmd.exe', ['/d', '/s', '/c', 'call', script], { cwd, encoding: 'utf8', timeout: 10_000 }, (error, stdout, stderr) => {
      if (error && !('code' in error)) return reject(error);
      resolve({ code: error && typeof error.code === 'number' ? error.code : 0, stdout, stderr });
    });
    // 错误分支会 pause；成功分支会忽略这次输入。
    child.stdin?.end('\n');
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    return false;
  }
}

test('关闭处理器取消模型进程树、断开长连接并释放监听端口', { timeout: 20_000 }, async (t) => {
  const controller = new AbortController();
  const pids: { parent: number; child: number }[] = [];
  const processDone = runProcess(
    { file: process.execPath, prefixArgs: [path.join(fixtures, 'spawn-child.mjs')], via: 'config' },
    [],
    {
      cwd: tempDir('dmw-t4-退出 中文 空格-'),
      env: process.env,
      stdinText: null,
      timeoutMs: 15_000,
      signal: controller.signal,
      onStdoutLine: (line) => pids.push(JSON.parse(line) as { parent: number; child: number }),
    },
  );
  t.after(async () => {
    controller.abort();
    for (const pair of pids) {
      for (const pid of [pair.parent, pair.child]) if (alive(pid)) await killTree(pid);
    }
  });

  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
    res.write(': connected\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    const request = get(`http://127.0.0.1:${port}/events`, resolve);
    request.on('error', reject);
  });
  response.resume();
  const responseClosed = new Promise<void>((resolve) => response.once('close', resolve));
  let closeAllCalls = 0;
  const closeAllConnections = server.closeAllConnections.bind(server);
  server.closeAllConnections = () => {
    closeAllCalls += 1;
    closeAllConnections();
  };

  const deadline = Date.now() + 5000;
  while (!pids.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(pids.length, 1, '假 CLI 必须实际启动父子进程');
  assert.equal(alive(pids[0]!.parent), true);
  assert.equal(alive(pids[0]!.child), true);

  let shutdownCalls = 0;
  const logs: string[] = [];
  const exitCodes: number[] = [];
  const handler = createShutdownHandler(
    {
      server,
      orchestrator: {
        async shutdown() {
          shutdownCalls += 1;
          controller.abort();
          await processDone;
        },
      },
    },
    {
      log: (message) => logs.push(message),
      error: (message, error) => logs.push(`${message}${String(error)}`),
      setExitCode: (code) => exitCodes.push(code),
    },
  );

  const first = handler();
  const second = handler();
  assert.equal(first, second, '重复信号必须复用同一个关闭过程');
  await first;
  await responseClosed;

  assert.equal(shutdownCalls, 1);
  assert.equal(closeAllCalls, 1, '关闭流程必须主动收敛 SSE/keep-alive 长连接');
  assert.deepEqual(exitCodes, [0]);
  assert.ok(logs.some((line) => line.includes('监听端口已释放')));
  assert.equal(alive(pids[0]!.parent), false, '模型父进程必须退出');
  assert.equal(alive(pids[0]!.child), false, '模型启动的工具子进程必须退出');

  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', resolve);
  });
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
});

test('关闭失败会释放监听、设置非零退出码且不会宣称已停止', async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const logs: string[] = [];
  const errors: string[] = [];
  const exitCodes: number[] = [];
  const handler = createShutdownHandler(
    { server, orchestrator: { shutdown: async () => { throw new Error('假关闭失败'); } } },
    {
      log: (message) => logs.push(message),
      error: (message, error) => errors.push(`${message}${String(error)}`),
      setExitCode: (code) => exitCodes.push(code),
    },
  );

  await assert.rejects(handler(), /假关闭失败/);
  assert.deepEqual(exitCodes, [1]);
  assert.ok(errors.some((line) => line.includes('假关闭失败')));
  assert.equal(logs.some((line) => line.includes('工作台已停止')), false);

  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(address.port, '127.0.0.1', resolve);
  });
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
});

test('Windows：中文空格临时项目从其它目录双击后启动自己的入口并正常退出', { skip: process.platform !== 'win32' }, async () => {
  const root = tempDir('dmw-t4-成功 中文 空格-');
  const project = path.join(root, '本机 项目');
  const scripts = path.join(project, 'scripts');
  const tsxDir = path.join(project, 'node_modules', 'tsx', 'dist');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(tsxDir, { recursive: true });
  mkdirSync(path.join(project, 'web', 'dist'), { recursive: true });
  copyFileSync(path.join(process.cwd(), 'scripts', 'start.cmd'), path.join(scripts, 'start.cmd'));
  writeFileSync(path.join(project, 'web', 'dist', 'index.html'), '<!doctype html>', 'utf8');
  writeFileSync(path.join(tsxDir, 'cli.mjs'), [
    "console.log('FAKE_TSX:' + JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }));",
    'process.exitCode = 0;',
  ].join('\n'), 'utf8');

  const elsewhere = path.join(root, '其它 当前目录');
  mkdirSync(elsewhere);
  const result = await runStartScript(path.join(scripts, 'start.cmd'), elsewhere);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /\[启动\] 双模型架构工作台：http:\/\/127\.0\.0\.1:5170/);
  assert.match(result.stdout, /工作台已停止/);
  const marker = result.stdout.split(/\r?\n/).find((line) => line.startsWith('FAKE_TSX:'));
  assert.ok(marker, '必须实际运行临时项目中的假 tsx 入口');
  const seen = JSON.parse(marker.slice('FAKE_TSX:'.length)) as { cwd: string; argv: string[] };
  assert.equal(path.resolve(seen.cwd), path.resolve(project));
  assert.deepEqual(seen.argv, ['src\\server\\main.ts']);
});

test('Windows：中文空格目录中双击脚本会以 UTF-8 给出缺依赖提示', { skip: process.platform !== 'win32' }, async () => {
  const root = tempDir('dmw-t4-启动 中文 空格-');
  const project = path.join(root, '项目 目录');
  const scripts = path.join(project, 'scripts');
  mkdirSync(scripts, { recursive: true });
  const script = path.join(scripts, 'start.cmd');
  copyFileSync(path.join(process.cwd(), 'scripts', 'start.cmd'), script);

  const result = await runStartScript(script, root);
  assert.equal(result.code, 1);
  assert.match(result.stdout + result.stderr, /项目依赖尚未安装/);
  assert.match(result.stdout, /npm install/);
});
