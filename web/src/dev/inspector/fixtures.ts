// Dev-only inspector samples (#/dev/inspector). Built from the frozen observatory fixture (read-only import): each
// call returns fresh objects, so the per-state edits below never touch the shared sample. No server, no model calls.
import type { AgentTask, ChatArtifact, ChatAttachment, ChatCapabilities, ChatRecord, ChatStream, ChatTodo, ChatTurn, DriverCapability, Invocation, WaitTicket } from '../../lib/chat-api';
import type { ToolEvidence } from '../../pages/chat/chatModel';
import { buildObservatory } from '../../pages/chat/observatoryModel';
import type { RotationNotice } from '../../pages/chat/PipelineStatus';
import { observatoryFixture } from '../observatory/fixture';

export const INSPECTOR_STATES = ['running', 'gate', 'done', 'demo', 'empty'] as const;
export type InspectorState = typeof INSPECTOR_STATES[number];

const iso = (offsetSeconds: number) => new Date(Date.now() + offsetSeconds * 1000).toISOString();

export const globalCapabilitiesFixture = (): ChatCapabilities => ({
  drivers: [], runner: { available: false, reason: '受控测试 runner 未启用' }, nativePicker: true, dataRoot: 'D:\\WorkbenchData',
  services: [
    { id: 'documents', name: '文档与Office服务', state: 'ready', tools: ['document_read', 'document_create', 'document_convert'] },
    { id: 'mcp:fs', name: 'filesystem-mcp', state: 'ready', tools: ['read_file', 'list_dir'] },
    { id: 'mcp:browser', name: 'browser-mcp', state: 'degraded', reason: '部分工具不可用', tools: ['open', 'read', 'shot'] },
    { id: 'media:image', name: 'image', state: 'unconfigured', reason: '未配置服务', tools: [] },
  ],
  exec: { backend: 'docker', available: true, unsafe: false },
});

function todos(state: InspectorState): ChatTodo[] {
  const done = state !== 'running';
  return [
    { id: 'td1', taskId: 'root', text: '汇总业务需求与 PRD', status: 'completed', evidenceRefs: ['e1', 'e2'], dependsOn: ['td0'], updatedAt: iso(-200) },
    { id: 'td2', taskId: 'root', text: '工程骨架与冲突检测', status: done ? 'completed' : 'in_progress', linkedTaskIds: ['sol-build', 'deepseek-code'], updatedAt: iso(-60) },
    { id: 'td3', taskId: 'root', text: '独立验收与交付', status: done ? 'completed' : 'pending', updatedAt: iso(-30) },
  ];
}

function extraArtifacts(): ChatArtifact[] {
  return [
    { id: 'a4', taskId: 'sol-build', name: 'roomdesk-src.zip', relativePath: 'roomdesk-src.zip', hash: 'h4', bytes: 1_270_000, kind: 'diff', provenance: 'workspace', createdAt: iso(-3),
      projectExport: { status: 'saved', path: 'D:\\Projects\\roomdesk\\agent-outputs\\roomdesk-src.zip', relativePath: 'agent-outputs/roomdesk-src.zip', workspaceId: 'w1', version: 3, hash: 'h4' } },
    { id: 'a5', taskId: 'astra-review', name: '验收记录.txt', relativePath: '验收记录.txt', hash: 'h5', bytes: 6_100, kind: 'test', provenance: 'runner', createdAt: iso(-2) },
    { id: 'a6', taskId: 'missing-task', name: '旧轮次说明.md', relativePath: '旧轮次说明.md', hash: 'h6', bytes: 1_800, kind: 'report', createdAt: iso(-1) },
  ];
}

const attachments = (): ChatAttachment[] => [
  { id: 'at1', name: '需求说明.md', bytes: 12_300, hash: 'x1', mime: 'text/markdown', createdAt: iso(-900), source: 'upload' },
  { id: 'at2', name: '界面草图.png', bytes: 84_000, hash: 'x2', mime: 'image/png', createdAt: iso(-60), source: 'generated', taskId: 'opus-arch' },
];

export interface InspectorSample {
  chat: ChatRecord; capabilities: DriverCapability[]; tools: ToolEvidence[]; rotations: RotationNotice[]; streams: ChatStream[];
  globalCapabilities: ChatCapabilities; fixedDemo: boolean; model: ReturnType<typeof buildObservatory>;
}

export function inspectorFixture(state: InspectorState): InspectorSample {
  const stage = state === 'gate' ? 'gate-a' : state === 'running' ? 'implementation' : 'completed';
  const sample = observatoryFixture(stage);
  const chat: ChatRecord = { ...sample.chat };
  let capabilities = sample.capabilities.map(seat => seat.role === 'hydrogen' ? { ...seat, available: false, reason: '缺少 HYDROGEN_API_KEY' } : seat);
  let tools: ToolEvidence[] = sample.activity;
  let rotations: RotationNotice[] = sample.rotations;
  const settle = (status: AgentTask['status']) => chat.tasks.map((task): AgentTask => task.turnId === 'turn-2' ? { ...task, status, updatedAt: iso(-5) } : task);
  if (state === 'running') {
    chat.tasks = chat.tasks.map((task): AgentTask => task.id === 'root' ? { ...task, status: 'waiting_children' } : task);
    chat.tickets = chat.tickets.map((ticket): WaitTicket => ({ ...ticket, status: 'resolved', answer: '以 PRD v2 为准', resolvedAt: iso(-20) }));
    chat.turns = chat.turns.map((turn): ChatTurn => turn.id === 'turn-2' ? { ...turn, status: 'running' } : turn);
  } else if (state !== 'empty') {
    chat.tasks = settle('completed');
    chat.tickets = chat.tickets.map((ticket): WaitTicket => ({ ...ticket, status: 'resolved', answer: '以 PRD v2 为准', resolvedAt: iso(-200) }));
    chat.turns = chat.turns.map((turn): ChatTurn => turn.id === 'turn-2' ? { ...turn, status: 'completed', completedAt: iso(-4) } : turn);
    chat.invocations = chat.invocations.map((invocation): Invocation => ({ ...invocation, status: 'exited', endedAt: invocation.endedAt ?? iso(-6) }));
    chat.artifacts = [...chat.artifacts, ...extraArtifacts()];
    chat.attachments = attachments();
    chat.apiUsage = { tokens: 1_284_400, usd: 4.8213, unpriced: 2 };
  }
  chat.todos = state === 'empty' ? [] : todos(state);
  if (state === 'demo') {
    chat.title = '会议室预约工具演示 · 预设流程';
    chat.invocations = [];
    chat.pipeline = undefined;
    capabilities = [];
    tools = [];
    rotations = [];
  }
  if (state === 'empty') {
    Object.assign(chat, { title: '新的聊天', tasks: [], invocations: [], artifacts: [], turns: [], tickets: [], pipeline: undefined, attachments: [] });
    capabilities = sample.capabilities.slice(0, 4);
    tools = [];
    rotations = [];
  }
  const childIds = new Set(chat.tasks.filter(task => task.parentTaskId).map(task => task.id));
  const streams: ChatStream[] = chat.invocations.filter(invocation => childIds.has(invocation.taskId)).map(invocation => ({
    invocationId: invocation.id, taskId: invocation.taskId, role: chat.tasks.find(task => task.id === invocation.taskId)?.role ?? 'grok', text: '', status: invocation.status,
  }));
  const fixedDemo = state === 'demo';
  return { chat, capabilities, tools, rotations, streams, globalCapabilities: globalCapabilitiesFixture(), fixedDemo, model: buildObservatory(chat, capabilities, tools, rotations, fixedDemo) };
}
