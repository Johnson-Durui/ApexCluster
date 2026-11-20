// DEV-only thread fixtures (BUILD-SPEC-B §9 WP1): every thread state, built from dev/observatory/fixture.ts (read-only).
// Nothing here is reachable in a production build.
import type { AgentTask, ChatMessage, ChatPipelineStage, ChatRecord } from '../../lib/chat-api';
import { emptyChatState, reduceChat, type ChatState, type ConnectionState } from '../../pages/chat/chatModel';
import type { GatePhase } from '../../pages/chat/PipelineStatus';
import { observatoryFixture } from '../observatory/fixture';

export const THREAD_STATES = ['welcome', 'running', 'gate', 'gate-busy', 'gate-error', 'gate-409', 'receipt', 'question', 'done', 'failed', 'cancelled', 'offline', 'loading', 'demo'] as const;
export type ThreadState = typeof THREAD_STATES[number];

export interface ThreadFixture {
  name: ThreadState;
  state: ChatState;
  chat: ChatRecord | null;
  capabilities: ReturnType<typeof observatoryFixture>['capabilities'];
  gate: GatePhase;
  notice: string;
  loading: boolean;
  demo: boolean;
}

const DEMO_ID = 'fixed-demo-roomdesk-00000000-0000-4000-8000-000000000000';
const ANSWER = `# 架构阶段结论

技术架构书 v1 与可运行 Demo 已交付，等待关卡 A。

- 核心规则：纯 ES 模块负责时段校验、冲突检测与 iCal 导出，无外部依赖。
- 界面：响应式楼层时间轴视图，本地存储自动持久化。
- Astra 评审：无阻塞问题，建议补充损坏本地存储的降级提示。

### 运行方式
\`\`\`
cd D:\\Projects\\roomdesk
npm test
\`\`\``;

function message(id: string, seq: number, role: ChatMessage['role'], text: string, at: string, patch: Partial<ChatMessage> = {}): ChatMessage {
  return { id, seq, role, text, createdAt: at, turnId: 'turn-2', ...patch };
}

function settle(tasks: AgentTask[], status: AgentTask['status'], keepChildren = false): AgentTask[] {
  return tasks.map(task => task.turnId !== 'turn-2' ? task : !task.parentTaskId ? { ...task, status } : keepChildren ? task : { ...task, status: task.status === 'queued' ? 'cancelled' : 'completed' });
}

export function threadFixture(name: ThreadState): ThreadFixture {
  const stage: ChatPipelineStage = name.startsWith('gate') ? 'gate-a' : name === 'receipt' ? 'implementation' : name === 'done' ? 'completed' : 'implementation';
  const base = observatoryFixture(stage);
  const start = base.chat.turns[1].createdAt;
  const at = (seconds: number) => new Date(Date.parse(start) + seconds * 1000).toISOString();
  const user = message('m-user', 10, 'user', '帮我做一个团队会议室预约小工具：先出 PRD 和技术架构，再完成可运行的 Web 应用和自动化测试。需要支持按楼层筛选、冲突检测和 iCal 导出。', at(0));
  let chat: ChatRecord = { ...base.chat, apiUsage: { tokens: 386_900, usd: 1.2345, unpriced: 2 } };
  const messages: ChatMessage[] = [user];
  let gate: GatePhase = { phase: 'idle' };
  let connection: ConnectionState = 'live';
  let notice = '';

  if (name === 'running' || name === 'offline') {
    chat = { ...chat, tickets: [], tasks: chat.tasks.map(task => task.id === 'root' ? { ...task, status: 'waiting_children' } : task), turns: chat.turns.map(turn => turn.id === 'turn-2' ? { ...turn, status: 'running' } : turn) };
    if (name === 'offline') { connection = 'recovering'; notice = '实时连接已中断，正在从 REST 快照校准并重连…'; }
  }
  if (name.startsWith('gate')) {
    chat = { ...chat, tickets: [], tasks: settle(chat.tasks, 'completed'), turns: chat.turns.map(turn => turn.id === 'turn-2' ? { ...turn, status: 'completed', completedAt: at(480) } : turn) };
    messages.push(message('m-answer', 11, 'assistant', ANSWER, at(470), { taskId: 'root' }));
    gate = name === 'gate-busy' ? { phase: 'busy', decision: 'confirm' }
      : name === 'gate-error' ? { phase: 'error', kind: 'network', message: '关卡决定提交失败：服务暂时不可用（503）。决定没有生效，关卡仍在等你。' }
      : name === 'gate-409' ? { phase: 'error', kind: 'conflict', message: '关卡决定没有生效：成品已变化，请提交返工并复验后再接受' } : gate;
  }
  if (name === 'receipt') {
    // After gate A the lead is back to waiting on its children (no ticket), so nothing on the map waits on the user.
    chat = { ...chat, tickets: [], tasks: chat.tasks.map(task => task.id === 'root' ? { ...task, status: 'waiting_children' } : task),
      turns: chat.turns.map(turn => turn.id === 'turn-2' ? { ...turn, status: 'running' } : turn),
      pipeline: chat.pipeline && { ...chat.pipeline, gates: { ...chat.pipeline.gates, architecture: 'auto' } } };
    messages.push(message('m-answer', 11, 'assistant', ANSWER, at(470), { taskId: 'root' }));
    messages.push(message('m-revise', 12, 'user', '请补充损坏本地存储时的降级提示，并增加对应验收项。', at(500), { turnId: 'turn-r1', pipelineGate: { id: 'A', revision: 1, decision: 'revise' } }));
    messages.push(message('m-auto', 13, 'system', '关卡 A 确认通过', at(620), { turnId: 'turn-r2', auto: true, pipelineGate: { id: 'A', revision: 2, decision: 'confirm' } }));
    messages.push(message('m-confirm', 14, 'user', '关卡 A 确认通过', at(640), { turnId: 'turn-r3', pipelineGate: { id: 'A', revision: 3, decision: 'confirm' } }));
  }
  if (name === 'done') {
    chat = { ...chat, tickets: [], tasks: settle(chat.tasks, 'completed'), turns: chat.turns.map(turn => turn.id === 'turn-2' ? { ...turn, status: 'completed', completedAt: at(2768) } : turn),
      artifacts: chat.artifacts.map(item => ({ ...item, projectExport: { status: 'saved' as const, path: `D:\\Projects\\roomdesk\\agent-outputs\\${item.name}`, relativePath: item.name, workspaceId: 'w', version: 1, hash: item.hash } })) };
    messages.push(message('m-answer', 11, 'assistant', ANSWER, at(2760), { taskId: 'root' }));
  }
  if (name === 'failed' || name === 'cancelled') {
    const status = name === 'failed' ? 'failed' : 'cancelled';
    chat = { ...chat, tickets: [], pipeline: undefined, artifacts: [], tasks: chat.tasks.filter(task => task.turnId !== 'turn-2' || task.id === 'root').map(task => task.id === 'root' ? { ...task, status } : task),
      turns: chat.turns.map(turn => turn.id === 'turn-2' ? { ...turn, status, completedAt: at(42) } : turn), blockedReason: name === 'failed' ? '主控调用失败：模型服务返回 503，重试 3 次后停止。' : undefined };
  }
  if (name === 'question') {
    // Settled: every child has returned and only the lead waits on the user's answer (nothing is active).
    chat = { ...chat, tasks: settle(chat.tasks, 'waiting_user') };
  }
  if (name === 'demo') {
    chat = { ...chat, id: DEMO_ID, title: '预设演示 · RoomDesk 会议室预约工具', pipeline: undefined, tickets: [], artifacts: [], apiUsage: undefined, invocations: [] };
  }
  const fresh = name === 'welcome' || name === 'loading';
  let state = emptyChatState();
  if (!fresh) {
    state = reduceChat(state, { type: 'snapshot', snapshot: { chat, messages, capabilities: name === 'demo' ? [] : base.capabilities, streams: [], recentEvents: [] } });
    state = reduceChat(state, { type: 'history', chatId: chat.id, events: base.activity.map((tool, index) => ({ seq: index + 1, chatId: chat.id, type: tool.status === 'running' ? 'tool_started' : tool.status === 'failed' ? 'tool_error' : 'tool_result', at: tool.at, taskId: tool.taskId, data: { name: tool.name, toolCallId: tool.id } })) });
    state = { ...state, rotations: base.rotations, connection };
  }
  return { name, state, chat: fresh ? null : state.chat, capabilities: base.capabilities, gate, notice, loading: name === 'loading', demo: name === 'demo' };
}
