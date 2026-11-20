import type { AgentTask, ChatPipelineStage, ChatRecord, DriverCapability, Invocation, TaskStatus } from '../../lib/chat-api';
import type { ToolEvidence } from '../../pages/chat/chatModel';
import type { RotationNotice } from '../../pages/chat/PipelineStatus';

// Dev-only sample: nine seats and twelve dispatch edges, timed relative to "now" so return pulses are visible.
type Edge = [id: string, parent: string, role: string, status: TaskStatus, goal: string];

const EDGES: Edge[] = [
  ['astra-review', 'root', 'astra', 'running', '独立评审架构草案与关卡证据'],
  ['sol-build', 'root', 'sol', 'waiting_children', '实现会议室预约核心与集成'],
  ['opus-arch', 'root', 'opus', 'completed', '架构互参：给出第二方案'],
  ['grok-scan', 'root', 'grok', 'running', '并行扫描依赖与接口约束'],
  ['carbon-alt', 'root', 'carbon', 'completed', '列出备选思路与适用条件'],
  ['deepseek-code', 'sol-build', 'deepseek', 'running', '实现冲突检测逻辑并补齐单测'],
  ['mini-fmt', 'sol-build', 'mini', 'completed', '整理配置样例'],
  ['hydrogen-check', 'opus-arch', 'hydrogen', 'completed', '并行校验时序约束'],
  ['hydrogen-verify', 'astra-review', 'hydrogen', 'running', '核对验收口径与证据清单'],
  ['mini-grok', 'grok-scan', 'mini', 'running', '汇总接口清单'],
  ['deepseek-opus', 'opus-arch', 'deepseek', 'completed', '评估第二方案的实现成本'],
  ['astra-carbon', 'carbon-alt', 'astra', 'queued', '复核备选方案的风险'],
];

const EXTRA: Edge[] = [
  ['ext-scout', 'grok-scan', 'scout', 'running', '补充检索公开资料'],
  ['ext-review', 'astra-review', 'reviewer-2', 'completed', '第二评审意见'],
  ['ext-long', 'sol-build', 'very-long-seat-name-for-layout-check', 'waiting_children', '长名称席位的布局检查'],
];

const EFFORTS: Record<string, string> = {
  claude: 'max', astra: 'ultra', sol: 'xhigh', grok: 'high', opus: 'max',
  carbon: 'medium', hydrogen: 'low', deepseek: 'high', mini: 'low',
};

const MODELS: Record<string, string> = {
  claude: 'claude-opus-5-5', astra: 'gpt-6.2-astra', sol: 'gpt-6.2-sol', grok: 'grok-4.7-high-fast', opus: 'claude-opus-5-5',
  carbon: 'gemini-3.5-pro', hydrogen: 'grok-4.7-mini', deepseek: 'deepseek-v4', mini: 'gpt-6.2-mini',
};

export function observatoryFixture(stage: ChatPipelineStage = 'implementation', options: { extraSeats?: boolean; noLinks?: boolean } = {}) {
  const now = Date.now();
  const iso = (offsetSeconds: number) => new Date(now + offsetSeconds * 1000).toISOString();
  const task = (id: string, role: string, status: TaskStatus, goal: string, parentTaskId?: string, updated = -20): AgentTask => ({
    id, role, status, goal, parentTaskId, turnId: 'turn-2', createdAt: iso(-300), updatedAt: iso(updated),
    segment: 1, invocationIds: [], noProgressSegments: 0, mode: 'read',
  });
  const tasks: AgentTask[] = [
    task('old-root', 'claude', 'completed', '上一轮：梳理需求', undefined, -900),
    // Only the root lead can ask the user in production, so the sample's open question sits on the root.
    task('root', 'claude', 'waiting_user', '拆解团队会议室预约工具的交付'),
    ...EDGES.map(([id, parent, role, status, goal], index) => task(id, role, status, goal, options.noLinks ? undefined : parent, status === 'completed' ? -2 - index : -30 - index)),
    // Extra seats with ids the palette does not know, including one long id, to exercise fallbacks and truncation.
    ...(options.extraSeats ? EXTRA.map(([id, parent, role, status, goal], index) => task(id, role, status, goal, options.noLinks ? undefined : parent, -40 - index)) : []),
  ];
  tasks[0].turnId = 'turn-1';
  const contextHard: Record<string, number> = { claude: 1_000_000, astra: 400_000, sol: 400_000, opus: 1_000_000, grok: 256_000, deepseek: 128_000 };
  const contextUsed: Record<string, number> = { claude: 612_400, astra: 341_900, sol: 128_300, opus: 402_000, grok: 61_200, deepseek: 93_500 };
  const invocations: Invocation[] = tasks.filter(item => item.turnId === 'turn-2').map((item, index) => ({
    id: 'inv-' + item.id, taskId: item.id, segment: 1, status: item.status === 'running' ? 'running' : 'exited',
    startedAt: iso(-200 + index * 5), endedAt: item.status === 'completed' ? iso(-1 - index) : undefined,
    toolCount: 3 + index, promptVersion: 'v1', inputEstimate: 0,
    contextWindow: contextHard[item.role] ?? null, contextHard: contextHard[item.role], contextUsed: contextUsed[item.role] ?? null,
    model: MODELS[item.role], effort: ['carbon', 'mini'].includes(item.role) ? undefined : EFFORTS[item.role],
    rotationReason: item.role === 'astra' ? 'soft' : undefined,
  }));
  const chat: ChatRecord = {
    version: 1, id: 'dev-observatory', title: 'RoomDesk 会议室预约工具 · 架构与实现', createdAt: iso(-900), updatedAt: iso(-1),
    seq: 80, messageSeq: 12,
    turns: [
      { id: 'turn-1', rootTaskId: 'old-root', status: 'completed', createdAt: iso(-900) },
      { id: 'turn-2', rootTaskId: 'root', status: 'waiting_user', createdAt: iso(-300) },
    ],
    tasks, invocations,
    tickets: [{ id: 'ticket-1', taskId: 'root', invocationId: 'inv-root', type: 'user', question: '验收口径以哪份文档为准？', status: 'pending', createdAt: iso(-25) }],
    artifacts: [
      { id: 'a1', taskId: 'opus-arch', name: 'architecture-b.md', relativePath: 'architecture-b.md', hash: 'h1', bytes: 9000, kind: 'file', createdAt: iso(-8) },
      { id: 'a2', taskId: 'mini-fmt', name: 'config.sample.json', relativePath: 'config.sample.json', hash: 'h2', bytes: 800, kind: 'file', createdAt: iso(-6) },
      { id: 'a3', taskId: 'hydrogen-check', name: 'timing-report.md', relativePath: 'timing-report.md', hash: 'h3', bytes: 2400, kind: 'report', createdAt: iso(-4) },
    ],
    checkpoints: [], constraintMessageIds: [],
    pipeline: {
      preset: 'flagship', stage, revision: 1,
      gates: { clarify: 'user', architecture: 'user', delivery: 'user' },
    },
  };
  const capabilities: DriverCapability[] = Object.keys(EFFORTS).map(role => ({
    role, available: role !== 'carbon' || true, isolationVerified: true, model: MODELS[role], effort: EFFORTS[role],
  }));
  const activity: ToolEvidence[] = [
    { id: 't1', seq: 1, taskId: 'deepseek-code', name: 'read_file', status: 'completed', at: iso(-12) },
    { id: 't2', seq: 2, taskId: 'grok-scan', name: 'search_repo', status: 'running', at: iso(-9) },
    { id: 't3', seq: 3, taskId: 'astra-review', name: 'run_tests', status: 'failed', at: iso(-7) },
  ];
  const rotations: RotationNotice[] = [{ id: 'r1', taskId: 'astra-review', reason: 'soft', nextSegment: 2, at: iso(-5) }];
  return { chat, capabilities, activity, rotations };
}
