import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { createApiChatBinding } from '../src/chat/api-driver.js';
import { createProductionChatRuntime } from '../src/chat/bootstrap.js';
import { runCursorHostTools } from '../src/chat/drivers.js';
import { WorkspaceGateway } from '../src/chat/gateway.js';
import { createChatHttp, NativeDirectorySelector } from '../src/chat/http.js';
import { loadRoster, type ApiChatBinding, type Roster } from '../src/chat/roster.js';
import { ChatRuntime } from '../src/chat/runtime.js';
import { ChatStore } from '../src/chat/store.js';
import { SessionFiles } from '../src/chat/session-files.js';
import { submitExecutionReview } from '../src/chat/execution.js';
import type { ChatDriver, ChatRecord, ChatRole, DriverInput } from '../src/chat/types.js';
import { WorkspaceRegistry } from '../src/chat/workspace.js';
import { PlanCompletionError } from '../src/chat/plans.js';
import type { ExecTools } from '../src/exec/tools.js';
import { loadModelRegistry } from '../src/providers/registry.js';
import { ScriptedProvider, type ScriptedTurn } from '../src/providers/scripted.js';
import type { ProviderEvent } from '../src/providers/types.js';
import { createApp } from '../src/server/app.js';
import type { CursorWriteCapabilities } from '../src/adapters/cursor-writer.js';
import { makeHarness, tempDir } from './helpers.js';

const registry = loadModelRegistry('config');
const flagshipRoster = loadRoster('config/roster.json', registry);
const singleProviderRoster = loadRoster('config/presets/roster.single-provider.json', registry);

type Call = [name: string, args: Record<string, unknown>];

function toolResponse(...calls: Call[]): ProviderEvent[] {
  return [
    { type: 'usage', input: 40, cachedInput: 0, output: 20 },
    ...calls.map(([name, args], index) => ({ type: 'tool_call' as const, callId: `tool-${index}`, name, args })),
    { type: 'end', reason: 'tool_calls' },
  ];
}

function parseReceipts(turn: ScriptedTurn): Array<Record<string, unknown>> {
  return (turn.input.toolResults ?? []).map(result => JSON.parse(result.text) as Record<string, unknown>);
}

async function setupHttp(options: {
  api?: ApiChatBinding;
  pipelineRosters?: ReadonlyMap<string, Roster>;
  executor?: ExecTools;
  drivers?: Record<ChatRole, ChatDriver>;
  production?: boolean;
}) {
  const root = tempDir('dmw-custom-team-http-');
  const legacy = makeHarness();
  const wsRegistry = new WorkspaceRegistry(path.join(root, 'work'));
  const picker = new NativeDirectorySelector(wsRegistry);
  const gateway = new WorkspaceGateway(wsRegistry);
  const store = new ChatStore(root);
  const runtimeOptions = {
    store,
    drivers: options.drivers ?? {},
    ...(options.api ? { api: options.api } : {}),
    ...(options.pipelineRosters ? { pipelineRosters: options.pipelineRosters } : {}),
    ...(options.executor ? { executor: options.executor } : {}),
    workspace: gateway,
    requireCostConfirmation: true,
    handoffMs: 5,
  };
  const runtime = options.production ? createProductionChatRuntime(runtimeOptions) : new ChatRuntime(runtimeOptions);
  let handler: (req: IncomingMessage, res: ServerResponse) => Promise<unknown>;
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  legacy.config.port = port;
  const bridgeToken = randomUUID();
  const token = randomUUID();
  handler = createApp({
    config: legacy.config,
    orchestrator: legacy.orch,
    bus: legacy.bus,
    token,
    staticDir: path.join(root, 'static'),
    chatHttp: createChatHttp({ runtime, registry: wsRegistry, picker, bridgeToken, port, dataRoot: root }),
  });
  const base = `http://127.0.0.1:${port}`;
  const request = (url: string, method = 'GET', value?: unknown) =>
    fetch(`${base}${url}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-workbench-token': token },
      ...(value !== undefined ? { body: JSON.stringify(value) } : {}),
    });
  return {
    root,
    store,
    gateway,
    wsRegistry,
    runtime,
    request,
    close: async () => {
      try {
        await runtime.shutdown();
      } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

test('GET /api/chat-capabilities exposes partial API model availability and architecture-only preset readiness', async () => {
  const api = createApiChatBinding(flagshipRoster, registry, null, {
    offline: true,
    providerFor: model => {
      if (model.provider !== 'openai') throw new Error(`provider ${model.provider} unavailable`);
      return new ScriptedProvider(() => { throw new Error('must not invoke'); }, model.protocol);
    },
  });
  const fakeDockerExec = {
    capabilities: async () => ({ backend: 'docker' as const, available: true, unsafe: false }),
  } as unknown as ExecTools;
  const pipelineRosters = new Map([
    ['flagship', flagshipRoster],
    ['single-provider', singleProviderRoster],
  ]);
  const s = await setupHttp({ api, pipelineRosters, executor: fakeDockerExec });
  try {
    const res = await s.request('/api/chat-capabilities');
    assert.equal(res.status, 200);
    const data = await res.json() as {
      apiConfiguration: {
        mode: string;
        presets: Array<{ id: string; available: boolean; scope: string; architectureAvailable: boolean; reason?: string }>;
      };
      teamConfiguration: {
        driverMode: string;
        supported: boolean;
        defaultRoster: { rootSeat: string; seats: Array<{ id: string; available: boolean }> };
        options: Array<{ id: string; provider: string; available: boolean; reason?: string; authLabel: string; efforts: string[] }>;
      };
    };

    assert.equal(data.teamConfiguration.driverMode, 'api');
    assert.equal(data.teamConfiguration.supported, true);
    assert.equal(data.teamConfiguration.defaultRoster.rootSeat, 'claude');

    const openaiOptions = data.teamConfiguration.options.filter(o => o.provider === 'openai');
    const anthropicOptions = data.teamConfiguration.options.filter(o => o.provider === 'anthropic');
    assert.ok(openaiOptions.length > 0 && openaiOptions.every(o => o.available));
    assert.ok(anthropicOptions.length > 0 && anthropicOptions.every(o => !o.available && Boolean(o.reason)));
    assert.ok(openaiOptions.every(o => o.authLabel === 'API Key (OPENAI_API_KEY)'));

    const flagship = data.apiConfiguration.presets.find(p => p.id === 'flagship')!;
    const single = data.apiConfiguration.presets.find(p => p.id === 'single-provider')!;
    assert.equal(flagship.scope, 'full');
    assert.equal(flagship.available, false);
    assert.equal(flagship.architectureAvailable, false);
    assert.equal(single.scope, 'architecture_only');
    assert.equal(single.available, false);
    assert.equal(single.architectureAvailable, true);
    assert.match(single.reason ?? '', /不同厂商家族/);
  } finally {
    await s.close();
  }
});

test('GET /api/chat-capabilities exposes partial CLI subscription agents honestly', async () => {
  const drivers: Record<ChatRole, ChatDriver> = {
    claude: {
      capability: { role: 'claude', available: true, isolationVerified: true, model: 'claude-opus-5-5', effort: 'max', provider: 'anthropic' },
      invoke: async () => ({ text: 'ok', exitConfirmed: true }),
    },
    astra: {
      capability: { role: 'astra', available: true, isolationVerified: true, model: 'gpt-6.2-astra', effort: 'max', provider: 'openai' },
      invoke: async () => ({ text: 'ok', exitConfirmed: true }),
    },
    sol: {
      capability: { role: 'sol', available: false, isolationVerified: false, reason: '缺少 Codex 隔离证明', model: 'gpt-6.2-sol', effort: 'max', provider: 'openai' },
      invoke: async () => ({ text: '', exitConfirmed: true }),
    },
    grok: {
      capability: { role: 'grok', available: false, isolationVerified: false, reason: '缺少 Cursor WSL 能力记录', model: 'grok-4.7-high-fast', effort: 'high', provider: 'xai' },
      invoke: async () => ({ text: '', exitConfirmed: true }),
    },
  };
  const s = await setupHttp({ drivers });
  try {
    const res = await s.request('/api/chat-capabilities');
    assert.equal(res.status, 200);
    const data = await res.json() as {
      teamConfiguration: {
        driverMode: string;
        options: Array<{ id: string; available: boolean; reason?: string; authLabel: string; model?: string }>;
      };
    };
    assert.equal(data.teamConfiguration.driverMode, 'cli');
    assert.deepEqual(data.teamConfiguration.options.map(o => [o.id, o.available]), [
      ['claude', true],
      ['astra', true],
      ['sol', false],
      ['grok', false],
    ]);
    assert.match(data.teamConfiguration.options.find(o => o.id === 'astra')!.authLabel, /本地订阅 CLI/);
    assert.match(data.teamConfiguration.options.find(o => o.id === 'sol')!.reason ?? '', /隔离证明/);
  } finally {
    await s.close();
  }
});

test('POST /api/chats validates custom team config and fails closed on unavailable models (zero silent downgrade)', async () => {
  const api = createApiChatBinding(flagshipRoster, registry, null, {
    offline: true,
    providerFor: model => {
      if (model.id !== 'gpt-6.2-astra' && model.id !== 'deepseek-v4-pro') throw new Error('offline in fixture');
      return new ScriptedProvider(() => toolResponse(['task_complete', { result: 'ok' }]), model.protocol);
    },
  });
  const s = await setupHttp({ api });
  try {
    const project = path.join(s.root, 'proj');
    mkdirSync(project);
    const grant = s.wsRegistry.grantFromNativeSelection(project, s.wsRegistry.issueNativeSelectionRequest());

    // Combining team and pipeline -> 400
    assert.equal((await s.request('/api/chats', 'POST', {
      workspaceId: grant.id,
      pipeline: { preset: 'flagship', auto: false },
      team: { leadModel: 'gpt-6.2-astra', delegation: 'none' },
    })).status, 400);

    // Unknown model -> 400
    assert.equal((await s.request('/api/chats', 'POST', {
      team: { leadModel: 'nonexistent-model-9', delegation: 'none' },
    })).status, 400);

    // Unsupported effort -> 400
    assert.equal((await s.request('/api/chats', 'POST', {
      team: { leadModel: 'deepseek-v4-pro', leadEffort: 'xhigh', delegation: 'none' },
    })).status, 400);

    // requireAcceptanceReview: true without reviewer -> 400
    assert.equal((await s.request('/api/chats', 'POST', {
      team: { leadModel: 'gpt-6.2-astra', members: ['deepseek-v4-pro'], delegation: 'proactive', requireAcceptanceReview: true },
    })).status, 400);

    // Unavailable leadModel -> 503 (never silently downgrades to gpt-6.2-astra!)
    const unavailLead = await s.request('/api/chats', 'POST', {
      team: { leadModel: 'claude-fable-5-2', delegation: 'none' },
    });
    assert.equal(unavailLead.status, 503);

    // Unavailable subordinate -> 503
    const unavailMember = await s.request('/api/chats', 'POST', {
      team: { leadModel: 'gpt-6.2-astra', members: ['gemini-4-carbon'], delegation: 'proactive' },
    });
    assert.equal(unavailMember.status, 503);

    // Valid partial-model custom team -> 201 + persisted in list & snapshot
    const created = await s.request('/api/chats', 'POST', {
      title: '双模型自由编排',
      team: {
        leadModel: 'deepseek-v4-pro',
        leadLabel: 'DeepSeek 主控',
        delegation: 'proactive',
        members: [{ model: 'gpt-6.2-astra', label: 'Astra 分析师', role: 'collaborator' }],
      },
    });
    assert.equal(created.status, 201);
    const record = await created.json() as ChatRecord;
    assert.equal(record.team?.lead.model, 'deepseek-v4-pro');
    assert.equal(record.team?.lead.seatId, 'deepseek-v4-pro');
    assert.equal(record.team?.delegation, 'proactive');
    assert.equal(record.team?.requireAcceptanceReview, false);
    assert.equal(record.team?.members.length, 1);
    assert.equal(record.team?.members[0]?.model, 'gpt-6.2-astra');

    const list = await (await s.request('/api/chats')).json() as Array<{ id: string; team?: ChatRecord['team'] }>;
    assert.equal(list.find(c => c.id === record.id)?.team?.lead.model, 'deepseek-v4-pro');

    const snapshot = await (await s.request(`/api/chats/${record.id}`)).json() as {
      chat: ChatRecord;
      capabilities: Array<{ role: string; model?: string; available: boolean }>;
    };
    assert.deepEqual(snapshot.capabilities.map(c => c.role), ['deepseek-v4-pro', 'gpt-6-2-astra']);
    assert.ok(snapshot.capabilities.every(c => c.available));
  } finally {
    await s.close();
  }
});

test('API custom Lead dispatches authorized subordinate, rejects unauthorized target, and completes without acceptance deadlock', async () => {
  let leadStage = 0;
  let childId = '';
  let sawProactivePrompt = false;
  let sawLeadTools: string[] = [];
  let sawDelegateEnum: string[] = [];

  const script = (turn: ScriptedTurn): ProviderEvent[] => {
    const model = turn.init.model.id;
    if (model === 'gpt-6.2-astra') {
      assert.ok(!turn.init.tools.some(t => t.name === 'agent_submit'));
      return toolResponse(['task_complete', { result: '模拟数据：Astra 协作者分析完成' }]);
    }
    assert.equal(model, 'deepseek-v4-pro');
    sawProactivePrompt = turn.init.system.includes('主动委派');
    sawLeadTools = turn.init.tools.map(t => t.name);
    const submitTool = turn.init.tools.find(t => t.name === 'agent_submit');
    sawDelegateEnum = ((submitTool?.inputSchema.properties as { role?: { enum?: string[] } } | undefined)?.role?.enum) ?? [];

    leadStage++;
    if (leadStage === 1) {
      return toolResponse(['agent_submit', { role: 'gpt-6-2-astra', mode: 'read', goal: '请分析模块边界' }]);
    }
    if (leadStage === 2) {
      const first = parseReceipts(turn)[0] as unknown as Array<{ taskId: string }>;
      childId = first[0]!.taskId;
      return toolResponse(['task_collect', { taskIds: [childId], wait: true }]);
    }
    if (leadStage === 3) {
      return toolResponse(['task_collect', { taskIds: [childId], wait: false }]);
    }
    return toolResponse(
      ['task_disposition', { taskId: childId, disposition: 'adopted' }],
      ['task_complete', { result: '模拟数据：DeepSeek 主 Agent 综合交付' }],
    );
  };

  const api = createApiChatBinding(flagshipRoster, registry, null, {
    offline: true,
    providerFor: model => {
      if (model.id !== 'deepseek-v4-pro' && model.id !== 'gpt-6.2-astra') throw new Error('offline');
      return new ScriptedProvider(script, model.protocol);
    },
  });
  const s = await setupHttp({ api, production: true });
  try {
    const chat = s.runtime.create({
      team: {
        leadModel: 'deepseek-v4-pro',
        delegation: 'proactive',
        members: [{ model: 'gpt-6.2-astra', role: 'collaborator' }],
      },
    });
    s.runtime.send(chat.id, { text: '用我仅有的两个模型协作分析', clientMessageId: 'custom-api-1', confirmCost: true });
    await s.runtime.idle();

    assert.equal(sawProactivePrompt, true);
    assert.deepEqual(sawDelegateEnum, ['gpt-6-2-astra']);
    assert.ok(!sawLeadTools.includes('worker_submit'));
    assert.ok(!sawLeadTools.includes('fanout_submit'));
    assert.equal(chat.tasks.length, 2);
    assert.equal(chat.tasks[0]?.role, 'deepseek-v4-pro');
    assert.equal(chat.tasks[0]?.status, 'completed', chat.tasks[0]?.error);
    assert.equal(chat.tasks[1]?.role, 'gpt-6-2-astra');
    assert.equal(chat.tasks[1]?.status, 'completed');
    assert.equal(chat.tasks[1]?.disposition, 'adopted');
  } finally {
    await s.close();
  }
});

test('API custom team enforces delegation:none, blocks unauthorized targets, and supports allowLeadWrite solo editing', async () => {
  const project = tempDir('dmw-custom-solo-proj-');
  const seenTools = new Map<string, string[]>();
  const api = createApiChatBinding(flagshipRoster, registry, null, {
    offline: true,
    providerFor: model => {
      if (model.id !== 'gpt-6.2-sol' && model.id !== 'gpt-6.2-astra' && model.id !== 'deepseek-v4-pro') throw new Error('offline');
      return new ScriptedProvider(turn => {
        seenTools.set(turn.init.cacheKey, turn.init.tools.map(t => t.name));
        if (turn.init.model.id === 'gpt-6.2-sol') {
          if (turn.turn === 1) {
            return toolResponse(['file_write', { path: 'solo.txt', text: 'lead wrote directly', expectedHash: null }]);
          }
          return toolResponse(['task_complete', { result: '模拟数据：单模型主 Agent 写入完成' }]);
        }
        if (turn.init.model.id === 'deepseek-v4-pro') {
          // Has delegation:'explicit' for gpt-6.2-sol only, tries to dispatch unauthorized 'gpt-6-2-astra'
          return toolResponse(['agent_submit', { role: 'gpt-6-2-astra', mode: 'read', goal: 'unauthorized target' }]);
        }
        // delegation:'none' lead completes solo; tool list must NOT contain agent_submit
        return toolResponse(['task_complete', { result: '模拟数据：禁止调度模式下独立完成' }]);
      }, model.protocol);
    },
  });
  const s = await setupHttp({ api, production: true });
  try {
    const grant = s.wsRegistry.grantFromNativeSelection(project, s.wsRegistry.issueNativeSelectionRequest());

    // 1. Solo allowLeadWrite with delegation:'none'
    const soloChat = s.runtime.create({
      workspaceId: grant.id,
      team: { leadModel: 'gpt-6.2-sol', delegation: 'none', allowLeadWrite: true },
    });
    s.runtime.send(soloChat.id, { text: '直接写入 solo.txt', clientMessageId: 'solo-1', confirmCost: true });
    await s.runtime.idle();

    const soloRoot = soloChat.tasks[0]!;
    assert.equal(soloRoot.mode, 'edit');
    assert.equal(soloRoot.status, 'completed', soloRoot.error);
    assert.equal(readFileSync(path.join(project, 'solo.txt'), 'utf8'), 'lead wrote directly');
    const soloTools = seenTools.get(soloRoot.id) ?? [];
    assert.ok(soloTools.includes('file_write'));
    assert.ok(!soloTools.includes('agent_submit'));

    // 2. delegation:'none' with listed member still strips delegation tools completely
    const lockedChat = s.runtime.create({
      team: { leadModel: 'gpt-6.2-astra', members: ['gpt-6.2-sol'], delegation: 'none' },
    });
    s.runtime.send(lockedChat.id, { text: '验证禁止调度模式', clientMessageId: 'locked-1', confirmCost: true });
    await s.runtime.idle();
    const lockedRoot = lockedChat.tasks[0]!;
    assert.equal(lockedRoot.status, 'completed', lockedRoot.error);
    assert.ok(!(seenTools.get(lockedRoot.id) ?? []).includes('agent_submit'));
    assert.equal(lockedChat.tasks.length, 1);

    // 3. delegation:'explicit' rejects dispatching an unauthorized model target (runtime 403)
    const unauthorizedChat = s.runtime.create({
      team: { leadModel: 'deepseek-v4-pro', members: ['gpt-6.2-sol'], delegation: 'explicit' },
    });
    s.runtime.send(unauthorizedChat.id, { text: '尝试越权派发未授权模型', clientMessageId: 'unauth-1', confirmCost: true });
    await s.runtime.idle();
    assert.equal(unauthorizedChat.tasks[0]?.status, 'failed');
    assert.match(unauthorizedChat.tasks[0]?.error ?? '', /不在当前任务允许的委派目标中/);
    assert.equal(unauthorizedChat.tasks.length, 1);
  } finally {
    await s.close();
    rmSync(project, { recursive: true, force: true });
  }
});

test('API custom team with reviewer member enforces independent execution_review via custom reviewer seat', async () => {
  let leadStage = 0;
  let reviewId = '';
  let reviewerStage = 0;
  let reviewerSawHint = false;
  let reviewContractHash = '';
  let reviewEvidenceHash = '';
  let reviewReportRef = '';
  let pendingReads: string[] = [];

  const api = createApiChatBinding(flagshipRoster, registry, null, {
    offline: true,
    providerFor: model => {
      if (model.id !== 'gpt-6.2-sol' && model.id !== 'claude-opus-5-5') throw new Error('offline');
      return new ScriptedProvider(turn => {
        if (model.id === 'claude-opus-5-5') {
          reviewerSawHint = turn.init.system.includes('执行评审契约v1');
          assert.ok(turn.init.tools.some(t => t.name === 'execution_submit_review'));
          reviewerStage++;
          if (reviewerStage === 1) return toolResponse(['execution_read', {}]);
          if (reviewerStage === 2) {
            const overview = parseReceipts(turn)[0] as { contractHash: string; evidenceHash: string; viewRef: string };
            reviewContractHash = overview.contractHash;
            reviewEvidenceHash = overview.evidenceHash;
            return toolResponse(['result_read', { ref: overview.viewRef, offset: 0 }]);
          }
          if (reviewerStage === 3) {
            const rawText = (turn.input.toolResults?.[0]?.text ?? '').replace(/^\[程序分页[^\n]*\n/, '');
            const view = JSON.parse(rawText) as { requiredRefs: Array<{ ref: string; kind: string }> };
            pendingReads = [...new Set(view.requiredRefs.filter(r => r.kind !== 'file').map(r => r.ref))];
            return toolResponse(...pendingReads.map(ref => ['result_read', { ref, offset: 0 }] as Call));
          }
          if (reviewerStage === 4) {
            return toolResponse(['artifact_publish', { name: 'custom-review.md', text: 'passed all checks', kind: 'report' }]);
          }
          if (reviewerStage === 5) {
            const report = parseReceipts(turn)[0] as { id: string; relativePath: string };
            reviewReportRef = report.relativePath;
            return toolResponse(['execution_submit_review', {
              contractHash: reviewContractHash,
              evidenceHash: reviewEvidenceHash,
              outcome: 'passed',
              stepVerdicts: [
                { stepId: 'step-1', outcome: 'passed' },
                { stepId: 'step-2', outcome: 'passed' },
              ],
              reportArtifactId: report.id,
            }]);
          }
          return toolResponse(['task_complete', { result: '模拟数据：自定义 reviewer 验收通过' }]);
        }
        leadStage++;
        if (leadStage === 1) {
          return toolResponse(
            ['plan_update', {
              revision: 0,
              steps: [
                { id: 'step-1', text: '生成报告', status: 'in_progress', verification: { kind: 'artifact', name: 'out.md' } },
                { id: 'step-2', text: '复核摘要', status: 'pending', dependsOn: ['step-1'], verification: { kind: 'artifact', name: 'sum.md' } },
              ],
            }],
            ['artifact_publish', { name: 'out.md', text: 'body', kind: 'file' }],
            ['artifact_publish', { name: 'sum.md', text: 'summary', kind: 'file' }],
          );
        }
        if (leadStage === 2) {
          const arts = parseReceipts(turn).slice(1) as Array<{ relativePath: string }>;
          return toolResponse(['plan_update', {
            revision: 1,
            steps: [
              { id: 'step-1', text: '生成报告', status: 'completed', evidenceRefs: [arts[0]!.relativePath] },
              { id: 'step-2', text: '复核摘要', status: 'completed', evidenceRefs: [arts[1]!.relativePath] },
            ],
          }]);
        }
        if (leadStage === 3) {
          return toolResponse(['agent_submit', { role: 'claude-opus-5-5', mode: 'verify', purpose: 'execution_review', goal: '独立执行评审' }]);
        }
        if (leadStage === 4) {
          const submitted = parseReceipts(turn)[0] as unknown as Array<{ taskId: string }>;
          reviewId = submitted[0]!.taskId;
          return toolResponse(['task_collect', { taskIds: [reviewId], wait: true }]);
        }
        if (leadStage === 5) {
          return toolResponse(['result_read', { ref: reviewReportRef, offset: 0 }]);
        }
        return toolResponse(
          ['task_disposition', { taskId: reviewId, disposition: 'adopted' }],
          ['task_complete', { result: '模拟数据：自定义 reviewer 验收通过后主 Agent 交付完成' }],
        );
      }, model.protocol);
    },
  });
  const s = await setupHttp({ api, production: true });
  try {
    const chat = s.runtime.create({
      team: {
        leadModel: 'gpt-6.2-sol',
        delegation: 'explicit',
        members: [{ model: 'claude-opus-5-5', role: 'reviewer' }],
      },
    });
    assert.equal(chat.team?.requireAcceptanceReview, true);
    s.runtime.send(chat.id, { text: '多步交付并由自定义 reviewer 评审', clientMessageId: 'rev-1', confirmCost: true });
    await s.runtime.idle();
    const reviewerTask = chat.tasks.find(t => t.role === 'claude-opus-5-5');
    assert.ok(reviewerTask, 'custom reviewer seat must have been spawned');
    assert.equal(reviewerTask.executionReviewOfTaskId, chat.tasks[0]?.id);
    assert.equal(reviewerTask.status, 'completed', reviewerTask.error);
    assert.equal(chat.tasks[0]?.status, 'completed', chat.tasks[0]?.error);
    assert.equal(reviewerSawHint, true, 'context.ts must inject execution review hint for non-astra reviewer seat');
  } finally {
    await s.close();
  }
});

test('CLI mode unbinds rootSeat so Astra (Codex) can lead and dispatch Claude (writer) without hardcoded claude root', async () => {
  const project = tempDir('dmw-cli-custom-lead-proj-');
  const seenByRole = new Map<string, { tools: string[]; system: string }>();

  const makeDriver = (role: ChatRole, available: boolean): ChatDriver => ({
    capability: {
      role,
      available,
      isolationVerified: available,
      model: role === 'claude' ? 'claude-opus-5-5' : role === 'astra' ? 'gpt-6.2-astra' : role === 'sol' ? 'gpt-6.2-sol' : 'grok-4.7-high-fast',
      effort: role === 'grok' ? 'high' : 'max',
      provider: role === 'claude' ? 'anthropic' : role === 'grok' ? 'xai' : 'openai',
    },
    async invoke(input: DriverInput) {
      seenByRole.set(role, { tools: input.tools.map(t => t.name), system: input.systemPrompt });
      if (role === 'claude') {
        assert.equal(input.task.mode, 'edit');
        assert.ok(input.tools.some(t => t.name === 'file_write'), 'claude writer subordinate must get file_write');
        assert.ok(!input.tools.some(t => t.name === 'ask_user'), 'subordinate claude must NOT get ask_user');
        await input.callTool('file_write', { path: 'from-claude-child.txt', text: 'written by subordinate claude', expectedHash: null });
        await input.callTool('task_complete', { result: 'Claude 子任务已写入文件' });
        return { text: 'Claude 子任务已写入文件', exitConfirmed: true };
      }
      assert.equal(role, 'astra');
      const submitTool = input.tools.find(t => t.name === 'agent_submit');
      assert.ok(submitTool, 'astra Lead must receive agent_submit');
      assert.deepEqual((submitTool.inputSchema.properties as { role: { enum: string[] } }).role.enum, ['claude']);
      assert.ok(input.tools.some(t => t.name === 'ask_user'), 'astra Lead must receive ask_user');
      assert.ok(!input.tools.some(t => t.name === 'grok_submit'), 'grok_submit must be hidden when grok is not selected');

      if (input.task.segment === 1) {
        const sub = await input.callTool('agent_submit', { role: 'claude', mode: 'edit', goal: '写入 from-claude-child.txt' });
        const submitted = JSON.parse(sub.text) as Array<{ taskId: string }>;
        await input.callTool('grok_collect', { taskIds: [submitted[0]!.taskId], wait: true });
        return { text: '', exitConfirmed: true };
      }
      const collected = JSON.parse((await input.callTool('grok_collect', { wait: false })).text) as Array<{ taskId: string; status: string }>;
      assert.equal(collected[0]?.status, 'completed');
      await input.callTool('grok_disposition', { taskId: collected[0]!.taskId, disposition: 'adopted' });
      await input.callTool('task_complete', { result: 'Astra 主 Agent 已完成并交付' });
      return { text: 'Astra 主 Agent 已完成并交付', exitConfirmed: true };
    },
  });

  const drivers: Record<ChatRole, ChatDriver> = {
    claude: makeDriver('claude', true),
    astra: makeDriver('astra', true),
    sol: makeDriver('sol', false),
    grok: makeDriver('grok', false),
  };
  const s = await setupHttp({ drivers, production: true });
  try {
    const grant = s.wsRegistry.grantFromNativeSelection(project, s.wsRegistry.issueNativeSelectionRequest());

    // Self-delegation and unavailable CLI member are rejected cleanly
    assert.equal((await s.request('/api/chats', 'POST', {
      team: { leadModel: 'astra', members: ['astra'], delegation: 'proactive' },
    })).status, 400);
    assert.equal((await s.request('/api/chats', 'POST', {
      team: { leadModel: 'astra', members: ['sol'], delegation: 'proactive' },
    })).status, 503);

    const createRes = await s.request('/api/chats', 'POST', {
      title: 'Astra 主控 CLI 团队',
      workspaceId: grant.id,
      team: {
        leadModel: 'astra',
        delegation: 'proactive',
        members: [{ model: 'claude', role: 'writer' }],
      },
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json() as ChatRecord;
    assert.equal(created.apiRoster, undefined, 'CLI custom chat must NOT set apiRoster');
    assert.equal(created.cliRoster?.rootSeat, 'astra');
    assert.equal(created.team?.driverMode, 'cli');
    assert.equal(created.team?.lead.seatId, 'astra');
    assert.equal(created.team?.lead.model, 'gpt-6.2-astra');

    s.runtime.send(created.id, { text: '由 Astra 调度 Claude 落盘文件', clientMessageId: 'cli-lead-1', confirmCost: true });
    await s.runtime.idle();

    const finalChat = s.runtime.get(created.id);
    assert.equal(finalChat.tasks.length, 2);
    assert.equal(finalChat.tasks[0]?.role, 'astra');
    assert.equal(finalChat.tasks[0]?.status, 'completed', finalChat.tasks[0]?.error);
    assert.equal(finalChat.tasks[1]?.role, 'claude');
    assert.equal(finalChat.tasks[1]?.status, 'completed');
    assert.equal(readFileSync(path.join(project, 'from-claude-child.txt'), 'utf8'), 'written by subordinate claude');
    assert.ok(seenByRole.get('astra')?.system.includes('自定义 CLI 团队名册事实'), 'custom CLI lead must receive dynamic roster facts');
    assert.ok(!seenByRole.get('astra')?.system.includes('只对 Claude 的共同方案返回增量意见'), 'custom CLI lead must not get contradictory static Astra prompt');
  } finally {
    await s.close();
    rmSync(project, { recursive: true, force: true });
  }
});

test('runCursorHostTools surfaces recoverable PlanCompletionError via safePlanFeedback instead of crashing Cursor root', async () => {
  const tmp = tempDir('dmw-cursor-plan-feedback-');
  try {
    let round = 0;
    const isolation: CursorWriteCapabilities = {
      verifiedAt: '2026-10-23T12:16:49.6201831Z',
      cliVersion: '2026.10.22-27dcf5f',
      model: 'grok-4.7-high-fast',
      reportedModel: 'Grok 4.7 256K High Fast',
      distro: 'codex-cursor-h7',
      machineId: 'a'.repeat(32),
      nodePath: '/opt/cursor-agent/versions/2026.10.22-27dcf5f/node',
      entryPath: '/opt/cursor-agent/versions/2026.10.22-27dcf5f/index.js',
      nodeSha256: '0'.repeat(64),
      entrySha256: '1'.repeat(64),
      kernel: '6.18.33.2-microsoft-standard-WSL2',
      bwrapPath: '/usr/bin/bwrap',
      bwrapSha256: '2'.repeat(64),
      setsidPath: '/usr/bin/setsid',
      setsidSha256: '3'.repeat(64),
      toolPolicy: 'workspace_edits_only',
      commandExitEventsVerified: true,
      fileChangesVerified: true,
      workspaceWriteVerified: true,
      isolatedWorkspaceVerified: true,
      terminationVerified: true,
    };
    const result = await runCursorHostTools({
      chatId: 'c1',
      directory: tmp,
      systemPrompt: 'sys',
      prompt: 'go',
      signal: new AbortController().signal,
      task: { id: 't1', turnId: 'turn1', role: 'grok', goal: 'lead', status: 'running', createdAt: '', updatedAt: '', segment: 1, invocationIds: [], noProgressSegments: 0, mode: 'read' },
      invocation: { id: 'i1', taskId: 't1', segment: 1, status: 'running', startedAt: '', toolCount: 0, promptVersion: 'v1', inputEstimate: 0, contextWindow: null, contextUsed: null },
      tools: [{ name: 'task_complete', description: 'complete', inputSchema: { type: 'object' } }],
      onText: () => {},
      callTool: async () => {
        if (round === 1) throw new PlanCompletionError({ steps: [{ stepId: 's1', status: 'pending' }] });
        return { text: '{"submitted":true}', stop: 'completed' };
      },
    }, isolation, async opts => {
      round++;
      const response = round === 1
        ? JSON.stringify({ tool: 'task_complete', arguments: { result: 'early' } })
        : JSON.stringify({ result: 'recovered after feedback' });
      if (round === 2) assert.match(opts.prompt, /PLAN_INCOMPLETE/);
      opts.onStdoutLine?.(JSON.stringify({ type: 'system', subtype: 'init', model: isolation.reportedModel, cwd: '/workspace' }));
      opts.onStdoutLine?.(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: response }));
      return { command: [], exitCode: 0, signal: null, timedOut: false, cancelled: false, spawnError: null, stdoutTail: '', stderrTail: '', durationMs: 1, pid: 1, removedEnv: [], exitConfirmed: true };
    });
    assert.equal(result.exitConfirmed, true);
    assert.equal(result.text, 'recovered after feedback');
    assert.equal(round, 2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('default API chat filters unavailable seats and pools out of lead tool enums when only a subset of models is online', async () => {
  let leadDelegateEnum: string[] = [];
  let sawWorkerSubmit = false;
  const api = createApiChatBinding(flagshipRoster, registry, null, {
    offline: true,
    providerFor: model => {
      // Only Anthropic lead (claude-fable-5-2) and OpenAI Astra (gpt-6.2-astra) are online;
      // opus, carbon, sol, grok, hydrogen, deepseek, haiku are all offline.
      if (model.id !== 'claude-fable-5-2' && model.id !== 'gpt-6.2-astra') throw new Error('offline');
      return new ScriptedProvider(turn => {
        const submit = turn.init.tools.find(t => t.name === 'agent_submit');
        leadDelegateEnum = ((submit?.inputSchema.properties as { role?: { enum?: string[] } } | undefined)?.role?.enum) ?? [];
        sawWorkerSubmit = turn.init.tools.some(t => t.name === 'worker_submit' || t.name === 'fanout_submit');
        return toolResponse(['task_complete', { result: '模拟数据：仅暴露在线席位' }]);
      }, model.protocol);
    },
  });
  const s = await setupHttp({ api });
  try {
    const chat = s.runtime.create({});
    s.runtime.send(chat.id, { text: '测试部分模型在线时的工具枚举过滤', clientMessageId: 'partial-default-1', confirmCost: true });
    await s.runtime.idle();
    assert.equal(chat.tasks[0]?.status, 'completed', chat.tasks[0]?.error);
    assert.deepEqual(leadDelegateEnum, ['astra']);
    assert.equal(sawWorkerSubmit, false);
  } finally {
    await s.close();
  }
});

test('frozen custom team preserves offline member in agent_submit and fails closed (503) instead of silently downgrading', async () => {
  // 1. CLI frozen custom team: member goes offline after chat creation
  let cliLeadEnum: string[] = [];
  let cliDispatchError = '';
  const claudeDriver: ChatDriver = {
    capability: { role: 'claude', available: true, isolationVerified: true, model: 'claude-opus-5-5', effort: 'max', provider: 'anthropic' },
    async invoke() {
      throw new Error('offline claude driver must never be invoked');
    },
  };
  const astraDriver: ChatDriver = {
    capability: { role: 'astra', available: true, isolationVerified: true, model: 'gpt-6.2-astra', effort: 'max', provider: 'openai' },
    async invoke(input: DriverInput) {
      const submit = input.tools.find(t => t.name === 'agent_submit');
      cliLeadEnum = ((submit?.inputSchema.properties as { role?: { enum?: string[] } } | undefined)?.role?.enum) ?? [];
      try {
        await input.callTool('agent_submit', { role: 'claude', mode: 'read', goal: '尝试派发已离线成员' });
      } catch (err) {
        cliDispatchError = err instanceof Error ? err.message : String(err);
      }
      await input.callTool('task_fail', { reason: cliDispatchError || 'dispatch failed' });
      return { text: '', exitConfirmed: true };
    },
  };
  const cliServer = await setupHttp({
    drivers: {
      claude: claudeDriver,
      astra: astraDriver,
      sol: { capability: { role: 'sol', available: false, isolationVerified: false, reason: 'offline' }, async invoke() { throw new Error('offline'); } },
      grok: { capability: { role: 'grok', available: false, isolationVerified: false, reason: 'offline' }, async invoke() { throw new Error('offline'); } },
    },
    production: true,
  });
  try {
    const created = cliServer.runtime.create({
      team: { leadModel: 'astra', members: [{ model: 'claude', role: 'collaborator' }], delegation: 'proactive' },
    });
    // Simulate mid-session credential revocation / offline transition after roster freeze
    claudeDriver.capability = { role: 'claude', available: false, isolationVerified: false, reason: 'Claude 登录已失效' };
    cliServer.runtime.send(created.id, { text: '触发离线成员派发校验', clientMessageId: 'cli-offline-1', confirmCost: true });
    await cliServer.runtime.idle();
    assert.deepEqual(cliLeadEnum, ['claude'], 'frozen custom team must NOT silently hide offline members from agent_submit');
    assert.match(cliDispatchError, /Claude 登录已失效/);
  } finally {
    await cliServer.close();
  }

  // 2. API frozen custom team: member goes offline after chat creation
  let memberOnline = true;
  let apiLeadEnum: string[] = [];
  const api = createApiChatBinding(flagshipRoster, registry, null, {
    offline: true,
    providerFor: model => {
      if (model.id !== 'gpt-6.2-sol' && !(model.id === 'deepseek-v4-pro' && memberOnline)) {
        throw new Error(`${model.id} 凭证已失效`);
      }
      return new ScriptedProvider(turn => {
        const submit = turn.init.tools.find(t => t.name === 'agent_submit');
        apiLeadEnum = ((submit?.inputSchema.properties as { role?: { enum?: string[] } } | undefined)?.role?.enum) ?? [];
        return toolResponse(['agent_submit', { role: 'deepseek-v4-pro', mode: 'read', goal: '派发已离线 API 成员' }]);
      }, model.protocol);
    },
  });
  const apiServer = await setupHttp({ api, production: true });
  try {
    const created = apiServer.runtime.create({
      team: { leadModel: 'gpt-6.2-sol', members: [{ model: 'deepseek-v4-pro', role: 'collaborator' }], delegation: 'proactive' },
    });
    memberOnline = false;
    apiServer.runtime.send(created.id, { text: '触发 API 离线成员派发校验', clientMessageId: 'api-offline-1', confirmCost: true });
    await apiServer.runtime.idle();
    assert.deepEqual(apiLeadEnum, ['deepseek-v4-pro'], 'frozen API custom team must keep offline member in agent_submit');
    assert.equal(created.tasks.length, 1, 'offline frozen member must fail closed before spawning any child task');
    assert.equal(created.tasks[0]?.status, 'failed');
    assert.match(created.tasks[0]?.error ?? '', /无法创建模拟 Provider|凭证已失效|未配置或未验证/);
  } finally {
    await apiServer.close();
  }
});

test('custom reviewer team completion & review errors reference custom reviewer seat without hardcoded Astra or Sol', async () => {
  const project = tempDir('dmw-custom-reviewer-msg-');
  let mode: 'workspace-early' | 'unadopted-review' = 'workspace-early';
  let leadStage = 0;
  let nonReviewerError = '';
  let unadoptedFeedback = '';
  let reviewId = '';
  let reviewStage = 0;
  let reviewContractHash = '';
  let reviewEvidenceHash = '';
  let reviewReportRef = '';

  const api = createApiChatBinding(flagshipRoster, registry, null, {
    offline: true,
    providerFor: model => {
      if (model.id !== 'gpt-6.2-sol' && model.id !== 'claude-opus-5-5') throw new Error('offline');
      return new ScriptedProvider(turn => {
        if (model.id === 'claude-opus-5-5') {
          const submitTool = turn.init.tools.find(t => t.name === 'execution_submit_review');
          assert.ok(submitTool && !submitTool.description.includes('Astra'), 'custom team execution_submit_review description must not hardcode Astra');
          reviewStage++;
          if (reviewStage === 1) return toolResponse(['execution_read', {}]);
          if (reviewStage === 2) {
            const overview = parseReceipts(turn)[0] as { contractHash: string; evidenceHash: string; viewRef: string };
            reviewContractHash = overview.contractHash;
            reviewEvidenceHash = overview.evidenceHash;
            return toolResponse(['result_read', { ref: overview.viewRef, offset: 0 }]);
          }
          if (reviewStage === 3) {
            const rawText = (turn.input.toolResults?.[0]?.text ?? '').replace(/^\[程序分页[^\n]*\n/, '');
            const view = JSON.parse(rawText) as { requiredRefs: Array<{ ref: string; kind: string }> };
            const refs = [...new Set(view.requiredRefs.filter(r => r.kind !== 'file').map(r => r.ref))];
            return toolResponse(...refs.map(ref => ['result_read', { ref, offset: 0 }] as Call));
          }
          if (reviewStage === 4) {
            return toolResponse(['artifact_publish', { name: 'rev.md', text: 'reviewed', kind: 'report' }]);
          }
          if (reviewStage === 5) {
            const report = parseReceipts(turn)[0] as { id: string; relativePath: string };
            reviewReportRef = report.relativePath;
            return toolResponse(['execution_submit_review', {
              contractHash: reviewContractHash,
              evidenceHash: reviewEvidenceHash,
              outcome: 'passed',
              stepVerdicts: [{ stepId: 's1', outcome: 'passed' }, { stepId: 's2', outcome: 'passed' }],
              reportArtifactId: report.id,
            }]);
          }
          return toolResponse(['task_complete', { result: '模拟数据：自定义 reviewer 完成评审' }]);
        }
        if (mode === 'workspace-early') {
          leadStage++;
          if (leadStage === 1) {
            return toolResponse(['file_write', { path: 'app.txt', text: 'v1', expectedHash: null }]);
          }
          return toolResponse(['task_complete', { result: '未做独立验证就完成' }]);
        }
        leadStage++;
        if (leadStage === 1) {
          return toolResponse(
            ['plan_update', {
              revision: 0,
              steps: [
                { id: 's1', text: '写报告', status: 'in_progress', verification: { kind: 'artifact', name: 'a1.md' } },
                { id: 's2', text: '补摘要', status: 'pending', dependsOn: ['s1'], verification: { kind: 'artifact', name: 'a2.md' } },
              ],
            }],
            ['artifact_publish', { name: 'a1.md', text: 'a1', kind: 'file' }],
            ['artifact_publish', { name: 'a2.md', text: 'a2', kind: 'file' }],
          );
        }
        if (leadStage === 2) {
          const arts = parseReceipts(turn).slice(1) as Array<{ relativePath: string }>;
          return toolResponse(['plan_update', {
            revision: 1,
            steps: [
              { id: 's1', text: '写报告', status: 'completed', evidenceRefs: [arts[0]!.relativePath] },
              { id: 's2', text: '补摘要', status: 'completed', evidenceRefs: [arts[1]!.relativePath] },
            ],
          }]);
        }
        if (leadStage === 3) {
          return toolResponse(['agent_submit', { role: 'claude-opus-5-5', mode: 'verify', purpose: 'execution_review', goal: '独立验收' }]);
        }
        if (leadStage === 4) {
          const submitted = parseReceipts(turn)[0] as unknown as Array<{ taskId: string }>;
          reviewId = submitted[0]!.taskId;
          return toolResponse(['task_collect', { taskIds: [reviewId], wait: true }]);
        }
        if (leadStage === 5) {
          // Dispose as 'reference' (not 'adopted') so execution.ts reviewer adoption check fires
          return toolResponse(
            ['result_read', { ref: reviewReportRef, offset: 0 }],
            ['task_disposition', { taskId: reviewId, disposition: 'reference' }],
            ['task_complete', { result: '未采用 reviewer 即完成' }],
          );
        }
        unadoptedFeedback = turn.input.toolResults?.[2]?.text ?? '';
        return toolResponse(['task_fail', { reason: '完成自定义 reviewer 文案验证' }]);
      }, model.protocol);
    },
  });
  const s = await setupHttp({ api, production: true });
  try {
    // 1. Gateway completionIssues wording when source was modified without custom reviewer snapshot
    const grant = s.wsRegistry.grantFromNativeSelection(project, s.wsRegistry.issueNativeSelectionRequest());
    const wsChat = s.runtime.create({
      workspaceId: grant.id,
      team: {
        leadModel: 'gpt-6.2-sol',
        allowLeadWrite: true,
        delegation: 'explicit',
        members: [{ model: 'claude-opus-5-5', role: 'reviewer' }],
      },
    });
    s.runtime.send(wsChat.id, { text: '验证工作区自定义 reviewer 报错文案', clientMessageId: 'rev-ws-1', confirmCost: true });
    await s.runtime.idle();
    assert.equal(wsChat.tasks[0]?.status, 'failed');
    assert.match(wsChat.tasks[0]?.error ?? '', /claude-opus-5-5/);
    assert.doesNotMatch(wsChat.tasks[0]?.error ?? '', /Astra|Sol/);

    // 2. Execution review unadopted reviewer wording + submitExecutionReview 403 wording
    mode = 'unadopted-review';
    leadStage = 0;
    const revChat = s.runtime.create({
      team: {
        leadModel: 'gpt-6.2-sol',
        delegation: 'explicit',
        members: [{ model: 'claude-opus-5-5', role: 'reviewer' }],
      },
    });
    s.runtime.send(revChat.id, { text: '验证执行评审自定义 reviewer 文案', clientMessageId: 'rev-msg-1', confirmCost: true });
    await s.runtime.idle();
    assert.match(unadoptedFeedback, /独立评审席位（claude-opus-5-5）评审任务尚未安全完成并由根任务采用/);
    assert.doesNotMatch(unadoptedFeedback, /Astra/);

    const files = new SessionFiles(s.store);
    try {
      submitExecutionReview(revChat, revChat.tasks[0]!, {}, s.store, files, () => 'auth');
    } catch (err) {
      nonReviewerError = err instanceof Error ? err.message : String(err);
    }
    assert.match(nonReviewerError, /仅绑定的独立验收评审任务可提交执行评审/);
    assert.doesNotMatch(nonReviewerError, /Astra/);
  } finally {
    await s.close();
    rmSync(project, { recursive: true, force: true });
  }
});
