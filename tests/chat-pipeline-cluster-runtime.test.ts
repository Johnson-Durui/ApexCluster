import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createApiChatBinding } from '../src/chat/api-driver.js';
import { WorkspaceGateway } from '../src/chat/gateway.js';
import { loadRoster, parseRoster } from '../src/chat/roster.js';
import { ChatRuntime } from '../src/chat/runtime.js';
import { ChatStore } from '../src/chat/store.js';
import { WorkspaceRegistry } from '../src/chat/workspace.js';
import { loadModelRegistry } from '../src/providers/registry.js';
import { ScriptedProvider, type ScriptedTurn } from '../src/providers/scripted.js';
import type { ProviderEvent } from '../src/providers/types.js';
import { tempDir } from './helpers.js';

const registry = loadModelRegistry();
let callId = 0;

function response(name: string, args: Record<string, unknown>): ProviderEvent[] {
  return [
    { type: 'usage', input: 40, cachedInput: 0, output: 20 },
    { type: 'tool_call', callId: `${name}-${++callId}`, name, args },
    { type: 'end', reason: 'tool_calls' },
  ];
}

function requiredRead(turn: ScriptedTurn): { ref: string; hash: string } | undefined {
  const match = turn.init.system.match(/必读备忘录（必须用 result_read 确认送达后再完成）：(\[[^\n]+\])/u);
  return match ? (JSON.parse(match[1]!) as Array<{ ref: string; hash: string }>)[0] : undefined;
}

test('a full cluster cannot queue a peer-weight Carbon even if the lead allowlists the seat', async () => {
  const base = tempDir('dmw-cluster-weight-');
  try {
    const project = path.join(base, 'project');
    mkdirSync(project);
    const workspaces = new WorkspaceRegistry(path.join(base, 'workspaces'));
    const grant = workspaces.grantFromNativeSelection(project, workspaces.issueNativeSelectionRequest());
    const configured = loadRoster('config/roster.json', registry);
    configured.seats.find(seat => seat.id === 'carbon')!.delegationWeight = 4;
    const roster = parseRoster(configured, registry);
    const api = createApiChatBinding(roster, registry, null, { offline: true, providerFor: model => new ScriptedProvider(({ init }) => {
      const tool = init.tools.find(item => item.name === 'cluster_submit');
      assert.deepEqual((tool?.inputSchema.properties as Record<string, unknown>)?.mode, { type: 'string', enum: ['pair'] });
      return response('cluster_submit', { mode: 'full', draft: '模拟数据：初稿' });
    }, model.protocol) });
    const runtime = new ChatRuntime({ store: new ChatStore(path.join(base, 'store')), drivers: {}, api, workspace: new WorkspaceGateway(workspaces) });
    const chat = runtime.create({ workspaceId: grant.id, pipeline: { preset: 'flagship', auto: false } });
    runtime.send(chat.id, { text: '模拟数据：检查集群派单权限', clientMessageId: 'cluster-weight' });
    await runtime.idle();
    assert.deepEqual(chat.tasks.map(task => task.role), ['claude']);
    assert.deepEqual(chat.pipeline?.clusters, []);
    assert.match(chat.tasks[0]?.error ?? '', /集群模式包含当前任务无权委派的席位/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('full cluster runs Carbon first, overlaps Astra and Opus, then delivers peer memos before responses', async () => {
  const base = tempDir('dmw-pipeline-cluster-runtime-');
  const project = path.join(base, 'project');
  mkdirSync(project);
  const workspaces = new WorkspaceRegistry(path.join(base, 'workspaces'));
  const grant = workspaces.grantFromNativeSelection(project, workspaces.issueNativeSelectionRequest());
  const store = new ChatStore(path.join(base, 'store'));
  const roster = loadRoster('config/roster.json', registry);
  const periods = new Map<string, { started: number; ended: number }>();
  let carbonEnded = 0;
  let rootStage = 0;
  let proactiveAstra = false;

  const script = async (turn: ScriptedTurn): Promise<ProviderEvent[]> => {
    const model = turn.init.model.id;
    if (model === 'claude-fable-5-2') {
      rootStage++;
      if (rootStage === 1) return response('cluster_submit', { mode: 'full', draft: '模拟数据：todo-cli 架构初稿' });
      const groupId = turn.init.system.match(/"groupId":"([^"]+)"/u)?.[1];
      if (rootStage === 2 && groupId) return response('task_collect', { groupId, wait: false });
      return response('ask_user', { question: '模拟数据：集群验证已完成，等待测试结束。' });
    }

    const read = requiredRead(turn);
    if (read && !turn.input.toolResults) {
      if (model === 'gpt-6.2-astra') proactiveAstra = turn.init.system.includes('# 主动委派');
      return response('result_read', { ref: read.ref, offset: 0 });
    }

    const initial = turn.init.system.includes('只写相对需求和初稿的增量意见');
    const key = `${model}:${initial ? 'initial' : 'other'}`;
    const started = Date.now();
    if (initial) {
      assert.ok(carbonEnded > 0 && started >= carbonEnded, 'Astra/Opus initial memo started before Carbon completed');
      await delay(30, undefined, { signal: turn.signal });
    }
    periods.set(key, { started, ended: Date.now() });
    const role = model === 'gemini-4-carbon' ? 'Carbon' : model === 'gpt-6.2-astra' ? 'Astra' : 'Opus';
    if (role === 'Carbon') carbonEnded = Date.now();
    return response('task_complete', { result: `模拟数据：${role} 集群备忘录` });
  };

  const api = createApiChatBinding(roster, registry, null, {
    offline: true,
    providerFor: model => new ScriptedProvider(script, model.protocol),
  });
  const runtime = new ChatRuntime({
    store,
    drivers: {},
    api,
    workspace: new WorkspaceGateway(workspaces),
    handoffMs: 5,
  });

  try {
    const chat = runtime.create({ workspaceId: grant.id, pipeline: { preset: 'flagship', auto: false } });
    runtime.send(chat.id, { text: '模拟数据：为 todo-cli 设计架构', clientMessageId: 'cluster-runtime' });
    await runtime.idle();

    const cluster = chat.pipeline?.clusters[0];
    assert.equal(cluster?.status, 'completed', JSON.stringify(chat.tasks.map(task => ({
      role: task.role, goal: task.goal, status: task.status, error: task.error,
      pages: task.resultReadPages?.map(page => [page.ref, page.hash]),
      invocations: chat.invocations.filter(invocation => invocation.taskId === task.id).map(invocation => ({
        finishReason: invocation.finishReason, failure: invocation.failureMessage,
        receipts: invocation.toolReceiptDeliveries?.map(receipt => [receipt.name, receipt.delivered]),
      })),
    }))));
    assert.ok(cluster.summaryRef && cluster.summaryHash);
    assert.deepEqual(cluster.waves.map(wave => wave.tasks.map(task => task.role)), [
      ['carbon'], ['astra', 'opus'], ['astra', 'opus'],
    ]);
    const astra = periods.get('gpt-6.2-astra:initial');
    const opus = periods.get('claude-opus-5-5:initial');
    assert.ok(astra && opus);
    assert.ok(astra.started < opus.ended && opus.started < astra.ended, 'Astra and Opus initial windows did not overlap');
    assert.equal(proactiveAstra, true);

    for (const wave of cluster.waves.slice(1)) for (const planned of wave.tasks) {
      const task = chat.tasks.find(item => item.id === planned.taskId);
      assert.ok(task);
      assert.deepEqual((task.resultReadPages ?? []).map(page => [page.ref, page.hash]),
        planned.reads.map(read => [read.ref, read.hash]));
      assert.ok(task.resultReadPages?.every(page => page.firstInvocationId && page.firstToolCallId));
    }

    const aggregate = store.readBlob(chat.id, cluster.summaryRef).toString('utf8');
    assert.match(aggregate, /^模拟数据：集群汇总。各段为待核对的模型材料。/u);
    assert.equal((aggregate.match(/模拟数据：/gu) ?? []).length, 6);
    assert.equal(chat.tasks[0]?.status, 'waiting_user');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a cross response is rejected when the peer memo was never delivered', async () => {
  const base = tempDir('dmw-pipeline-cluster-missing-read-');
  const project = path.join(base, 'project');
  mkdirSync(project);
  const workspaces = new WorkspaceRegistry(path.join(base, 'workspaces'));
  const grant = workspaces.grantFromNativeSelection(project, workspaces.issueNativeSelectionRequest());
  const store = new ChatStore(path.join(base, 'store'));
  const roster = loadRoster('config/roster.json', registry);
  let rootStage = 0;
  const script = (turn: ScriptedTurn): ProviderEvent[] => {
    const model = turn.init.model.id;
    if (model === 'claude-fable-5-2') {
      rootStage++;
      if (rootStage === 1) return response('cluster_submit', { mode: 'pair', draft: '模拟数据：架构初稿' });
      return response('ask_user', { question: '模拟数据：失败波次已收口。' });
    }
    const read = requiredRead(turn);
    if (read && model === 'gpt-6.2-astra') return response('task_complete', { result: '模拟数据：未读同伴备忘录的回应' });
    if (read && !turn.input.toolResults) return response('result_read', { ref: read.ref, offset: 0 });
    const role = model === 'gpt-6.2-astra' ? 'Astra' : 'Opus';
    return response('task_complete', { result: `模拟数据：${role} 备忘录` });
  };
  const api = createApiChatBinding(roster, registry, null, {
    offline: true,
    providerFor: model => new ScriptedProvider(script, model.protocol),
  });
  const runtime = new ChatRuntime({ store, drivers: {}, api, workspace: new WorkspaceGateway(workspaces), handoffMs: 5 });

  try {
    const chat = runtime.create({ workspaceId: grant.id, pipeline: { preset: 'flagship', auto: false } });
    runtime.send(chat.id, { text: '模拟数据：验证缺少互参读取', clientMessageId: 'missing-read' });
    await runtime.idle();

    const cluster = chat.pipeline?.clusters[0];
    assert.equal(cluster?.status, 'failed');
    const crossAstra = cluster?.waves.at(-1)?.tasks.find(task => task.role === 'astra');
    assert.ok(crossAstra);
    const task = chat.tasks.find(item => item.id === crossAstra.taskId);
    assert.equal(task?.status, 'failed');
    assert.match(task?.error ?? '', /先使用 result_read 完整接收集群备忘录/u);
    assert.equal(task?.resultReadPages?.length ?? 0, 0);
    assert.equal(chat.tasks[0]?.status, 'waiting_user');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
