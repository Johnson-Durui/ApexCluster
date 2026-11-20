// The RoomDesk pipeline chat (README.md "Scenario"): architecture → gate A → implementation →
// acceptance → gate B → completed, with the seats claude / carbon / astra / opus / sol and the pools grok /
// hydrogen / deepseek / mini. Seat outputs come from scenario/content/seat-notes.md, deliverables from the RoomDesk files.
//
// Pacing is in demo milliseconds (scaled by mock/clock.ts): about 3 minutes at speed 1, plus the two gate waits.
// A gate waits for the visitor. If nobody decides within 20 s of demo time, the engine confirms on its own
// (message role 'system', auto: true, rendered "由系统自动通过") and, because no POST response carries the new
// record then, it also emits a `state` event with the whole chat.
import type { ChatTodo, WaitTicket } from '../../src/lib/chat-api';
import { DemoChat, type ChatDriver, type InputResult, type ServerInvocation, type ServerPipeline, type ServerTask } from '../mock/chat-engine';
import {
  SEAT, addTask, addTurn, appendMessage, cancelAll, complete, context, emitMessage, end, extendTicket, newTicket, plan, publish, raw,
  resolve, say, start, taskUpdate, tool, usage, usageTo, waitFor, type SeatModel,
} from '../mock/chat-ops';
import type { Script } from '../mock/chat-scheduler';
import { demoNow } from '../mock/chat-scheduler';
import { after, getSpeed, onSpeed } from '../mock/clock';
import { ROOMDESK_PROMPT, TEST_FAIL, TEST_PASS, TEST_REPORT, demoFile, plainMarkdown, seatNote } from './content';

export const ROOMDESK_TITLE = ROOMDESK_PROMPT.trim().split(/\r?\n/)[0].slice(0, 40);
/** Demo milliseconds a gate waits before the engine confirms it. */
export const GATE_WAIT_MS = 20_000;
/** Scale of every scripted pause (think time, gaps). Tool and streaming delays are not scaled. */
const PACE = 0.7;
const GATE_REFUSAL = '在线演示只预置了“确认继续”这一路径，请点击确认。';

const ARCH_STEPS: ReadonlyArray<[string, string]> = [
  ['cluster', '完成一次完整架构集群并核对增量建议'],
  ['prd', '发布含需求和验收编号的 PRD'],
  ['architecture', '发布同一份技术架构'],
  ['guide', '由 Astra 发布开发指南'],
  ['demo', '由 Sol 实现并实际运行核心路径 Demo'],
  ['contract', '冻结需求及验收契约'],
];

/** Name of a workspace snapshot diff: the server pattern workspace-diff-<task>-segment-<n>.diff, with the first 8
 * characters of the task id so the name fits the gate card and the deliverable list. */
const diffName = (task: ServerTask, segment: number) => `workspace-diff-${task.id.slice(0, 8)}-segment-${segment}.diff`;

type Milestone = 'M-API' | 'M-UI';
type MilestoneStatus = 'ready' | 'authoring' | 'reviewing' | 'integrating' | 'verifying' | 'complete';

/** Tells the demo pill which gate of this chat waits and when it confirms by itself (wall-clock ms). */
function announceGate(chatId: string, gate: 'A' | 'B' | null, autoDemoAt?: number): void {
  try {
    const detail: MawbDemoGateDetail = gate && autoDemoAt !== undefined
      ? { chatId, gate, autoAt: Date.now() + Math.max(0, autoDemoAt - demoNow()) / getSpeed() }
      : { chatId, gate: null };
    window.dispatchEvent(new CustomEvent('mawb-demo:gate', { detail }));
  } catch { /* the pill is optional */ }
}

export function newPipeline(): ServerPipeline {
  return {
    version: 1, preset: 'flagship', stage: 'architecture', revision: 1,
    gates: { clarify: 'user', architecture: 'user', delivery: 'user' },
    quality: { crossReview: true, maxReworkRounds: 2, clusterCrossRounds: 1 },
    priorContracts: [], clusters: [], gateDecisions: [],
  };
}

class RoomDeskDriver implements ChatDriver {
  readonly kind = 'roomdesk';
  private R!: ServerTask;
  private L: ServerTask | null = null;
  private S: ServerTask | null = null;
  private TK5: WaitTicket | null = null;
  private archDone = new Set<string>();
  private archActive = 'cluster';
  private links = new Map<string, string[]>();
  private evidence = new Map<string, string[]>();
  private milestones: Record<Milestone, MilestoneStatus> = { 'M-API': 'ready', 'M-UI': 'ready' };
  private gateTimer: (() => void) | null = null;
  private gateSpeedOff: (() => void) | null = null;
  private planHash = '';

  constructor(private readonly chat: DemoChat) {}

  private get pipeline(): ServerPipeline { return this.chat.record.pipeline!; }
  /** A random wait in demo ms, scaled by PACE (tunes the whole run to about 3 minutes at speed 1). */
  private pause(min: number, max: number): number { return Math.round(this.chat.rng.int(min, max) * PACE); }

  // ---------------------------------------------------------- inputs

  /** runtime.send + acceptMessage for the first message: turn T1, root task R, the six architecture steps. */
  accept(clientMessageId: string): void {
    const chat = this.chat;
    const turnId = chat.rng.uuid();
    const message = appendMessage(chat, { role: 'user', text: ROOMDESK_PROMPT, clientMessageId, turnId, accepted: true });
    this.R = addTask(chat, { turnId, role: 'claude', goal: ROOMDESK_PROMPT, phase: 'architecture' });
    addTurn(chat, this.R, message.createdAt);
    this.pipeline.architectureTaskId = this.R.id;
    this.pipeline.revisionStartedAt = message.createdAt;
    chat.record.constraintMessageIds.push(message.id);
    chat.record.todos = this.archTodos();
    chat.record.planRevision = 1;
    taskUpdate(chat, this.R);
    emitMessage(chat, message);
  }

  send(chat: DemoChat): InputResult {
    const stage = chat.record.pipeline?.stage;
    const error = stage === 'gate-a' || stage === 'gate-b' ? '请在流水线关卡提交决定'
      : stage === 'implementation' || stage === 'acceptance' ? '实现按冻结契约推进，返工或变更请在关卡提交'
        : stage === 'completed' || stage === 'cancelled' || chat.record.tasks.every(task => task.status === 'cancelled' || task.status === 'completed') ? '流水线已结束'
          : '架构阶段按预设脚本推进，修订意见请在关卡 A 提交';
    return { ok: false, status: 409, error };
  }

  answer(): InputResult {
    return { ok: false, status: 409, error: '该问题已回答或不存在。' };
  }

  gate(chat: DemoChat, gate: 'A' | 'B', auto: boolean): InputResult {
    const pipeline = this.pipeline;
    if (pipeline.stage !== (gate === 'A' ? 'gate-a' : 'gate-b')) return { ok: false, status: 409, error: '该关卡当前未开放' };
    this.clearGate();
    const turnId = chat.rng.uuid();
    const message = appendMessage(chat, {
      role: auto ? 'system' : 'user', text: `关卡 ${gate} 确认通过`, turnId, accepted: true,
      pipelineGate: { id: gate, revision: pipeline.revision, decision: 'confirm' }, ...(auto ? { auto: true as const } : {}),
    });
    chat.record.constraintMessageIds.push(message.id);
    pipeline.gateDecisions.push({ gateId: gate, decision: 'confirm', messageId: message.id, automatic: auto, revision: pipeline.revision });
    if (gate === 'A') {
      pipeline.stage = 'implementation';
      this.queueImplementation(turnId, message.createdAt);
    } else {
      pipeline.stage = 'completed';
    }
    chat.emit('pipeline_gate_decided', { gateId: gate, decision: 'confirm', messageId: message.id, automatic: auto, revision: pipeline.revision });
    emitMessage(chat, message);
    // No POST response reaches the page for an engine decision, so the new turn travels in a whole-record event.
    if (auto) chat.emit('state', () => ({ chat: chat.record }));
    chat.sched.signal(`gate-${gate}`, 1200);
    return { ok: true };
  }

  cancel(chat: DemoChat): void {
    this.clearGate();
    cancelAll(chat);
  }

  onLive(chat: DemoChat): void {
    const stage = chat.record.pipeline?.stage;
    if (stage === 'gate-a' && chat.sched.waiting('gate-A')) this.armGate('A');
    if (stage === 'gate-b' && chat.sched.waiting('gate-B')) this.armGate('B');
  }

  onConnect(chat: DemoChat): void {
    this.connected = true;
    chat.sched.signal('connected', 700);
  }

  private connected = false;

  /** Refusal for revise / cancel at a gate (the demo only has the confirm path). */
  static refusal(): InputResult {
    return { ok: false, status: 409, error: GATE_REFUSAL };
  }

  private armGate(gate: 'A' | 'B'): void {
    this.clearGate();
    const autoDemoAt = demoNow() + GATE_WAIT_MS;
    this.gateTimer = after(GATE_WAIT_MS, () => {
      this.gateTimer = null;
      this.chat.decideGate(gate, true);
    });
    this.gateSpeedOff = onSpeed(() => announceGate(this.chat.id, gate, autoDemoAt));
    announceGate(this.chat.id, gate, autoDemoAt);
  }

  private clearGate(): void {
    const wasArmed = Boolean(this.gateTimer || this.gateSpeedOff);
    this.gateTimer?.();
    this.gateTimer = null;
    this.gateSpeedOff?.();
    this.gateSpeedOff = null;
    if (wasArmed) announceGate(this.chat.id, null);
  }

  /** pipeline_gate_opened; the script then blocks on the gate signal. */
  private openGate(task: ServerTask, gate: 'A' | 'B'): void {
    this.pipeline.stage = gate === 'A' ? 'gate-a' : 'gate-b';
    this.chat.emit('pipeline_gate_opened', { gateId: gate, revision: this.pipeline.revision, mode: 'user' }, { task });
    if (this.chat.sched.isLive) this.armGate(gate);
  }

  /** queueImplementation (no events): turn T2, lead L waiting on Sol S, ticket TK5 with invocationId ''. */
  private queueImplementation(turnId: string, createdAt: string): void {
    const chat = this.chat;
    const L = addTask(chat, { turnId, role: 'claude', status: 'waiting_children', phase: 'implementation', pipelineWork: { kind: 'implementation-lead' },
      goal: '统筹交付冻结契约。等待 Sol 交回后，委派全新 Astra 验收；核对真实回执与需求追踪表后交付。' });
    const S = addTask(chat, { turnId, parent: L, role: 'sol', mode: 'edit', phase: 'implementation', pipelineWork: { kind: 'implementation-sol' },
      goal: '以冻结需求契约为依据，同 Opus 互签实现计划。待每个里程碑审核、集成和程序检查通过后交回。' });
    addTurn(chat, L, createdAt);
    this.TK5 = newTicket(chat, L, null, { childIds: [S.id] });
    this.L = L;
    this.S = S;
    this.pipeline.implementationTaskId = S.id;
    const implementation = { version: 1, round: 1, rootTaskId: L.id, solTaskId: S.id, proposals: [] as unknown[], milestones: [] as Array<{ id: string; status: string }> };
    this.pipeline.implementation = implementation;
  }

  // ---------------------------------------------------------- plan

  private archTodos(): ChatTodo[] {
    const at = this.chat.iso();
    return ARCH_STEPS.map(([key, text], index) => ({
      id: `arch-1-${key}`, taskId: this.R.id, text,
      status: this.archDone.has(key) ? 'completed' : key === this.archActive ? 'in_progress' : 'pending',
      dependsOn: index ? [`arch-1-${ARCH_STEPS[index - 1][0]}`] : [], linkedTaskIds: this.links.get(key) ?? [], evidenceRefs: this.evidence.get(key) ?? [],
      updatedAt: at, verification: { kind: key === 'guide' || key === 'demo' ? 'task' : 'artifact' },
    }) as ChatTodo);
  }

  private archProgress(task: ServerTask, invocation: ServerInvocation | null, done: string[], next: string): void {
    for (const key of done) this.archDone.add(key);
    this.archActive = next;
    plan(this.chat, task, invocation, this.archTodos());
  }

  private implTodo(status: ChatTodo['status']): ChatTodo {
    return { id: 'implementation-1', taskId: this.L!.id, text: '实现冻结计划并完成全部里程碑核验', status, dependsOn: [], linkedTaskIds: [this.S!.id], evidenceRefs: [], updatedAt: this.chat.iso(), verification: { kind: 'task' } } as ChatTodo;
  }

  private implementationUpdated(): void {
    const S = this.S!;
    const milestones = (Object.keys(this.milestones) as Milestone[]).map(id => ({ id, status: this.milestones[id] }));
    if (this.pipeline.implementation) this.pipeline.implementation.milestones = milestones;
    raw(this.chat, 'implementation_updated', { round: 1, planHash: this.planHash, milestones, mirrorReceipt: { id: this.chat.rng.uuid(), files: [{ path: '.agent/STATE.json', hash: this.chat.rng.hex(64) }] } }, S);
  }

  // ---------------------------------------------------------- generic seat run

  /**
   * One child invocation: START, context, optional tools, the seat's streamed note, more tools, usage, END, DONE.
   * Returns after the task completed. `afterEnd` runs between END and DONE (workspace diffs, runner receipts).
   */
  private *seat(task: ServerTask, seat: SeatModel, spec: {
    input: number; used: number; output: number; tokens: number; usd: number; note: string;
    before?: (invocation: ServerInvocation) => Script; after?: (invocation: ServerInvocation) => Script;
    afterEnd?: (invocation: ServerInvocation) => void; disposition?: ServerTask['disposition']; think?: [number, number];
  }): Script {
    const chat = this.chat;
    const invocation = start(chat, task, seat, spec.input);
    yield this.pause(500, 900);
    context(chat, task, invocation, spec.input);
    yield this.pause(...(spec.think ?? [3000, 5000]));
    if (spec.before) yield* spec.before(invocation);
    yield* say(chat, task, invocation, spec.note);
    if (spec.after) yield* spec.after(invocation);
    context(chat, task, invocation, spec.used);
    usage(chat, task, invocation, spec.tokens, spec.usd);
    yield this.pause(400, 800);
    end(chat, task, invocation, { used: spec.used, output: spec.output });
    spec.afterEnd?.(invocation);
    yield this.pause(150, 300);
    complete(chat, task, spec.note, spec.disposition);
  }

  private *exec(task: ServerTask, invocation: ServerInvocation, argv: string[], text: string, duration: [number, number] = [3200, 5000]): Script {
    const chat = this.chat;
    const id = chat.rng.uuid();
    const job = { id, taskId: task.id, invocationId: invocation.id, argv, cwd: '/workspace', backend: 'docker', network: 'none' };
    yield* tool(chat, task, invocation, 'exec', text, () => {
      raw(chat, 'exec_starting', { ...job, status: 'starting' }, task, invocation);
      raw(chat, 'exec_started', { ...job, status: 'running', startedAt: chat.iso() }, task, invocation);
    }, duration);
    raw(chat, 'exec_finished', { ...job, status: 'finished', exitCode: 0, timedOut: false, cancelled: false, endedAt: chat.iso() }, task, invocation);
  }

  private testResult(task: ServerTask, invocation: ServerInvocation, text: string): void {
    const ticketId = this.chat.rng.uuid();
    raw(this.chat, 'test_result', { ticketId, ref: `blobs/runner-${ticketId}.txt`, ok: TEST_FAIL === 0, text: text.slice(0, 3500) }, task, invocation);
  }

  // ---------------------------------------------------------- architecture (turn T1)

  *architecture(): Script {
    const chat = this.chat;
    const R = this.R;
    // Live: wait until the page's event stream is open, so the first dispatch animates. If no stream connects
    // within 3 s of demo time (the visitor left the page), the script starts anyway.
    if (chat.sched.isLive && !this.connected) {
      const fallback = after(3000, () => chat.sched.signal('connected'));
      yield { wait: 'connected' };
      fallback();
    } else {
      yield 700;
    }
    yield 600;

    // R.1 — cluster
    let inv = start(chat, R, SEAT.claude, 24180);
    yield this.pause(500, 900);
    context(chat, R, inv, 24180);
    yield this.pause(2800, 4000);
    yield* say(chat, R, inv, seatNote('claude/cluster-start'));
    usage(chat, R, inv, 26010, 0.39);
    const clusterId = `cluster-${chat.rng.hex(10)}`;
    const clusterGroup = chat.rng.uuid();
    let TK1: WaitTicket | null = null;
    yield* tool(chat, R, inv, 'cluster_submit', '已发起完整架构集群：Carbon 先给方案，Astra 与 Opus 分别评审后再互相参考。', () => {
      TK1 = waitFor(chat, R, inv, { clusterId });
      raw(chat, 'cluster_updated', { id: clusterId, groupId: clusterGroup, mode: 'full', status: 'running' }, R);
    });
    yield this.pause(300, 500);
    end(chat, R, inv, { used: 26010, output: 1830, rotationReason: 'wait' });
    taskUpdate(chat, R);
    yield this.pause(1300, 1800);

    // Cluster wave 1: Carbon
    const cluster = (role: string, goal: string) => addTask(chat, { turnId: R.turnId, parent: R, role, goal, phase: 'cluster', groupId: clusterGroup, clusterId });
    const K1 = cluster('carbon', '给出会议室预约工具的候选架构方案与适用条件');
    yield* this.seat(K1, SEAT.carbon, {
      input: 31200, used: 33800, output: 2600, tokens: 33800, usd: 0.22, note: seatNote('carbon/architecture-options'), disposition: 'reference',
      after: invocation => tool(chat, K1, invocation, 'notes_write', '已写入集群笔记：3 个候选方案及适用条件，建议采用方案一。'),
    });
    raw(chat, 'cluster_updated', { id: clusterId, groupId: clusterGroup, mode: 'full', status: 'running', wave: 1 }, R);
    yield this.pause(1100, 1600);

    // Wave 2: Astra and Opus review Carbon's options (started in one tick, so their packets bundle)
    const K2 = cluster('astra', '从验收角度评审候选方案，补充可测的规则');
    const K3 = cluster('opus', '从实现角度评审候选方案，指出时间计算与建议时段的风险');
    yield { all: [
      this.seat(K2, SEAT.astra, { input: 50100, used: 52400, output: 2300, tokens: 54100, usd: 0.95, note: seatNote('astra/cluster-review'), disposition: 'reference',
        before: invocation => tool(chat, K2, invocation, 'result_read', '已读取 Carbon 的候选方案（3 个）。') }),
      this.seat(K3, SEAT.opus, { input: 47600, used: 49700, output: 2300, tokens: 52000, usd: 0.92, note: seatNote('opus/cluster-review'), disposition: 'reference',
        before: invocation => tool(chat, K3, invocation, 'result_read', '已读取 Carbon 的候选方案（3 个）。') }),
    ] };
    raw(chat, 'cluster_updated', { id: clusterId, groupId: clusterGroup, mode: 'full', status: 'running', wave: 2 }, R);
    yield this.pause(1100, 1600);

    // Wave 3: cross review
    const K4 = cluster('astra', '参考 Opus 的意见做第二轮互评，给出建议时段的可验收定义');
    const K5 = cluster('opus', '参考 Astra 的意见做第二轮互评，确认算法与 iCal 字段');
    yield { all: [
      this.seat(K4, SEAT.astra, { input: 69800, used: 71900, output: 2100, tokens: 71200, usd: 1.04, note: seatNote('astra/cross-review'), disposition: 'reference',
        before: invocation => tool(chat, K4, invocation, 'result_read', '已读取 Opus 的评审意见。') }),
      this.seat(K5, SEAT.opus, { input: 66100, used: 68300, output: 2200, tokens: 69000, usd: 1.01, note: seatNote('opus/cross-review'), disposition: 'reference',
        before: invocation => tool(chat, K5, invocation, 'result_read', '已读取 Astra 的评审意见。') }),
    ] };
    raw(chat, 'cluster_updated', { id: clusterId, groupId: clusterGroup, mode: 'full', status: 'completed', summaryRef: `blobs/cluster-${clusterId}.txt` }, R);
    this.links.set('cluster', [K1.id, K2.id, K3.id, K4.id, K5.id]);
    yield this.pause(300, 500);
    resolve(chat, TK1!, R);
    this.archProgress(R, null, ['cluster'], 'prd');
    yield this.pause(1400, 2000);

    // R.2 — research fan-out
    inv = start(chat, R, SEAT.claude, 58900);
    yield this.pause(500, 900);
    context(chat, R, inv, 61200);
    yield this.pause(2600, 3800);
    yield* say(chat, R, inv, '集群结论一致：采用纯静态单页加纯函数核心。并行调研 iCal、冲突判定、浏览器约束和页面布局，Mini 核对需求条目。');
    yield* tool(chat, R, inv, 'result_read', '已读取集群结论：方案一（纯静态单页 + localStorage）获一致同意。');
    const research = chat.rng.uuid();
    const layout = chat.rng.uuid();
    const W1 = addTask(chat, { turnId: R.turnId, parent: R, role: 'grok', goal: '整理 RFC 5545 中与转义、折行、时区相关的要点', phase: 'architecture', groupId: research });
    const W2 = addTask(chat, { turnId: R.turnId, parent: R, role: 'grok', goal: '调研时段冲突的判定方式与数据规模', phase: 'architecture', groupId: research });
    const W3 = addTask(chat, { turnId: R.turnId, parent: R, role: 'grok', goal: '整理纯静态页面在浏览器侧的约束（模块加载、下载、存储）', phase: 'architecture', groupId: research });
    const H1 = addTask(chat, { turnId: R.turnId, parent: R, role: 'hydrogen', goal: '给出日程板的布局建议（会议室 × 小时）', phase: 'architecture', groupId: layout });
    const N1 = addTask(chat, { turnId: R.turnId, parent: R, role: 'mini', goal: '提取原始需求条目，列出需要默认的未说明项', phase: 'architecture' });
    const fanout = (groupId: string, pool: string, tasks: ServerTask[]) => {
      chat.record.fanoutGroups!.push({ id: groupId, parentTaskId: R.id, pool, total: tasks.length, mode: 'read', createdAt: chat.iso() } as { id: string; parentTaskId: string; pool: string; total: number });
      chat.emit('fanout_queued', { groupId, pool, count: tasks.length }, { task: R, invocation: inv });
      for (const task of tasks) taskUpdate(chat, task);
    };
    yield* tool(chat, R, inv, 'fanout_submit', '已排队 3 个 Grok 并行调研任务。', () => fanout(research, 'grok', [W1, W2, W3]));
    yield* tool(chat, R, inv, 'fanout_submit', '已排队 1 个 Hydrogen 布局任务。', () => fanout(layout, 'hydrogen', [H1]));
    yield* tool(chat, R, inv, 'worker_submit', '已派发 Mini 核对需求条目。', () => {
      raw(chat, 'workers_queued', { pool: 'mini', count: 1 }, R, inv);
      taskUpdate(chat, N1);
    });
    yield* tool(chat, R, inv, 'task_collect', '等待 5 个并行任务回传。', () => { this.TK2 = waitFor(chat, R, inv, { childIds: [W1.id, W2.id, W3.id, H1.id, N1.id] }); });
    usage(chat, R, inv, 63210, 0.95);
    yield this.pause(300, 500);
    end(chat, R, inv, { used: 61200, output: 1500, rotationReason: 'wait' });
    taskUpdate(chat, R);
    yield this.pause(1100, 1600);

    // Pool workers, all started in one tick (bundled packets claude → grok ×3, hydrogen, mini)
    const worker = (task: ServerTask, seat: SeatModel, input: number, used: number, tokens: number, usd: number, note: string) => this.seat(task, seat, {
      input, used, output: 900, tokens, usd, note, disposition: 'adopted', think: [1800, 3200],
      before: invocation => tool(chat, task, invocation, 'user_source_read', '已读取原始需求原文与集群结论。'),
    });
    yield { all: [
      worker(W1, SEAT.grok, 16400, 18200, 18200, 0.11, seatNote('grok/research-ical')),
      worker(W2, SEAT.grok, 19900, 21700, 21700, 0.13, seatNote('grok/research-conflict')),
      worker(W3, SEAT.grok, 15100, 16900, 16900, 0.10, seatNote('grok/research-browser')),
      worker(H1, SEAT.hydrogen, 12800, 14600, 14600, 0.05, seatNote('hydrogen/research-layout')),
      worker(N1, SEAT.mini, 8100, 9400, 9400, 0.04, seatNote('mini/requirements-check')),
    ] };
    yield this.pause(300, 500);
    resolve(chat, this.TK2!, R);
    yield this.pause(1400, 2000);

    // R.3 — PRD and architecture, ending on a soft-limit window hand-over
    inv = start(chat, R, SEAT.claude, 116200);
    yield this.pause(500, 900);
    context(chat, R, inv, 118400);
    yield this.pause(2800, 4000);
    yield* tool(chat, R, inv, 'task_disposition', '已采纳 5 项并行调研结果。', () => raw(chat, 'task_dispositions', { taskIds: [W1.id, W2.id, W3.id, H1.id, N1.id], disposition: 'adopted' }, R, inv));
    yield* say(chat, R, inv, seatNote('claude/prd-architecture'));
    let prd = '';
    let architecture = '';
    yield* tool(chat, R, inv, 'artifact_publish', '已发布 PRD.md（12 条验收标准 AC-01 至 AC-12）。', () => { prd = publish(chat, R, inv, 'prd').id; });
    yield* tool(chat, R, inv, 'artifact_publish', '已发布 ARCHITECTURE.md。', () => { architecture = publish(chat, R, inv, 'architecture').id; });
    context(chat, R, inv, 186400);
    usage(chat, R, inv, 205180, 3.45);
    this.links.set('prd', [R.id]);
    this.links.set('architecture', [R.id]);
    this.evidence.set('prd', [prd]);
    this.evidence.set('architecture', [architecture]);
    this.archProgress(R, inv, ['prd', 'architecture'], 'guide');
    yield this.pause(300, 500);
    end(chat, R, inv, { used: 186400, output: 6100, rotationReason: 'soft', finishReason: 'rotate' });
    raw(chat, 'context_rotated', { checkpointId: `ck-${chat.rng.hex(12)}`, nextSegment: R.segment + 1, reason: 'soft', handoffRef: `blobs/handoff-${inv.id}.txt` }, R, inv);
    taskUpdate(chat, R, { status: 'queued' });
    yield this.pause(900, 1300);

    // R.4 — delegate the guide (Astra) and the core-path Demo (Sol)
    inv = start(chat, R, SEAT.claude, 39800);
    yield this.pause(500, 900);
    context(chat, R, inv, 41300);
    yield this.pause(2600, 3800);
    yield* say(chat, R, inv, 'PRD 与架构已发布。委派 Astra 编写开发指南，Sol 实现并实际运行核心路径 Demo。');
    const D1 = addTask(chat, { turnId: R.turnId, parent: R, role: 'astra', goal: '编写开发指南：目录、运行、测试与约定', phase: 'architecture' });
    const D2 = addTask(chat, { turnId: R.turnId, parent: R, role: 'sol', goal: '实现并实际运行核心路径 Demo：预约、冲突、建议时段、iCal 导出', phase: 'demo', mode: 'edit' });
    yield* tool(chat, R, inv, 'agent_submit', '已委派 Astra 编写开发指南、Sol 实现核心路径 Demo。', () => { taskUpdate(chat, D1); taskUpdate(chat, D2); });
    let TK3: WaitTicket | null = null;
    yield* tool(chat, R, inv, 'task_collect', '等待 Astra、Sol 回传。', () => { TK3 = waitFor(chat, R, inv, { childIds: [D1.id, D2.id] }); });
    usage(chat, R, inv, 41300, 0.66);
    yield this.pause(300, 500);
    end(chat, R, inv, { used: 41300, output: 900, rotationReason: 'wait' });
    taskUpdate(chat, R);
    yield this.pause(1100, 1600);

    let guide = '';
    let demoReport = '';
    yield { all: [
      this.seat(D1, SEAT.astra, { input: 61800, used: 64100, output: 4300, tokens: 64100, usd: 1.02, note: seatNote('astra/dev-guide'), disposition: 'adopted',
        after: invocation => tool(chat, D1, invocation, 'artifact_publish', '已发布 DEV_GUIDE.md。', () => { guide = publish(chat, D1, invocation, 'dev-guide').id; }) }),
      this.seat(D2, SEAT.sol, { input: 101200, used: 103500, output: 5200, tokens: 103500, usd: 1.62, note: seatNote('sol/demo'), disposition: 'adopted',
        before: invocation => this.demoRun(D2, invocation),
        after: invocation => tool(chat, D2, invocation, 'artifact_publish', '已发布 DEMO_REPORT.md。', () => { demoReport = publish(chat, D2, invocation, 'demo-report').id; }),
        afterEnd: () => { publish(chat, D2, null, 'demo-diff', { name: diffName(D2, 1), provenance: 'workspace', snapshots: true }); } }),
    ] };
    this.links.set('guide', [D1.id]);
    this.links.set('demo', [D2.id]);
    this.evidence.set('guide', [guide]);
    this.evidence.set('demo', [demoReport]);
    yield this.pause(300, 500);
    resolve(chat, TK3!, R);
    this.archProgress(R, null, ['guide', 'demo'], 'contract');
    yield this.pause(1400, 2000);

    // R.5 — freeze the contract, then an independent execution review of the Demo
    inv = start(chat, R, SEAT.claude, 86400);
    yield this.pause(500, 900);
    context(chat, R, inv, 88900);
    yield this.pause(2600, 3800);
    yield* say(chat, R, inv, '冻结需求及验收契约（第 1 版），并请 Astra 独立复核 Demo 的执行记录。');
    yield* tool(chat, R, inv, 'contract_submit', '需求及验收契约已冻结（第 1 版：12 条验收标准，2 个里程碑）。', () => {
      const contract = publish(chat, R, inv, 'contract');
      const hash = demoFile('contract').sha256;
      this.pipeline.contract = { ref: `blobs/artifact-${contract.id}.txt`, hash, contractSha256: hash, artifactId: contract.id, revision: 1 };
      raw(chat, 'contract_frozen', { ref: this.pipeline.contract.ref, hash, contractSha256: hash, artifactId: contract.id, revision: 1 }, R, inv);
      this.evidence.set('contract', [contract.id]);
      this.links.set('contract', [R.id]);
      this.archProgress(R, inv, ['contract'], '');
    });
    const V1 = addTask(chat, { turnId: R.turnId, parent: R, role: 'astra', goal: '独立复核 Sol 的 Demo 执行记录', phase: 'acceptance', mode: 'verify', executionReviewOfTaskId: R.id });
    yield* tool(chat, R, inv, 'execution_submit_review', '已委派 Astra 复核 Demo 执行记录。', () => taskUpdate(chat, V1));
    let TK4: WaitTicket | null = null;
    yield* tool(chat, R, inv, 'task_collect', '等待 Astra 回传。', () => { TK4 = waitFor(chat, R, inv, { childIds: [V1.id] }); });
    usage(chat, R, inv, 96700, 1.43);
    yield this.pause(300, 500);
    end(chat, R, inv, { used: 88900, output: 1400, rotationReason: 'wait' });
    taskUpdate(chat, R);
    yield this.pause(1100, 1600);

    yield* this.seat(V1, SEAT.astra, {
      input: 75400, used: 77800, output: 2400, tokens: 77800, usd: 1.18, note: seatNote('astra/execution-review'), disposition: 'adopted',
      before: invocation => tool(chat, V1, invocation, 'execution_read', '已读取 Sol 的执行记录：1 次运行，退出码 0。'),
      after: function* (this: RoomDeskDriver, invocation: ServerInvocation) {
        yield* tool(chat, V1, invocation, 'artifact_publish', '已发布 execution-review.md。', () => { publish(chat, V1, invocation, 'execution-review-arch'); });
        yield* tool(chat, V1, invocation, 'execution_submit_review', '复核结论：通过。', () => raw(chat, 'execution_review', { accepted: true, review: { outcome: 'passed', stepVerdicts: [
          { step: '运行命令', verdict: 'passed' }, { step: '冲突检测', verdict: 'passed' }, { step: '建议时段', verdict: 'passed' }, { step: 'iCal 行尾与折行', verdict: 'passed' },
        ] } }, V1, invocation));
      }.bind(this),
    });
    yield this.pause(300, 500);
    resolve(chat, TK4!, R);
    yield this.pause(1400, 2000);

    // R.6 — the architecture answer, then gate A
    inv = start(chat, R, SEAT.claude, 95200);
    yield this.pause(500, 900);
    context(chat, R, inv, 97600);
    yield this.pause(3000, 4200);
    const summary = plainMarkdown(seatNote('claude/gate-a-summary'));
    yield* say(chat, R, inv, summary);
    usage(chat, R, inv, 98800, 1.44);
    yield* tool(chat, R, inv, 'task_complete', '架构阶段完成，提交关卡 A。');
    yield this.pause(200, 400);
    end(chat, R, inv, { used: 97600, output: 2900, finishReason: 'stop' });
    emitMessage(chat, appendMessage(chat, { role: 'assistant', text: summary, turnId: R.turnId, taskId: R.id }), { task: R, invocation: inv });
    complete(chat, R, summary);
    this.openGate(R, 'A');
    yield { wait: 'gate-A' };

    yield* this.implementation();
  }

  private TK2: WaitTicket | null = null;

  /** Sol's core-path Demo: write the prototype, run it for real (output captured from Node), report. */
  private *demoRun(task: ServerTask, invocation: ServerInvocation): Script {
    const chat = this.chat;
    yield* tool(chat, task, invocation, 'file_write', '已写入 .agent/demo/core-path-demo.mjs（1 个文件，原型不进入交付代码）。');
    const output = demoFile('demo-report').text?.match(/```\n\$ (node[^\n]*)\n([\s\S]*?)```/);
    yield* this.exec(task, invocation, ['node', '.agent/demo/core-path-demo.mjs'], output ? `$ ${output[1]}\n${output[2]}退出码 0` : '退出码 0', [3600, 5000]);
  }

  // ---------------------------------------------------------- implementation and acceptance (turn T2)

  private *implementation(): Script {
    const chat = this.chat;
    const L = this.L!;
    const S = this.S!;
    this.planHash = chat.rng.hex(64);

    // S.1 — plan; DeepSeek fixtures and Opus's plan review run in parallel
    let inv = start(chat, S, SEAT.sol, 70100);
    raw(chat, 'implementation_prepared', { round: 1, contract: this.pipeline.contract }, S, inv);
    plan(chat, S, inv, [...this.archTodos(), this.implTodo('in_progress')]);
    yield this.pause(500, 900);
    context(chat, S, inv, 72500);
    yield this.pause(3000, 4200);
    yield* say(chat, S, inv, seatNote('sol/implementation-plan'));
    const fixtures = chat.rng.uuid();
    const X1 = addTask(chat, { turnId: S.turnId, parent: S, role: 'deepseek', goal: '准备边界时段测试夹具', phase: 'implementation', groupId: fixtures });
    const X2 = addTask(chat, { turnId: S.turnId, parent: S, role: 'deepseek', goal: '准备 iCal 特殊字符测试夹具', phase: 'implementation', groupId: fixtures });
    yield* tool(chat, S, inv, 'fanout_submit', '已排队 2 个 DeepSeek 夹具任务。', () => {
      chat.record.fanoutGroups!.push({ id: fixtures, parentTaskId: S.id, pool: 'deepseek', total: 2, mode: 'read', createdAt: chat.iso() } as { id: string; parentTaskId: string; pool: string; total: number });
      chat.emit('fanout_queued', { groupId: fixtures, pool: 'deepseek', count: 2 }, { task: S, invocation: inv });
      taskUpdate(chat, X1);
      taskUpdate(chat, X2);
    });
    const P1 = addTask(chat, { turnId: S.turnId, parent: S, role: 'opus', goal: '交叉评审 Sol 的实现计划', phase: 'implementation', pipelineWork: { kind: 'plan-review' } });
    yield* tool(chat, S, inv, 'impl_plan_submit', '实现计划已提交，等待 Opus 交叉评审。');
    let TK6: WaitTicket | null = null;
    yield* tool(chat, S, inv, 'task_collect', '等待 Opus、DeepSeek 回传。', () => { TK6 = waitFor(chat, S, inv, { childIds: [X1.id, X2.id, P1.id] }); });
    usage(chat, S, inv, 72500, 1.08);
    yield this.pause(300, 500);
    end(chat, S, inv, { used: 72500, output: 3100, rotationReason: 'wait' });
    taskUpdate(chat, S);
    yield this.pause(1100, 1600);

    yield { all: [
      this.seat(P1, SEAT.opusBuild, { input: 42100, used: 44300, output: 1800, tokens: 44300, usd: 0.71, note: seatNote('opus/plan-review'), disposition: 'adopted',
        after: invocation => tool(chat, P1, invocation, 'review_submit', '评审结论：通过，无缺陷。', () => raw(chat, 'pipeline_review_submitted', {
          subjectHash: this.planHash, reviewerTaskId: P1.id, reviewer: 'opus', reviewerModel: 'claude-opus-5-5', reviewerFamily: 'anthropic',
          author: 'sol', authorModel: 'gpt-6.2-sol', authorFamily: 'openai', outcome: 'passed', defects: [], checks: [],
        }, P1, invocation)),
        afterEnd: () => { this.milestones = { 'M-API': 'authoring', 'M-UI': 'authoring' }; } }),
      this.seat(X1, SEAT.deepseek, { input: 20400, used: 22600, output: 1200, tokens: 22600, usd: 0.26, note: seatNote('deepseek/fixtures-boundaries'), disposition: 'adopted', think: [2000, 3200],
        after: invocation => tool(chat, X1, invocation, 'notes_write', '已写入边界时段夹具 10 组。') }),
      this.seat(X2, SEAT.deepseek, { input: 17600, used: 19800, output: 1100, tokens: 19800, usd: 0.23, note: seatNote('deepseek/fixtures-ical'), disposition: 'adopted', think: [2000, 3200],
        after: invocation => tool(chat, X2, invocation, 'notes_write', '已写入 iCal 特殊字符夹具 4 组。') }),
    ] };
    this.implementationUpdated();
    yield this.pause(300, 500);
    resolve(chat, TK6!, S);
    yield this.pause(1300, 1800);

    // S.2 — dispatch the two milestones
    inv = start(chat, S, SEAT.sol, 36200);
    yield this.pause(500, 900);
    context(chat, S, inv, 38000);
    yield this.pause(1400, 2000);
    yield* say(chat, S, inv, '计划已互签。按里程碑派发：M-API 由我实现、Opus 评审；M-UI 由 Opus 实现、我评审。');
    const A1 = addTask(chat, { turnId: S.turnId, parent: S, role: 'sol', mode: 'edit', phase: 'implementation', pipelineWork: { kind: 'milestone-author', milestoneId: 'M-API' },
      goal: '实现里程碑 M-API：src/roomdesk-core.mjs 与 tests/roomdesk-core-test.mjs' });
    const A2 = addTask(chat, { turnId: S.turnId, parent: S, role: 'opus', mode: 'edit', phase: 'implementation', pipelineWork: { kind: 'milestone-author', milestoneId: 'M-UI' },
      goal: '实现里程碑 M-UI：index.html、src/app.js、src/styles.css' });
    let TK7: WaitTicket | null = null;
    yield* tool(chat, S, inv, 'task_collect', '已派发 M-API（Sol 实现）与 M-UI（Opus 实现），等待回传。', () => {
      taskUpdate(chat, A1);
      taskUpdate(chat, A2);
      TK7 = waitFor(chat, S, inv, { childIds: [A1.id, A2.id] });
    });
    usage(chat, S, inv, 38000, 0.55);
    yield this.pause(300, 500);
    end(chat, S, inv, { used: 38000, output: 700, rotationReason: 'wait' });
    taskUpdate(chat, S);
    yield this.pause(1100, 1600);

    yield { all: [this.milestoneApi(A1, TK7!), this.milestoneUi(A2, TK7!)] };
    yield this.pause(300, 500);
    resolve(chat, TK7!, S);
    yield this.pause(1300, 1800);

    // S.3 — verify both milestones and hand back
    inv = start(chat, S, SEAT.sol, 128400);
    yield this.pause(500, 900);
    context(chat, S, inv, 131000);
    yield this.pause(2600, 3800);
    yield* tool(chat, S, inv, 'milestone_verify', 'M-API：CHECK-API 通过（npm test 30/30）；M-UI：CHECK-UI 通过（子路径加载、无横向滚动、无控制台错误）。');
    yield* say(chat, S, inv, seatNote('sol/handback'));
    usage(chat, S, inv, 131000, 1.25);
    yield this.pause(300, 500);
    end(chat, S, inv, { used: 131000, output: 2200 });
    publish(chat, S, null, 'diff-handback', { name: diffName(S, 3), provenance: 'workspace', snapshots: true });
    yield this.pause(150, 300);
    complete(chat, S, seatNote('sol/handback'), 'adopted');
    plan(chat, L, null, [...this.archTodos(), this.implTodo('completed')]);
    this.pipeline.stage = 'acceptance';
    raw(chat, 'pipeline_stage', { stage: 'acceptance' }, L);
    resolve(chat, this.TK5!, L);
    yield this.pause(1400, 2000);

    // L.1 — delegate the independent acceptance
    inv = start(chat, L, SEAT.claude, 56100);
    yield this.pause(500, 900);
    context(chat, L, inv, 58300);
    yield this.pause(2600, 3800);
    yield* say(chat, L, inv, 'Sol 已交回两个里程碑的集成结果。委派一位全新的 Astra 对冻结产品做独立验收。');
    const Q = addTask(chat, { turnId: L.turnId, parent: L, role: 'astra', goal: '独立验收冻结产品：运行测试并逐条核对 12 项验收标准', phase: 'acceptance', mode: 'verify',
      pipelineWork: { kind: 'product-review' }, executionReviewOfTaskId: L.id });
    yield* tool(chat, L, inv, 'execution_submit_review', '已委派 Astra 独立验收冻结产品。', () => taskUpdate(chat, Q));
    let TK8: WaitTicket | null = null;
    yield* tool(chat, L, inv, 'task_collect', '等待 Astra 回传。', () => { TK8 = waitFor(chat, L, inv, { childIds: [Q.id] }); });
    usage(chat, L, inv, 58300, 0.86);
    yield this.pause(300, 500);
    end(chat, L, inv, { used: 58300, output: 800, rotationReason: 'wait' });
    taskUpdate(chat, L);
    yield this.pause(1100, 1600);

    yield* this.seat(Q, SEAT.astra, {
      input: 81000, used: 83400, output: 3600, tokens: 83400, usd: 1.73, note: seatNote('astra/acceptance'), disposition: 'adopted',
      before: invocation => this.acceptanceRun(Q, invocation),
      after: invocation => tool(chat, Q, invocation, 'artifact_publish', `已发布 ACCEPTANCE.md（12/12 通过）。`, () => { publish(chat, Q, invocation, 'acceptance'); }),
    });
    yield this.pause(300, 500);
    resolve(chat, TK8!, L);
    yield this.pause(1400, 2000);

    // L.2 — trace, package, delivery answer, then gate B
    inv = start(chat, L, SEAT.claude, 89700);
    yield this.pause(500, 900);
    context(chat, L, inv, 92100);
    yield this.pause(2800, 4000);
    yield* tool(chat, L, inv, 'artifact_publish', '已发布 TRACE.md（需求 → 验收 → 源码 → 测试 → 评审）。', () => {
      const trace = publish(chat, L, inv, 'trace');
      const traceFile = demoFile('trace');
      const receipt = { id: chat.rng.uuid(), files: [{ path: 'docs/TRACE.md', hash: traceFile.sha256 }] };
      raw(chat, 'pipeline_trace_published', { ref: `blobs/artifact-${trace.id}.txt`, hash: traceFile.sha256, artifactId: trace.id, unverified: [], mirrorReceipt: receipt }, L, inv);
      const implementation = this.pipeline.implementation as unknown as Record<string, unknown> | undefined;
      if (implementation) implementation.trace = { ref: `blobs/artifact-${trace.id}.txt`, hash: traceFile.sha256, artifactId: trace.id };
    });
    yield* tool(chat, L, inv, 'artifact_publish', '已打包 roomdesk.zip（13 个文件：源码、测试、文档与测试报告）。', () => { publish(chat, L, inv, 'zip'); });
    const delivery = plainMarkdown(seatNote('claude/final-summary'));
    yield* say(chat, L, inv, delivery);
    usageTo(chat, L, inv, 2148960, 31.6742);
    yield* tool(chat, L, inv, 'task_complete', '交付完成，提交关卡 B。');
    yield this.pause(200, 400);
    end(chat, L, inv, { used: 92100, output: 3400, finishReason: 'stop' });
    emitMessage(chat, appendMessage(chat, { role: 'assistant', text: delivery, turnId: L.turnId, taskId: L.id }), { task: L, invocation: inv });
    complete(chat, L, delivery);
    this.openGate(L, 'B');
    yield { wait: 'gate-B' };
  }

  /** M-API: Sol authors, Opus reviews, then integration and the program check. */
  private *milestoneApi(A1: ServerTask, TK7: WaitTicket): Script {
    const chat = this.chat;
    const S = this.S!;
    yield* this.seat(A1, SEAT.sol, {
      input: 115900, used: 118700, output: 9800, tokens: 118700, usd: 1.74, note: seatNote('sol/milestone-api'), disposition: 'adopted', think: [3500, 5000],
      before: function* (this: RoomDeskDriver, invocation: ServerInvocation) {
        yield* tool(chat, A1, invocation, 'file_write', '已写入 src/roomdesk-core.mjs。', undefined, [1600, 2600]);
        yield* tool(chat, A1, invocation, 'file_write', '已写入 tests/roomdesk-core-test.mjs（6 组 30 个用例）。', undefined, [1400, 2200]);
        yield* tool(chat, A1, invocation, 'file_write', '已写入 package.json（test 脚本，无依赖）。', undefined, [500, 900]);
        yield* this.exec(A1, invocation, ['npm', 'test'], `$ npm test\nℹ tests ${TEST_PASS + TEST_FAIL}\nℹ pass ${TEST_PASS}\nℹ fail ${TEST_FAIL}\n退出码 0`);
      }.bind(this),
      afterEnd: () => { publish(chat, A1, null, 'diff-api', { name: diffName(A1, 1), provenance: 'workspace', snapshots: true }); },
    });
    this.milestones['M-API'] = 'reviewing';
    this.implementationUpdated();
    yield this.pause(900, 1300);
    const RV1 = addTask(chat, { turnId: S.turnId, parent: S, role: 'opus', mode: 'verify', phase: 'implementation', pipelineWork: { kind: 'milestone-review', milestoneId: 'M-API' },
      goal: '交叉评审里程碑 M-API' });
    extendTicket(chat, TK7, S, [RV1.id]);
    yield* this.seat(RV1, SEAT.opusBuild, {
      input: 59300, used: 61500, output: 1900, tokens: 61500, usd: 0.92, note: seatNote('opus/milestone-review-api'), disposition: 'adopted',
      before: function* (this: RoomDeskDriver, invocation: ServerInvocation) {
        yield* this.exec(RV1, invocation, ['npm', 'test'], `$ npm test\n${TEST_PASS} 通过、${TEST_FAIL} 失败，退出码 0`);
        this.testResult(RV1, invocation, `npm test · 退出码 0\nℹ tests ${TEST_PASS + TEST_FAIL}\nℹ pass ${TEST_PASS}\nℹ fail ${TEST_FAIL}`);
      }.bind(this),
      after: invocation => tool(chat, RV1, invocation, 'review_submit', '评审结论：通过，无阻断缺陷。', () => raw(chat, 'pipeline_review_submitted', {
        subjectHash: chat.rng.hex(64), reviewerTaskId: RV1.id, reviewer: 'opus', reviewerModel: 'claude-opus-5-5', reviewerFamily: 'anthropic',
        author: 'sol', authorModel: 'gpt-6.2-sol', authorFamily: 'openai', outcome: 'passed', defects: [], checks: ['CHECK-API'],
      }, RV1, invocation)),
    });
    yield* this.integrate('M-API', ['package.json', 'src/roomdesk-core.mjs', 'tests/roomdesk-core-test.mjs'], 'CHECK-API');
  }

  /** M-UI: Opus authors in an isolated candidate, Sol reviews, then integration and the program check. */
  private *milestoneUi(A2: ServerTask, TK7: WaitTicket): Script {
    const chat = this.chat;
    const S = this.S!;
    yield* this.seat(A2, SEAT.opusBuild, {
      input: 106500, used: 109200, output: 11800, tokens: 109200, usd: 1.63, note: seatNote('opus/milestone-ui'), disposition: 'adopted', think: [3800, 5200],
      before: function* (this: RoomDeskDriver, invocation: ServerInvocation) {
        yield* tool(chat, A2, invocation, 'file_write', '已写入 index.html。', undefined, [1400, 2000]);
        yield* tool(chat, A2, invocation, 'file_write', '已写入 src/app.js。', undefined, [2400, 3600]);
        yield* tool(chat, A2, invocation, 'file_write', '已写入 src/styles.css。', undefined, [1800, 2800]);
      }.bind(this),
      afterEnd: () => { publish(chat, A2, null, 'diff-ui', { name: diffName(A2, 1), provenance: 'workspace', snapshots: true }); },
    });
    this.milestones['M-UI'] = 'reviewing';
    this.implementationUpdated();
    yield this.pause(900, 1300);
    const RV2 = addTask(chat, { turnId: S.turnId, parent: S, role: 'sol', mode: 'verify', phase: 'implementation', pipelineWork: { kind: 'milestone-review', milestoneId: 'M-UI' },
      goal: '交叉评审里程碑 M-UI' });
    extendTicket(chat, TK7, S, [RV2.id]);
    yield* this.seat(RV2, SEAT.sol, {
      input: 56500, used: 58800, output: 1700, tokens: 58800, usd: 0.88, note: seatNote('sol/milestone-review-ui'), disposition: 'adopted',
      // CHECK-UI is a browser check (CONTRACT.json kind 'browser'), not a project script.
      before: invocation => tool(chat, RV2, invocation, 'page_check', '子路径 /sub/path/ 下加载页面：4 个请求，无 404、无控制台错误；1280×720 与 375 px 宽度下无横向滚动。', undefined, [2400, 3400]),
      after: invocation => tool(chat, RV2, invocation, 'review_submit', '评审结论：通过。', () => raw(chat, 'pipeline_review_submitted', {
        subjectHash: chat.rng.hex(64), reviewerTaskId: RV2.id, reviewer: 'sol', reviewerModel: 'gpt-6.2-sol', reviewerFamily: 'openai',
        author: 'opus', authorModel: 'claude-opus-5-5', authorFamily: 'anthropic', outcome: 'passed', defects: [], checks: ['CHECK-UI'],
      }, RV2, invocation)),
    });
    yield* this.integrate('M-UI', ['index.html', 'src/app.js', 'src/styles.css'], 'CHECK-UI');
  }

  /** Integration of one reviewed milestone into the main workspace, then its frozen check. */
  private *integrate(milestone: Milestone, files: string[], checkId: string): Script {
    const chat = this.chat;
    const S = this.S!;
    this.milestones[milestone] = 'integrating';
    this.implementationUpdated();
    yield this.pause(1100, 1600);
    raw(chat, 'milestone_integrated', { milestoneId: milestone, attempt: 1, integration: { journalId: chat.rng.uuid(), changed: [], created: files } }, S);
    this.milestones[milestone] = 'verifying';
    this.implementationUpdated();
    raw(chat, 'milestone_check_started', { milestoneId: milestone, attempt: 1 }, S);
    yield this.pause(3000, 4200);
    raw(chat, 'milestone_verified', {
      milestoneId: milestone, attempt: 1, status: 'complete',
      checks: [{ checkId, ref: `blobs/check-${chat.rng.hex(12)}.txt`, hash: chat.rng.hex(64), snapshotId: `wsnap-${chat.rng.hex(12)}`, fingerprint: chat.rng.hex(16), ok: true }],
      mirrorReceipt: { id: chat.rng.uuid(), files: files.map(path => ({ path, hash: chat.rng.hex(64) })) },
    }, S);
    this.milestones[milestone] = 'complete';
    this.implementationUpdated();
  }

  /** Astra's acceptance: run the delivered tests in the sandbox (the runner receipt carries the real report). */
  private *acceptanceRun(Q: ServerTask, invocation: ServerInvocation): Script {
    const chat = this.chat;
    yield* this.exec(Q, invocation, ['npm', 'test'], `$ npm test\nℹ tests ${TEST_PASS + TEST_FAIL}\nℹ pass ${TEST_PASS}\nℹ fail ${TEST_FAIL}\n退出码 0`, [4200, 6000]);
    this.testResult(Q, invocation, TEST_REPORT);
    publish(chat, Q, invocation, 'test-report', { provenance: 'runner' });
    yield this.pause(400, 700);
    yield* tool(chat, Q, invocation, 'page_check', '逐项操作验证：楼层筛选、冲突提示与一键建议、我的预约、单场与整天 .ics 导出、刷新保留、存储不可用时的降级提示。', undefined, [3200, 4600]);
  }
}

/**
 * Creates the RoomDesk pipeline chat with the first user message (events 1 and 2) and spawns its script. The
 * scheduler starts in instant mode; the caller either runs it instantly (pre-baked, rebuild) or calls goLive().
 * Only the pre-baked sample (presetProject) is bound to the preset workspace w-roomdesk and shows its deliverables as
 * saved to that project. A run the visitor starts stays 仅对话, as the composer promised before sending
 * (不写入已授权项目目录).
 */
export function createRoomDeskChat(options: { id: string; wallBase: number; clientMessageId: string; title?: string; presetProject?: boolean }): DemoChat {
  const chat = new DemoChat({ id: options.id, title: options.title ?? ROOMDESK_TITLE, wallBase: options.wallBase, ...(options.presetProject ? { workspaceId: 'w-roomdesk' } : {}), pipeline: newPipeline() });
  const driver = new RoomDeskDriver(chat);
  chat.driver = driver;
  driver.accept(options.clientMessageId);
  chat.sched.spawn(driver.architecture());
  return chat;
}

/** The answer for 'revise' and 'cancel' at a gate. */
export function gateRefusal(): InputResult {
  return RoomDeskDriver.refusal();
}
