import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { ChatRuntime } from '../src/chat/runtime.js';
import type { AgentTask, ChatRecord } from '../src/chat/types.js';
import { WorkspaceRegistry } from '../src/chat/workspace.js';
import { parsePipelineArgs, runPipelineCli, type PipelineCliIo } from '../scripts/pipeline.js';
import { removeOwnedDemoVolume, reportOfflineDemoCompletion } from '../scripts/demo-offline.js';
import { tempDir } from './helpers.js';

function fixture() {
  const root = tempDir('dmw-headless-');
  const project = path.join(root, 'project'); mkdirSync(project);
  const requirement = path.join(root, 'requirement.md'); writeFileSync(requirement, '模拟数据：构建离线待办 CLI');
  const registry = new WorkspaceRegistry(path.join(root, 'managed'));
  return { root, project, requirement, registry };
}

function fakeRuntime(initial: 'gate-a'|'completed') {
  const listeners = new Set<(event: unknown) => void>();
  const chat = { id: 'chat-headless', pipeline: { stage: initial }, tasks: [], tickets: [] } as unknown as ChatRecord;
  const runtime = {
    create: () => chat,
    subscribe: (_id: string, listener: (event: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    send: () => { for (const listener of listeners) listener({ type: 'pipeline_gate_opened', seq: 1, data: { gateId: 'A' } }); return { chat }; },
    idle: async () => {}, get: () => chat,
    decidePipelineGate: () => { chat.pipeline!.stage = 'completed'; },
    answer: () => chat,
  } as unknown as ChatRuntime;
  return { runtime, chat };
}

function io(tty: boolean, answers: string[] = []) {
  const out: string[] = []; const errors: string[] = [];
  const value: PipelineCliIo = { out: line => out.push(line), error: line => errors.push(line), isTTY: tty,
    ask: async () => answers.shift() ?? '' };
  return { value, out, errors };
}

test('pipeline CLI parses the documented command and rejects unknown flags', () => {
  const parsed = parsePipelineArgs(['--requirement', 'req.md', '--workspace', '.', '--auto', '--preset', 'flagship']);
  assert.equal(parsed.auto, true); assert.equal(parsed.preset, 'flagship');
  assert.throws(() => parsePipelineArgs(['--requirement', 'req.md', '--workspace', '.', '--fake']), /未知参数/);
});

test('headless CLI returns distinct usage and bootstrap exit codes', async () => {
  const missing = io(false);
  assert.equal(await runPipelineCli([], { io: missing.value }), 2);
  const f = fixture();
  try {
    const unavailable = io(false);
    assert.equal(await runPipelineCli(['--requirement', f.requirement, '--workspace', f.project], {
      io: unavailable.value, createSession: () => { throw new Error('模拟数据：运行层不可用'); },
    }), 5);
    assert.match(unavailable.errors.join('\n'), /运行层不可用/u);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('headless non-TTY uses a native local grant and exits meaningfully when Gate A needs input', async () => {
  const f = fixture();
  try {
    const fake = fakeRuntime('gate-a'); const output = io(false);
    fake.chat.pipeline!.architectureTaskId = 'current-architecture';
    fake.chat.tasks.push({ id: 'previous-architecture', status: 'failed' } as AgentTask,
      { id: 'current-architecture', status: 'completed' } as AgentTask);
    const code = await runPipelineCli(['--requirement', f.requirement, '--workspace', f.project], {
      io: output.value, createSession: () => ({ runtime: fake.runtime, registry: f.registry, sessionRoot: path.join(f.root, 'session') }),
    });
    assert.equal(code, 3);
    assert.equal(f.registry.list().length, 1);
    assert.ok(output.out.some(line => JSON.parse(line).type === 'event'));
    assert.ok(output.out.some(line => JSON.parse(line).type === 'started' && JSON.parse(line).sessionRoot === path.join(f.root, 'session')));
    assert.ok(output.out.some(line => JSON.parse(line).type === 'input_required' && JSON.parse(line).gateId === 'A'));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('headless TTY confirmation resumes the same chat and exits zero', async () => {
  const f = fixture();
  try {
    const fake = fakeRuntime('gate-a'); const output = io(true, ['confirm']);
    const code = await runPipelineCli(['--requirement', f.requirement, '--workspace', f.project], {
      io: output.value, createSession: () => ({ runtime: fake.runtime, registry: f.registry }),
    });
    assert.equal(code, 0);
    assert.ok(output.out.some(line => JSON.parse(line).type === 'completed'));
    assert.deepEqual(output.errors, []);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('offline demo refuses a foreign volume and reports PASS only after cleanup succeeds', () => {
  const calls: string[][] = [];
  const foreign = ((_: string, args: string[]) => {
    calls.push(args);
    return args[1] === 'inspect' ? 'other-run\n' : '';
  }) as unknown as typeof import('node:child_process').execFileSync;
  assert.throws(() => removeOwnedDemoVolume('dmw-test', 'owned-run', foreign), /不属于本次夹具/);
  assert.equal(calls.some(args => args[1] === 'rm'), false);

  const failed = io(false);
  const completion = { chatId: 'chat', stage: 'completed', traceRef: 'trace', dockerJobs: 1, liveModelCalls: 0 as const };
  assert.equal(reportOfflineDemoCompletion(completion, new Error('volume busy'), failed.value), 4);
  assert.deepEqual(failed.out, []);
  assert.match(failed.errors.join('\n'), /Docker 清理失败.*volume busy/);

  const passed = io(false);
  assert.equal(reportOfflineDemoCompletion(completion, null, passed.value), 0);
  assert.equal(passed.out.at(-1), 'PASS');
  assert.equal(JSON.parse(passed.out[0]!).type, 'completed');
});
