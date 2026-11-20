import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, get, type Server } from 'node:http';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NativeDirectorySelector } from '../src/chat/http.js';
import { WorkspaceRegistry } from '../src/chat/workspace.js';
import { RunStore } from '../src/orchestrator/store.js';
import { countActiveWork, DesktopHost, protocolLine, type DesktopReply } from '../src/server/desktop.js';
import { tempDir } from './helpers.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopEntry = path.join(projectRoot, 'src', 'server', 'desktop.ts');
const tsxLoader = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs');

function fixtureRun(id: string, tasks: { status: string }[] = [], jobs: { status: string }[] = []): never {
  return {
    id, title: 'fixture', mode: 'mock', createdAt: '', updatedAt: '', phase: 'propose', phaseStatus: 'running', terminal: null,
    writeDocs: false, writePrd: false, docWriter: { role: 'sol', model: 'fixture-model', effort: 'high' },
    docs: { batch: 0, bases: [], requests: [], versions: [], missing: [], requestSeq: 0 },
    models: {
      claude: { role: 'claude', adapter: 'mock', model: 'fixture-model', effort: 'low' },
      astra: { role: 'astra', adapter: 'mock', model: 'fixture-model', effort: 'low' },
      sol: { role: 'sol', adapter: 'mock', model: 'fixture-model', effort: 'low' },
    },
    tasks, jobs, snapshots: [], questions: [], modelNotes: [], proposals: [], judgments: [], equivalenceGroups: [],
    candidates: [], overrides: [], decision: null, anonymization: null, recheckLog: [], adjudications: [], gates: [],
    degraded: [], finalChoice: null,
  } as never;
}

async function listeningServer(): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

async function unusedPort(): Promise<number> {
  const server = await listeningServer();
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

interface DesktopProcess {
  child: ChildProcessWithoutNullStreams;
  replies: DesktopReply[];
  stdout: string[];
  stderr: string[];
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function launchDesktop(root: string, port: number): DesktopProcess {
  mkdirSync(path.join(root, 'config'), { recursive: true });
  writeFileSync(path.join(root, 'config', 'workbench.config.json'), JSON.stringify({
    port,
    dataDir: 'fixture-data',
    workspacesRoot: 'fixture-workspaces',
    models: {
      claude: { adapter: 'mock', model: 'fixture-model', effort: 'low' },
      astra: { adapter: 'mock', model: 'fixture-model', effort: 'low' },
      sol: { adapter: 'mock', model: 'fixture-model', effort: 'low' },
    },
    adapters: { mock: { delayMs: 60_000 } },
  }, null, 2), 'utf8');
  const child = spawn(process.execPath, ['--import', pathToFileURL(tsxLoader).href, desktopEntry], {
    cwd: root,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const replies: DesktopReply[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) {
      stdout.push(line);
      if (!line.startsWith('DMW_DESKTOP ')) continue;
      replies.push(JSON.parse(line.slice('DMW_DESKTOP '.length)) as DesktopReply);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => stderr.push(chunk));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, replies, stdout, stderr, exited };
}

async function waitForReply(process: DesktopProcess, predicate: (reply: DesktopReply) => boolean, timeoutMs = 5000): Promise<DesktopReply> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reply = process.replies.find(predicate);
    if (reply) return reply;
    if (process.child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`未收到预期 desktop 回复；stdout=${process.stdout.join(' | ')}；stderr=${process.stderr.join('')}`);
}

async function waitForExit(process: DesktopProcess, timeoutMs = 5000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      process.exited,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('desktop 子进程未按时退出')), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function cleanUpProcess(t: TestContext, process: DesktopProcess): void {
  t.after(async () => {
    if (process.child.exitCode === null && process.child.signalCode === null) {
      process.child.kill();
      await waitForExit(process).catch(() => undefined);
    }
  });
}

async function healthStatus(port: number): Promise<number | undefined> {
  return await new Promise<number | undefined>((resolve, reject) => {
    const request = get(`http://127.0.0.1:${port}/api/health`, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
  });
}

test('desktop protocol is prefixed and activity count is content-free', () => {
  const dir = tempDir('dmw-desktop-');
  const store = new RunStore(dir);
  store.save(fixtureRun('r-1', [{ status: 'queued' }, { status: 'running' }, { status: 'succeeded' }], [{ status: 'preparing' }, { status: 'verifying' }, { status: 'succeeded' }]));
  assert.deepEqual(countActiveWork(dir), { tasks: 2, jobs: 2 });
  assert.match(protocolLine({ type: 'busy', tasks: 2, jobs: 2 }), /^DMW_DESKTOP \{"type":"busy","tasks":2,"jobs":2\}$/);
});

test('ready is emitted only after the health endpoint is listening; stop exits with stdin left open', { timeout: 25_000 }, async (t) => {
  const root = tempDir('dmw-desktop-process-');
  const port = await unusedPort();
  const desktop = launchDesktop(root, port);
  cleanUpProcess(t, desktop);

  const ready = await waitForReply(desktop, (reply) => reply.type === 'ready', 15_000);
  assert.deepEqual(ready, { type: 'ready', url: `http://127.0.0.1:${port}/`, pid: desktop.child.pid });
  assert.equal(await healthStatus(port), 200, 'ready 出现时健康接口必须已经可访问');

  desktop.child.stdin.write('{"command":"stop"}\n');
  assert.equal(desktop.child.stdin.writableEnded, false, '测试父进程必须保持 stdin 开启');
  const result = await waitForExit(desktop);
  assert.equal(result.code, 0, desktop.stderr.join(''));
  assert.equal(desktop.replies.filter((reply) => reply.type === 'stopped').length, 1);
});

test('queued/running tasks and preparing/running/verifying jobs keep a normal stop busy', async (t) => {
  const cases = [
    { kind: 'task', status: 'queued' },
    { kind: 'task', status: 'running' },
    { kind: 'job', status: 'preparing' },
    { kind: 'job', status: 'running' },
    { kind: 'job', status: 'verifying' },
  ] as const;
  for (const item of cases) await t.test(`${item.kind}:${item.status}`, async () => {
    const dataDir = tempDir(`dmw-desktop-busy-${item.kind}-${item.status}-`);
    new RunStore(dataDir).save(fixtureRun(
      `r-${item.kind}-${item.status}`,
      item.kind === 'task' ? [{ status: item.status }] : [],
      item.kind === 'job' ? [{ status: item.status }] : [],
    ));
    const server = await listeningServer();
    let shutdownCalls = 0;
    const lines: string[] = [];
    const host = new DesktopHost({
      runtime: { server, orchestrator: { shutdown: async () => { shutdownCalls += 1; } } },
      dataDir,
      write: (line) => lines.push(line),
    });

    await host.command({ command: 'stop' });
    assert.equal(server.listening, true);
    assert.equal(shutdownCalls, 0);
    const expected = item.kind === 'task' ? { type: 'busy' as const, tasks: 1, jobs: 0 } : { type: 'busy' as const, tasks: 0, jobs: 1 };
    assert.ok(lines.includes(protocolLine(expected)));
    await host.command({ command: 'stop', force: true });
  });
});

test('force stop bypasses busy state, invokes shutdown, and cancels a fake model', async () => {
  const dataDir = tempDir('dmw-desktop-force-');
  new RunStore(dataDir).save(fixtureRun('r-force', [{ status: 'running' }], [{ status: 'verifying' }]));
  const server = await listeningServer();
  const controller = new AbortController();
  const fakeModel = new Promise<void>((resolve) => controller.signal.addEventListener('abort', () => resolve(), { once: true }));
  let shutdownCalls = 0;
  const lines: string[] = [];
  const host = new DesktopHost({
    runtime: {
      server,
      orchestrator: {
        async shutdown() {
          shutdownCalls += 1;
          controller.abort();
          await fakeModel;
        },
      },
    },
    dataDir,
    write: (line) => lines.push(line),
  });

  await host.command({ command: 'stop', force: true });
  assert.equal(shutdownCalls, 1);
  assert.equal(controller.signal.aborted, true);
  assert.equal(server.listening, false);
  assert.deepEqual(lines, [protocolLine({ type: 'stopped' })]);
});

test('corrupt run JSON fails closed and leaves the listener running', async () => {
  const dataDir = tempDir('dmw-desktop-corrupt-');
  const runDir = path.join(dataDir, 'runs', 'broken');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, 'run.json'), '{ not valid JSON', 'utf8');
  const server = await listeningServer();
  let shutdownCalls = 0;
  const host = new DesktopHost({
    runtime: { server, orchestrator: { shutdown: async () => { shutdownCalls += 1; } } },
    dataDir,
    write: () => undefined,
  });

  await assert.rejects(host.command({ command: 'stop' }), SyntaxError);
  assert.equal(shutdownCalls, 0);
  assert.equal(server.listening, true, '无法证明空闲时不得关闭工作台');
  await host.command({ command: 'stop', force: true });
});

test('stdin EOF and malformed input both shut down the desktop child', { timeout: 20_000 }, async (t) => {
  await t.test('EOF', async (t) => {
    const desktop = launchDesktop(tempDir('dmw-desktop-eof-'), await unusedPort());
    cleanUpProcess(t, desktop);
    await waitForReply(desktop, (reply) => reply.type === 'ready');
    desktop.child.stdin.end();
    const result = await waitForExit(desktop);
    assert.equal(result.code, 0, desktop.stderr.join(''));
    assert.equal(desktop.replies.filter((reply) => reply.type === 'stopped').length, 1);
  });

  await t.test('malformed JSON', async (t) => {
    const desktop = launchDesktop(tempDir('dmw-desktop-invalid-'), await unusedPort());
    cleanUpProcess(t, desktop);
    await waitForReply(desktop, (reply) => reply.type === 'ready');
    desktop.child.stdin.write('{ invalid JSON\n');
    const result = await waitForExit(desktop);
    assert.equal(result.code, 1);
    assert.ok(desktop.replies.some((reply) => reply.type === 'error' && reply.message === 'stdin 不是合法 JSON'));
    assert.equal(desktop.replies.filter((reply) => reply.type === 'stopped').length, 1);
  });

  await t.test('EOF after unsupported command', async (t) => {
    const desktop = launchDesktop(tempDir('dmw-desktop-invalid-command-'), await unusedPort());
    cleanUpProcess(t, desktop);
    await waitForReply(desktop, (reply) => reply.type === 'ready');
    desktop.child.stdin.end('{"command":"unsupported"}\n');
    const result = await waitForExit(desktop);
    assert.equal(result.code, 1);
    assert.ok(desktop.replies.some((reply) => reply.type === 'error' && reply.message === '仅支持 command=stop'));
    assert.equal(desktop.replies.filter((reply) => reply.type === 'stopped').length, 1);
  });
});

test('occupied port exits nonzero without ready or fixture mutation', { timeout: 15_000 }, async (t) => {
  const blocker = await listeningServer();
  t.after(async () => {
    if (blocker.listening) await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });
  const address = blocker.address();
  assert.ok(address && typeof address !== 'string');
  const root = tempDir('dmw-desktop-occupied-');
  const dataDir = path.join(root, 'fixture-data');
  const store = new RunStore(dataDir);
  store.save(fixtureRun('r-occupied', [{ status: 'queued' }]));
  const fixtureFile = path.join(dataDir, 'runs', 'r-occupied', 'run.json');
  const before = readFileSync(fixtureFile, 'utf8');
  const desktop = launchDesktop(root, address.port);
  cleanUpProcess(t, desktop);

  const result = await waitForExit(desktop);
  assert.notEqual(result.code, 0);
  assert.equal(desktop.replies.some((reply) => reply.type === 'ready'), false);
  assert.ok(desktop.replies.some((reply) => reply.type === 'error'));
  assert.equal(readFileSync(fixtureFile, 'utf8'), before);
});

test('repeated stop commands share one shutdown and emit stopped once', async () => {
  const server = await listeningServer();
  let release!: () => void;
  const allowShutdown = new Promise<void>((resolve) => { release = resolve; });
  let shutdownCalls = 0;
  const lines: string[] = [];
  const host = new DesktopHost({
    runtime: {
      server,
      orchestrator: { shutdown: async () => { shutdownCalls += 1; await allowShutdown; } },
    },
    dataDir: tempDir('dmw-desktop-idempotent-'),
    write: (line) => lines.push(line),
  });

  const first = host.command({ command: 'stop' });
  const second = host.command({ command: 'stop' });
  release();
  await Promise.all([first, second]);
  await host.command({ command: 'stop' });
  assert.equal(shutdownCalls, 1);
  assert.equal(lines.filter((line) => line === protocolLine({ type: 'stopped' })).length, 1);
});

test('a dialog folder the registry cannot grant cancels that selection without killing the desktop host', async () => {
  // r17 native acceptance: a Chinese folder name reached Node garbled, lstat failed, and the whole workbench exited.
  const root = tempDir('dmw-desktop-ungrantable-');
  const registry = new WorkspaceRegistry(path.join(root, 'work'));
  const picker = new NativeDirectorySelector(registry);
  const server = await listeningServer();
  const lines: string[] = [];
  const exits: number[] = [];
  const host = new DesktopHost({
    runtime: { server, orchestrator: { shutdown: async () => undefined }, directoryPicker: picker },
    dataDir: root, write: line => lines.push(line), exit: code => exits.push(code),
  });
  try {
    const failed = picker.request();
    await host.command({ command: 'folder-selected', requestId: failed.requestId, path: path.join(root, '03-ԭʼ\uFFFD\uFFFDSDK') });
    assert.equal(picker.result(failed.requestId).status, 'cancelled');
    assert.deepEqual(registry.list(), [], 'an ungrantable folder must not create a grant');
    assert.deepEqual(exits, [], 'an ungrantable folder must not take the fatal path');
    assert.equal(lines.some(line => line.startsWith('DMW_DESKTOP {"type":"error"')), false);
    assert.ok(lines.some(line => line.startsWith('DMW_DESKTOP {"type":"folder_error"')), 'the launcher log should record why the grant failed');
    assert.equal(server.listening, true);

    // The repaired launcher sends ASCII-only JSON; the escaped line must restore the exact Chinese path.
    const chinese = path.join(root, '03-原始资料SDK-20260924 🙂');
    mkdirSync(chinese);
    const next = picker.request();
    // Escape per UTF-16 code unit, as the launcher does (a /u regex would match the emoji's surrogate pair as one).
    const line = JSON.stringify({ command: 'folder-selected', requestId: next.requestId, path: chinese }).replace(/[^\x20-\x7e]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    assert.match(line, /^[\x20-\x7e]+$/u);
    await host.command(JSON.parse(line));
    assert.equal(picker.result(next.requestId).status, 'selected');
    assert.equal(registry.list()[0]?.path, chinese);
    await host.command({ command: 'stop' });
    assert.equal(server.listening, false);
  } finally {
    if (server.listening) await host.shutdown();
  }
});

test('the compiled launcher writes ASCII-only stdin JSON that restores a Chinese folder path', { skip: process.platform !== 'win32' }, () => {
  const compiler = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const dir = tempDir('dmw-launcher-ascii-');
  const probe = path.join(dir, 'AsciiJsonProbe.cs');
  writeFileSync(probe, [
    'using System; using System.Collections.Generic; using System.IO; using System.Text;',
    'internal static class AsciiJsonProbe { private static int Main(string[] args) {',
    '  var reply = new Dictionary<string, object>(); reply["command"] = "folder-selected"; reply["requestId"] = "r"; reply["path"] = File.ReadAllText(args[0], Encoding.UTF8);',
    '  File.WriteAllText(args[1], LauncherController.AsciiJson(reply), new UTF8Encoding(false)); return 0; } }',
  ].join('\n'));
  const exe = path.join(dir, 'probe.exe');
  const compiled = spawnSync(compiler, ['/nologo', '/target:exe', '/main:AsciiJsonProbe', `/out:${exe}`, '/r:System.Core.dll', '/r:System.Windows.Forms.dll', '/r:System.Management.dll', '/r:System.Web.Extensions.dll',
    path.join(projectRoot, 'scripts', 'desktop', 'DesktopLauncher.cs'), probe], { encoding: 'utf8', windowsHide: true });
  assert.equal(compiled.status, 0, compiled.stdout || compiled.stderr);
  const original = 'X:\\Profiles\\fixture-user\\Desktop\\R16\\03-原始资料SDK-20260924 🙂';
  writeFileSync(path.join(dir, 'in.txt'), original, 'utf8');
  const ran = spawnSync(exe, [path.join(dir, 'in.txt'), path.join(dir, 'out.json')], { encoding: 'utf8', windowsHide: true });
  assert.equal(ran.status, 0, ran.stdout || ran.stderr);
  const line = readFileSync(path.join(dir, 'out.json'), 'utf8');
  assert.match(line, /^[\x20-\x7e]+$/u, 'stdin JSON must be printable ASCII in every code page');
  assert.equal(JSON.parse(line).path, original);
});

test('the compiled launcher sends the real path of a folder picked through a junction, and the registry grants it', { skip: process.platform !== 'win32' }, () => {
  // Native acceptance covers a desktop junction whose target is on another volume. A folder picked under it
  // reached the registry as the link path, whose canonical path differs, so the grant was refused ("未选择目录").
  const dir = tempDir('dmw-launcher-junction-');
  const real = path.join(dir, 'projects', '03-原始开发SDK-20260924');
  mkdirSync(real, { recursive: true });
  const link = path.join(dir, 'R16');
  symlinkSync(path.join(dir, 'projects'), link, 'junction');
  const throughLink = path.join(link, '03-原始开发SDK-20260924');
  const missing = path.join(dir, 'missing-原始');

  const unresolved = new WorkspaceRegistry(path.join(dir, 'work-unresolved'));
  assert.throws(() => unresolved.grantFromNativeSelection(throughLink, unresolved.issueNativeSelectionRequest()), /规范路径与所选路径不一致/u,
    'the registry keeps refusing link paths; the launcher must send the real one');

  const compiler = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const probe = path.join(dir, 'RealPathProbe.cs');
  writeFileSync(probe, [
    'using System; using System.IO; using System.Linq; using System.Text;',
    'internal static class RealPathProbe { private static int Main(string[] args) {',
    '  string[] resolved = File.ReadAllLines(args[0], Encoding.UTF8).Select(RealDirectoryPath.Resolve).ToArray();',
    '  File.WriteAllLines(args[1], resolved, new UTF8Encoding(false)); return 0; } }',
  ].join('\n'));
  const exe = path.join(dir, 'realpath-probe.exe');
  const compiled = spawnSync(compiler, ['/nologo', '/target:exe', '/main:RealPathProbe', `/out:${exe}`, '/r:System.Core.dll', '/r:System.Windows.Forms.dll', '/r:System.Management.dll', '/r:System.Web.Extensions.dll',
    path.join(projectRoot, 'scripts', 'desktop', 'DesktopLauncher.cs'), probe], { encoding: 'utf8', windowsHide: true });
  assert.equal(compiled.status, 0, compiled.stdout || compiled.stderr);
  writeFileSync(path.join(dir, 'in.txt'), [throughLink, real, link, missing].join('\r\n'), 'utf8');
  const ran = spawnSync(exe, [path.join(dir, 'in.txt'), path.join(dir, 'out.txt')], { encoding: 'utf8', windowsHide: true });
  assert.equal(ran.status, 0, ran.stdout || ran.stderr);
  const [viaLink, direct, linkItself, absent] = readFileSync(path.join(dir, 'out.txt'), 'utf8').split(/\r?\n/u);

  assert.equal(viaLink, realpathSync.native(throughLink), 'same answer as the registry\'s own realpath');
  assert.equal(viaLink!.toLowerCase(), realpathSync.native(real).toLowerCase());
  assert.equal(direct, realpathSync.native(real), 'a plain folder is unchanged apart from on-disk casing');
  assert.equal(linkItself, realpathSync.native(link), 'picking the junction itself grants its target');
  assert.equal(absent, missing, 'an unresolvable path passes through unchanged for the registry to judge');

  const registry = new WorkspaceRegistry(path.join(dir, 'work'));
  const grant = registry.grantFromNativeSelection(viaLink!, registry.issueNativeSelectionRequest());
  assert.equal(grant.path, realpathSync.native(real));
  assert.throws(() => registry.grantFromNativeSelection(absent!, registry.issueNativeSelectionRequest()), /ENOENT/u);
});

test('late directory results cannot grant access or prevent a normal desktop stop', async (t) => {
  for (const cancelledBy of ['expiry-before-poll', 'expiry-after-poll', 'user-cancel'] as const) {
    await t.test(cancelledBy, async () => {
      const root = tempDir('dmw-desktop-late-picker-');
      const registry = new WorkspaceRegistry(path.join(root, 'work'));
      const picker = new NativeDirectorySelector(registry);
      const server = await listeningServer();
      const lines: string[] = [];
      const exits: number[] = [];
      const host = new DesktopHost({
        runtime: { server, orchestrator: { shutdown: async () => undefined }, directoryPicker: picker },
        dataDir: root,
        write: line => lines.push(line),
        exit: code => exits.push(code),
      });
      try {
        const pending = picker.request();
        if (cancelledBy === 'user-cancel') {
          await host.command({ command: 'folder-selected', requestId: pending.requestId, path: null });
        } else {
          pending.expiresAt = Date.now() - 1;
          if (cancelledBy === 'expiry-after-poll') assert.equal(picker.result(pending.requestId).status, 'cancelled');
        }
        const project = path.join(root, 'project');
        mkdirSync(project);
        for (const selectedPath of [null, project]) {
          await host.command({ command: 'folder-selected', requestId: pending.requestId, path: selectedPath })
            .catch(error => host.error(error instanceof Error ? error.message : String(error)));
        }
        assert.equal(picker.result(pending.requestId).status, 'cancelled');
        assert.deepEqual(registry.list(), [], 'late paths must never create a workspace grant');
        assert.deepEqual(exits, [], 'an expired or cancelled dialog must not take the fatal stdin error path');
        assert.equal(lines.some(line => line.startsWith('DMW_DESKTOP {"type":"error"')), false);
        assert.equal(server.listening, true);

        const next = picker.request();
        await assert.rejects(host.command({ command: 'folder-selected', requestId: 'unknown', path: project }));
        await assert.rejects(host.command({ command: 'folder-selected', requestId: next.requestId, path: 1 }));
        await host.command({ command: 'folder-selected', requestId: next.requestId, path: project });
        assert.equal(picker.result(next.requestId).status, 'selected');
        assert.equal(registry.list().length, 1);
        await assert.rejects(host.command({ command: 'folder-selected', requestId: next.requestId, path: project }));
        const invalid = picker.request();
        await assert.rejects(host.command({ command: 'folder-selected', requestId: invalid.requestId, path: 'relative' }));
        await host.command({ command: 'stop' });
        assert.equal(server.listening, false);
        assert.equal(lines.filter(line => line === protocolLine({ type: 'stopped' })).length, 1);
      } finally {
        if (server.listening) await host.shutdown();
      }
    });
  }
});
