import type { AgentTask, ChatPipelineStage, ChatRecord, DriverCapability, Invocation, PipelineGateId, TaskStatus } from '../../lib/chat-api';
import { activeTask, type ToolEvidence } from './chatModel';
import type { RotationNotice } from './PipelineStatus';

// 'stopped' is a deliberate cancel by the user; 'error' is a failure or interruption.
export type ObservatoryState = 'idle' | 'active' | 'done' | 'hold' | 'error' | 'stopped';

const effortTiers = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export interface ObservatoryEffort {
  label: string;
  level: number;
  source: 'recorded' | 'configured';
}

function readEffort(value: string | undefined, source: ObservatoryEffort['source']): ObservatoryEffort | undefined {
  const label = value?.trim();
  if (!label) return undefined;
  const level = effortTiers.indexOf(label.toLowerCase()) + 1;
  return { label: level ? effortTiers[level - 1] : label, level, source };
}

const seatDetails = new Map([
  ['claude', ['Claude', '拆解任务、协调分工与交付']],
  ['grok', ['Grok', '执行并行子任务']],
  ['sol', ['Sol', '实现与集成']],
  ['astra', ['Astra', '独立评审与验收']],
  ['opus', ['Opus', '架构互参、隔离实现与交叉评审']],
  ['carbon', ['Carbon', '提供备选思路与适用条件']],
  ['hydrogen', ['Hydrogen', '并行分析与校验']],
  ['deepseek', ['DeepSeek', '分析代码与执行有界工程任务']],
  ['mini', ['Mini', '执行随父席位分配的快速子任务']],
]);

export interface ObservatoryRole {
  id: string;
  label: string;
  description: string;
  model?: string;
  effort?: ObservatoryEffort;
  state: ObservatoryState;
  tasks: AgentTask[];
  latestInvocation?: Invocation;
  available?: boolean;
  /** Where model came from: the latest invocation report or the seat configuration. */
  modelSource?: ObservatoryEffort['source'];
  /** A task of this seat waits on the user (waiting_user status or a pending user ticket). */
  waitsOnUser: boolean;
}

interface ObservatoryLink {
  from: string;
  to: string;
  count: number;
  active: boolean;
  // waiting counts both kinds; waitingUser is the subset whose child task waits on the user.
  flow: { outbound: number; returning: number; waiting: number; waitingUser: number };
  effort: number;
  returnedAt?: string;
}

interface ObservatorySignal {
  id: string;
  label: string;
  role?: string;
  at: string;
  state: ObservatoryState;
}

const taskStatus: Record<TaskStatus, { label: string; state: ObservatoryState }> = {
  queued: { label: '任务排队', state: 'idle' },
  running: { label: '任务执行中', state: 'active' },
  waiting_user: { label: '等待用户回答', state: 'hold' },
  waiting_children: { label: '等待子任务', state: 'hold' },
  completed: { label: '任务完成', state: 'done' },
  failed: { label: '任务失败', state: 'error' },
  cancelled: { label: '任务已取消', state: 'stopped' },
  interrupted: { label: '任务已中断', state: 'error' },
};

const toolStatus: Record<ToolEvidence['status'], { label: string; state: ObservatoryState }> = {
  running: { label: '调用工具', state: 'active' },
  completed: { label: '工具完成', state: 'done' },
  failed: { label: '工具失败', state: 'error' },
};

const pipelineStages = [
  { id: 'architecture', label: '架构', code: 'ARCH', description: '组织方案、审阅并形成架构交付件。' },
  { id: 'gate-a', label: '关卡 A', code: 'GATE A', description: '决定是否采纳架构和演示。' },
  { id: 'implementation', label: '实现', code: 'BUILD', description: '按已确认的方案推进实现。' },
  { id: 'acceptance', label: '独立验收', code: 'VERIFY', description: '核对冻结版本、测试与证据。' },
  { id: 'gate-b', label: '关卡 B', code: 'GATE B', description: '决定是否接受最终交付。' },
  { id: 'completed', label: '完成', code: 'SHIP', description: '交付已进入完成状态。' },
] as const;

function projectPipeline(chat: ChatRecord | null, root: AgentTask | undefined) {
  const pipeline = chat?.pipeline;
  const active: ChatPipelineStage | null = pipeline?.stage ?? null;
  const gate: PipelineGateId | null = active === 'gate-a' ? 'A' : active === 'gate-b' ? 'B' : null;
  const gateMode = (gate === 'A' ? pipeline?.gates.architecture : gate === 'B' ? pipeline?.gates.delivery : undefined) ?? null;
  const cursor = pipelineStages.findIndex(stage => stage.id === active);
  const stages = !active ? [] : pipelineStages.map((stage, index) => {
    let state: ObservatoryState = 'idle';
    if (index < cursor || (index === cursor && active === 'completed')) state = 'done';
    else if (index === cursor) {
      state = gateMode === 'user' || chat?.blockedReason ? 'hold' : 'active';
      if (active === 'implementation' && pipeline?.implementation?.error) state = 'error';
      // A run the user stopped (or that failed) leaves pipeline.stage where it was; the stage root tells the truth.
      if (state === 'active' && root?.status === 'cancelled') state = 'stopped';
      if (state === 'active' && (root?.status === 'failed' || root?.status === 'interrupted')) state = 'error';
    }
    const mode = stage.id === 'gate-a' ? pipeline?.gates.architecture : stage.id === 'gate-b' ? pipeline?.gates.delivery : undefined;
    return { ...stage, state, mode };
  });
  return { active, stages, gate, gateMode, cancelled: active === 'cancelled' };
}

const timestamp = (at: string) => Date.parse(at) || 0;

function projectSignals(tasks: AgentTask[], taskById: Map<string, AgentTask>, invocationById: Map<string, Invocation>, activity: ToolEvidence[], rotations: RotationNotice[]): ObservatorySignal[] {
  const signals: ObservatorySignal[] = tasks.map(task => ({ id: `task:${task.id}`, role: task.role, at: task.updatedAt, ...taskStatus[task.status] }));
  for (const tool of activity) {
    const taskId = tool.taskId ?? invocationById.get(tool.invocationId ?? '')?.taskId;
    const task = taskId ? taskById.get(taskId) : undefined;
    if (!task) continue;
    const status = toolStatus[tool.status];
    signals.push({ id: `tool:${tool.id}`, role: task.role, label: `${status.label} · ${tool.name}`, at: tool.at, state: status.state });
  }
  for (const rotation of rotations) {
    const taskId = rotation.taskId ?? invocationById.get(rotation.invocationId ?? '')?.taskId;
    const task = taskId ? taskById.get(taskId) : undefined;
    if (!task) continue;
    signals.push({ id: `rotation:${rotation.id}`, role: task.role, label: rotation.nextSegment ? `窗口交接 · 第 ${rotation.nextSegment} 段` : '窗口交接', at: rotation.at, state: 'done' });
  }
  return signals.sort((a, b) => timestamp(b.at) - timestamp(a.at)).slice(0, 5);
}

export function buildObservatory(chat: ChatRecord | null, capabilities: DriverCapability[], activity: ToolEvidence[], rotations: RotationNotice[], fixedDemo: boolean) {
  const latestTurn = chat?.turns.at(-1);
  const turnId = latestTurn?.id ?? chat?.tasks.findLast(task => !task.parentTaskId)?.turnId ?? chat?.tasks.at(-1)?.turnId;
  const tasks = chat?.tasks.filter(task => task.turnId === turnId) ?? [];
  const taskById = new Map(tasks.map(task => [task.id, task]));
  const root = latestTurn ? taskById.get(latestTurn.rootTaskId) : tasks.findLast(task => !task.parentTaskId);
  const team = fixedDemo ? undefined : chat?.team;
  const teamMembers = new Map((team?.members ?? []).map(member => [member.seatId, member]));
  const rootRole = root?.role ?? team?.lead.seatId;
  const capabilityByRole = new Map((fixedDemo ? [] : capabilities).map(seat => [seat.role, seat]));
  const seatOrder = new Set([
    ...(rootRole ? [rootRole] : []),
    ...(team ? [team.lead.seatId, ...team.members.map(member => member.seatId)] : []),
    ...capabilityByRole.keys(),
    ...tasks.map(task => task.role),
  ]);
  const tasksByRole = new Map<string, AgentTask[]>();
  for (const task of tasks) {
    const assigned = tasksByRole.get(task.role);
    if (assigned) assigned.push(task);
    else tasksByRole.set(task.role, [task]);
  }
  const invocationById = new Map<string, Invocation>();
  const latestInvocationByRole = new Map<string, Invocation>();
  const latestInvocationByTask = new Map<string, Invocation>();
  for (const invocation of chat?.invocations ?? []) {
    const task = taskById.get(invocation.taskId);
    if (!task) continue;
    invocationById.set(invocation.id, invocation);
    const previous = latestInvocationByRole.get(task.role);
    if (!previous || timestamp(invocation.startedAt) >= timestamp(previous.startedAt)) latestInvocationByRole.set(task.role, invocation);
    const previousForTask = latestInvocationByTask.get(task.id);
    if (!previousForTask || timestamp(invocation.startedAt) >= timestamp(previousForTask.startedAt)) latestInvocationByTask.set(task.id, invocation);
  }

  // Distinct tasks in this turn that wait on the user: a waiting task and its pending ticket count once.
  const userWaitIds = new Set([
    ...tasks.filter(task => task.status === 'waiting_user').map(task => task.id),
    ...(chat?.tickets ?? []).filter(ticket => ticket.type === 'user' && ticket.status === 'pending' && taskById.has(ticket.taskId)).map(ticket => ticket.taskId),
  ]);
  const roles: ObservatoryRole[] = Array.from(seatOrder, id => {
    const customLead = team && team.lead.seatId === id ? team.lead : undefined;
    const customMember = teamMembers.get(id);
    const customLabel = customLead?.label ?? customMember?.label;
    const customDesc = customLead
      ? (team?.delegation === 'none' ? '主 Agent · 独立执行' : team?.delegation === 'explicit' ? '主 Agent · 按需调度' : '主 Agent · 自主调度')
      : customMember
        ? (customMember.role === 'reviewer' ? '独立评审与验收' : customMember.role === 'writer' ? '实现写入与执行' : '可调度协作者')
        : undefined;
    const [defaultLabel, defaultDesc] = seatDetails.get(id) ?? [id, '协作席位'];
    const label = customLabel ?? defaultLabel;
    const description = customDesc ?? defaultDesc;
    const roleTasks = tasksByRole.get(id) ?? [];
    const states = roleTasks.map(task => taskStatus[task.status].state);
    const state = (['active', 'hold', 'error', 'stopped', 'done'] as const).find(item => states.includes(item)) ?? 'idle';
    const latestInvocation = latestInvocationByRole.get(id);
    const capability = capabilityByRole.get(id);
    const configuredEffort = capability?.effort ?? customLead?.effort ?? customMember?.effort;
    const configuredModel = capability?.model ?? customLead?.model ?? customMember?.model;
    const effort = readEffort(latestInvocation?.effort, 'recorded') ?? readEffort(configuredEffort, 'configured');
    const model = latestInvocation?.model ?? configuredModel;
    const modelSource = latestInvocation?.model ? 'recorded' as const : configuredModel ? 'configured' as const : undefined;
    return { id, label, description, state, tasks: roleTasks, latestInvocation, effort, model, modelSource, available: capability?.available,
      waitsOnUser: roleTasks.some(task => userWaitIds.has(task.id)) };
  });

  const links = new Map<string, { link: ObservatoryLink; effortPriority: number }>();
  const counts = { running: 0, complete: 0, waiting: 0, tasks: tasks.length, artifacts: 0 };
  for (const task of tasks) {
    const running = task.status === 'running';
    const complete = task.status === 'completed';
    const waiting = task.status === 'waiting_user' || task.status === 'waiting_children';
    if (running) counts.running++;
    if (complete) counts.complete++;
    if (waiting) counts.waiting++;
    const parent = task.parentTaskId ? taskById.get(task.parentTaskId) : undefined;
    if (!parent || parent.role === task.role) continue;
    const key = JSON.stringify([parent.role, task.role]);
    let edge = links.get(key);
    if (!edge) {
      edge = { link: { from: parent.role, to: task.role, count: 0, active: false, flow: { outbound: 0, returning: 0, waiting: 0, waitingUser: 0 }, effort: 0 }, effortPriority: -1 };
      links.set(key, edge);
    }
    const { link } = edge;
    const invocation = latestInvocationByTask.get(task.id);
    link.count++;
    link.active ||= activeTask(task);
    if (running) link.flow.outbound++;
    if (waiting) link.flow.waiting++;
    if (task.status === 'waiting_user') link.flow.waitingUser++;
    if (complete) {
      link.flow.returning++;
      const endedAt = invocation?.endedAt ?? task.updatedAt;
      if (!link.returnedAt || timestamp(endedAt) > timestamp(link.returnedAt)) link.returnedAt = endedAt;
    }

    const priority = running ? 3 : complete ? 2 : waiting ? 1 : 0;
    const effort = readEffort(invocation?.effort, 'recorded') ?? readEffort(capabilityByRole.get(task.role)?.effort, 'configured');
    if (priority > edge.effortPriority) {
      edge.effortPriority = priority;
      link.effort = effort?.level ?? 0;
    } else if (priority === edge.effortPriority) {
      link.effort = Math.max(link.effort, effort?.level ?? 0);
    }
  }
  counts.artifacts = chat?.artifacts.filter(artifact => taskById.has(artifact.taskId)).length ?? 0;
  // Child tasks of the current turn (everything but the root): the lead counter on the map reads completed / total.
  const childTasks = tasks.filter(task => task !== root && task.parentTaskId);

  return {
    turnId, rootRole, rootStatus: root?.status ?? latestTurn?.status, roles, tasks, counts,
    children: { total: childTasks.length, completed: childTasks.filter(task => task.status === 'completed').length },
    /** Window hand-overs recorded for this chat (the context view caption). */
    rotationCount: rotations.length,
    links: Array.from(links.values(), ({ link }) => link),
    signals: projectSignals(tasks, taskById, invocationById, activity, rotations),
    pipeline: projectPipeline(chat, root),
    waitingForUser: userWaitIds.size > 0,
    userWaits: userWaitIds.size,
    /** Task ids in this turn that wait on the user (status or pending ticket). */
    userWaitIds: [...userWaitIds],
    /** Seats whose tasks wait on the user, for wording that names who asked. */
    userWaitRoles: [...new Set(tasks.filter(task => userWaitIds.has(task.id)).map(task => task.role))],
    blocked: Boolean(chat?.blockedReason),
  };
}

export type Observatory = ReturnType<typeof buildObservatory>;
