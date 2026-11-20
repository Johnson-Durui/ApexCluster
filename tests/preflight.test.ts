import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runPreflight, renderPreflight, type PreflightInput } from '../src/core/preflight.js';
import type { ResolvedCommand, RunProcessResult } from '../src/adapters/process.js';
import type { MvpSpec } from '../src/core/types.js';
import { tempDir } from './helpers.js';

const at = '2026-10-21T08:00:00.000Z';
const command = (name: string): ResolvedCommand => ({ file: `${name}.exe`, prefixArgs: [], via: 'direct' });
const result = (patch: Partial<RunProcessResult> = {}): RunProcessResult => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  cancelled: false,
  spawnError: null,
  stdoutTail: 'v1.2.3\n',
  stderrTail: '',
  durationMs: 1,
  pid: 1,
  ...patch,
});

function spec(commands: string[], allowNetwork = false): MvpSpec {
  return {
    ref: 'spec-preflight',
    candidateId: 'C1',
    goal: 'test',
    scopeIn: [],
    scopeOut: [],
    acceptance: commands.map((value, index) => ({
      id: `AC${index + 1}`,
      description: 'test',
      kind: 'command' as const,
      command: value,
      expectExitCode: 0,
      outputIncludes: null,
    })),
    hypotheses: [],
    timeboxMinutes: 10,
    allowNetwork,
    comparisonQuestions: [],
  };
}

function input(patch: Partial<PreflightInput> = {}): PreflightInput {
  return {
    spec: spec([]),
    stack: [],
    workspaceDir: tempDir(),
    ...patch,
  };
}

test('只解析命令头和有限技术栈；未知及注入文本不执行，缺工具阻断且 Git 默认仅警告', async () => {
  const resolved: string[] = [];
  const calls: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const output = await runPreflight(input({
    spec: spec(['npm test && remove-everything', 'unknown-tool --version']),
    stack: [{ layer: '前端', choice: 'React + Vite', reason: 'UI' }],
  }), {
    now: () => at,
    env: { PATH: 'safe', OPENAI_API_KEY: 'secret-openai', ANTHROPIC_AUTH_TOKEN: 'secret-anthropic' },
    resolve: (name) => {
      resolved.push(name);
      return name === 'node' ? command(name) : null;
    },
    run: async (cmd, args, options) => {
      calls.push({ file: cmd.file, args, env: options.env ?? {} });
      return result();
    },
  });

  assert.equal(output.ok, false);
  assert.deepEqual(resolved, ['node', 'npm', 'git']);
  assert.deepEqual(calls.map((call) => [call.file, call.args]), [['node.exe', ['--version']]]);
  assert.equal(calls[0]!.env.OPENAI_API_KEY, undefined);
  assert.equal(calls[0]!.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.doesNotMatch(JSON.stringify(output), /secret-openai|secret-anthropic|remove-everything/);
  assert.match(output.items.find((item) => item.check === 'tool:mapping')!.detail, /unknown-tool/);
  assert.equal(output.items.find((item) => item.check === 'tool:npm')?.status, 'missing');
  assert.equal(output.items.find((item) => item.check === 'tool:git')?.status, 'warn');
});

test('Python 只按 python、py 固定顺序取可用证据，且 npm 另行检查固定参数', async () => {
  const calls: string[] = [];
  const output = await runPreflight(input({
    spec: spec(['py -m pytest', 'npx vitest']),
    stack: [{ layer: '后端', choice: 'FastAPI', reason: 'small' }],
  }), {
    now: () => at,
    resolve: (name) => command(name),
    run: async (cmd, args) => {
      calls.push(`${cmd.file} ${args.join(' ')}`);
      if (cmd.file === 'python.exe') return result({ exitCode: 1, stdoutTail: '', stderrTail: 'not configured' });
      if (cmd.file === 'py.exe') return result({ stdoutTail: 'Python 3.12.7\n' });
      return result();
    },
  });

  assert.equal(output.ok, true);
  assert.deepEqual(calls, [
    'node.exe --version',
    'npm.exe --version',
    'python.exe --version',
    'py.exe -3 --version',
    'git.exe --version',
  ]);
  assert.match(output.items.find((item) => item.check === 'tool:python')!.detail, /^py：Python 3\.12\.7/);
});

test('单个混合技术栈项独立累加多个生态，任一必需工具缺失都会阻断', async () => {
  const resolved: string[] = [];
  const output = await runPreflight(input({
    stack: [{ layer: '应用', choice: 'React + FastAPI', reason: '前后端组合' }],
  }), {
    now: () => at,
    resolve: (name) => {
      resolved.push(name);
      return name === 'python' || name === 'py' ? null : command(name);
    },
    run: async () => result(),
  });

  assert.equal(output.ok, false);
  assert.deepEqual(resolved, ['node', 'npm', 'python', 'py', 'git']);
  assert.equal(output.items.find((item) => item.check === 'tool:python')?.status, 'missing');
  assert.equal(output.items.some((item) => item.check === 'tool:mapping'), false);
});

test('工作区不存在时只检查最近父目录且不创建；长路径给出警告', async () => {
  const parent = tempDir('dmw-preflight-');
  const workspace = path.join(parent, 'x'.repeat(205), 'future-workspace');
  const output = await runPreflight(input({
    workspaceDir: workspace,
    stack: [{ layer: '存储', choice: 'SQLite', reason: 'local' }],
  }), {
    now: () => at,
    resolve: () => command('git'),
    run: async () => result(),
  });

  assert.equal(output.ok, true);
  assert.equal(output.items.find((item) => item.check === 'workspace')?.status, 'ok');
  assert.match(output.items.find((item) => item.check === 'workspace')!.detail, /尚未创建/);
  assert.equal(output.items.find((item) => item.check === 'workspace:path-length')?.status, 'warn');
  assert.equal(await import('node:fs').then(({ existsSync }) => existsSync(workspace)), false);
});

test('Git 被验收明确要求时缺失为 missing', async () => {
  const output = await runPreflight(input({ spec: spec(['git status']) }), {
    now: () => at,
    resolve: () => null,
    run: async () => result(),
  });
  assert.equal(output.ok, false);
  assert.equal(output.items.find((item) => item.check === 'tool:git')?.status, 'missing');
});

test('仅 Node 生态且允许联网时 HEAD 固定注册站、不跟随重定向；离线和超时只警告', async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  for (const failure of [new Error('offline'), new DOMException('late', 'TimeoutError')]) {
    const output = await runPreflight(input({
      spec: spec(['npm test'], true),
      stack: [{ layer: '运行时', choice: 'Node.js 22', reason: 'runtime' }],
    }), {
      now: () => at,
      resolve: (name) => command(name),
      run: async () => result(),
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        throw failure;
      }) as typeof fetch,
    });
    assert.equal(output.ok, true);
    assert.equal(output.items.find((item) => item.check === 'network:npm-registry')?.status, 'warn');
    assert.match(output.items.find((item) => item.check === 'network:npm-registry')!.detail, failure.name === 'TimeoutError' ? /5 秒/ : /不可达/);
  }
  assert.deepEqual(requests.map((request) => [request.url, request.init?.method, request.init?.redirect]), [
    ['https://registry.npmjs.org/', 'HEAD', 'manual'],
    ['https://registry.npmjs.org/', 'HEAD', 'manual'],
  ]);

  let called = false;
  await runPreflight(input({ spec: spec(['python -m pytest'], true) }), {
    now: () => at,
    resolve: (name) => command(name),
    run: async () => result(),
    fetch: (async () => { called = true; return new Response(null, { status: 200 }); }) as typeof fetch,
  });
  assert.equal(called, false, 'Python 项目不能用 npm 注册站冒充通用联网证明');
});

test('取消会中止当前探测并阻止后续工具和网络检查', async () => {
  const controller = new AbortController();
  const resolved: string[] = [];
  let fetched = false;
  let seenSignal: AbortSignal | undefined;
  await assert.rejects(runPreflight(input({ spec: spec(['npm test'], true) }), {
    signal: controller.signal,
    resolve: (name) => {
      resolved.push(name);
      return command(name);
    },
    run: async (_cmd, _args, options) => {
      seenSignal = options.signal;
      controller.abort(new DOMException('stop', 'AbortError'));
      return result({ cancelled: true });
    },
    fetch: (async () => { fetched = true; return new Response(null, { status: 200 }); }) as typeof fetch,
  }), /stop/);
  assert.deepEqual(resolved, ['node']);
  assert.equal(seenSignal, controller.signal);
  assert.equal(fetched, false);
});

test('异常进程结果即使退出码为 0 也不通过；terminationWarning 阻止 Python fallback', async () => {
  for (const bad of [
    { timedOut: true },
    { spawnError: 'spawn failed' },
    { terminationWarning: 'tree may still run' },
  ] satisfies Partial<RunProcessResult>[]) {
    const output = await runPreflight(input({ spec: spec(['node --version']) }), {
      now: () => at,
      resolve: (name) => command(name),
      run: async (cmd) => cmd.file === 'node.exe' ? result({ exitCode: 0, ...bad }) : result(),
    });
    assert.equal(output.ok, false);
    assert.equal(output.items.find((item) => item.check === 'tool:node')?.status, 'missing');
  }

  const resolved: string[] = [];
  const python = await runPreflight(input({ spec: spec(['python -m pytest']) }), {
    now: () => at,
    resolve: (name) => {
      resolved.push(name);
      return command(name);
    },
    run: async (cmd) => cmd.file === 'python.exe'
      ? result({ terminationWarning: '无法确认整个子进程树已结束' })
      : result(),
  });
  assert.equal(python.ok, false);
  assert.deepEqual(resolved, ['python', 'git'], '异常 python 探测不得通过 py fallback 掩盖');
  assert.match(python.items.find((item) => item.check === 'tool:python')!.detail, /无法确认整个子进程树已结束/);
});

test('renderPreflight 输出稳定 Markdown 并转义表格内容', () => {
  const markdown = renderPreflight({
    ok: false,
    checkedAt: at,
    items: [{ check: 'tool:test|x', status: 'missing', detail: 'line|one\nline two' }],
  });
  assert.match(markdown, /# 环境预检/);
  assert.match(markdown, /结论：未通过/);
  assert.match(markdown, /tool:test\\\|x \| 缺失 \| line\\\|one line two/);
});
