// Run 4 of 4 (README.md "Runs"): 日志采集管线成本评估 — dual design, cross review in progress. Two review tasks are
// running; the run mock streams a scripted progress line for one of them every few seconds (LiveScript below).
// Times are relative to `now`: the run was created 38 minutes before the demo was loaded, the reviews started
// 200 and 170 seconds before.
import type { HardConstraint, ProjectInput, RequirementSnapshot, Run } from '../../../src/lib/types';
import { commonFields, EMPTY_DOCS, gate, proposal, question, started, task, timeline, trail, type ProposalBody, type RunBundle } from './common';

export const LOG_RUN_ID = 'r-20261120-5b81c3';
const V1 = 'v1-c3e8a0f5b214';
const V2 = 'v2-58d1f7a3c90e';
const REVIEW_CLAUDE = 't-r1-review-claude-a1';
const REVIEW_ASTRA = 't-r1-review-astra-a1';

const project: ProjectInput = {
  title: '日志采集管线成本评估',
  prompt: '现有日志采集链路每天约 800 GB，存储与检索费用持续上涨。希望评估采样、分级存储和字段裁剪等方案，在错误日志全量保留、30 天内可检索的前提下，把月度成本降低 40% 以上。',
  coreFlows: ['采集端按级别处理日志', '热数据快速检索', '冷数据按需回放与检索'],
  existingStack: '各服务输出 JSON 日志，采集端为节点上的日志代理，集中写入自建检索集群',
  deployment: '云上 Kubernetes，约 120 个节点',
  budget: '一名平台工程师，一个季度',
  acceptance: '月度成本降低 40% 以上；错误日志 30 天内可检索',
  context: '',
};
const constraints: HardConstraint[] = [
  { id: 'H1', text: '错误级别日志 100% 保留且 30 天内可检索', kind: 'must' },
  { id: 'H2', text: '修改业务服务的日志输出格式', kind: 'must_not' },
];
const acceptance = [
  { id: 'AC1', description: '采样与路由规则的单元测试全部通过', kind: 'command' as const, command: 'npm test', expectExitCode: 0, outputIncludes: null },
  { id: 'AC2', description: '回放一天的样本日志，错误日志条数与原始一致', kind: 'command' as const, command: 'npm run replay -- --sample day1', expectExitCode: 0, outputIncludes: 'errors kept: 100%' },
  { id: 'AC3', description: '按新方案估算的月度成本降低 40% 以上', kind: 'manual' as const, command: null, expectExitCode: null, outputIncludes: null },
];
const plan = (workstreams: { id: string; title: string; dependsOn: string[] }[], effort: string): ProposalBody['mvpPlan'] => ({
  goal: '用一天的样本日志验证新管线保留全部错误日志，并给出可核对的成本估算', scopeIn: ['采样与路由规则', '冷热分层写入', '样本回放与成本估算'], scopeOut: ['迁移历史数据', '检索界面改版'], acceptance,
  hypotheses: [{ id: 'HY1', text: '信息级日志按 10% 采样后仍能定位 95% 的线上问题', howToVerify: '用最近 20 个故障复盘回放', passCriteria: '至少 19 个故障可定位' }], workstreams, estimatedEffort: effort,
});

export function buildLogRun(now: number): RunBundle {
  const t = timeline(now - 38 * 60_000);
  const at = (secondsBeforeNow: number) => new Date(now - secondsBeforeNow * 1000).toISOString();
  const run = { id: LOG_RUN_ID, models: commonFields().models };
  const snapshots: RequirementSnapshot[] = [
    { version: 1, ref: V1, hash: V1.slice(3), createdAt: t(0), reason: '用户输入', project, constraints, facts: [{ id: 'F1', text: '日志量约每天 800 GB', source: 'user_input' }], assumptions: [], openItems: [] },
    { version: 2, ref: V2, hash: V2.slice(3), createdAt: t(9.5), reason: '合并 G1 回答', project, constraints,
      facts: [
        { id: 'F1', text: '日志量约每天 800 GB', source: 'user_input' },
        { id: 'F2', text: '审计日志与错误日志一样全量保留 30 天', source: 'answer:Q1' },
        { id: 'F3', text: '成本目标在下个季度内达成', source: 'answer:Q2' },
      ],
      assumptions: [{ id: 'A1', text: '热数据 5 秒内、冷数据 1 分钟内返回检索结果即可', source: 'default:Q3' }], openItems: [] },
  ];
  const tasks = [
    task(run, { id: 't-clarify-claude-a1', role: 'claude', phase: 'clarify', scope: 'clarify', createdAt: t(0.02), startedAt: t(0.05), endedAt: t(3.2), inputRef: V1 }),
    task(run, { id: 't-r1-propose-claude-a1', role: 'claude', phase: 'propose', scope: 'r1-propose', createdAt: t(9.55), startedAt: t(9.6), endedAt: t(21.8), inputRef: V2 }),
    task(run, { id: 't-r1-propose-astra-a1', role: 'astra', phase: 'propose', scope: 'r1-propose', createdAt: t(9.55), startedAt: t(9.6), endedAt: t(34.5), inputRef: V2 }),
    task(run, { id: REVIEW_CLAUDE, role: 'claude', phase: 'review', scope: 'r1-review', createdAt: t(34.55), startedAt: at(200), endedAt: null, status: 'running', inputRef: V2, lastProgress: '正在对方案 B 打分', extra: { lastProgressAt: at(5) } }),
    task(run, { id: REVIEW_ASTRA, role: 'astra', phase: 'review', scope: 'r1-review', createdAt: t(34.55), startedAt: at(170), endedAt: null, status: 'running', inputRef: V2, lastProgress: '读取方案 A 的采样规则', extra: { lastProgressAt: at(8) } }),
  ];
  const byId = (id: string) => tasks.find(item => item.id === id)!;
  const questions = [
    question({ id: 'Q1', askedBy: 'claude', taskId: 't-clarify-claude-a1', createdAt: t(3.2), topic: 'data', priority: 'blocking', multiSelect: false,
      text: '除了错误日志，还有哪些日志必须全量保留？', whyItMatters: '决定采样规则的豁免范围与存储量估算',
      options: [{ id: 'audit', label: '审计日志也全量保留', implication: '豁免范围扩大约 6%' }, { id: 'error', label: '只有错误日志', implication: '采样空间最大' }],
      defaultOptionIds: ['error'], defaultAssumption: '只有错误级别日志全量保留', answer: { optionIds: ['audit'], at: t(6.8) } }),
    question({ id: 'Q2', askedBy: 'claude', taskId: 't-clarify-claude-a1', createdAt: t(3.2), topic: 'budget_timeline', priority: 'important', multiSelect: false,
      text: '成本目标需要在什么时间内达成？', whyItMatters: '影响是否可以分阶段迁移',
      options: [{ id: 'quarter', label: '下个季度内', implication: '需要优先做见效快的环节' }, { id: 'half', label: '半年内', implication: '可以分两阶段迁移' }],
      defaultOptionIds: ['half'], defaultAssumption: '半年内达成', answer: { optionIds: ['quarter'], at: t(8.1) } }),
    question({ id: 'Q3', askedBy: 'claude', taskId: 't-clarify-claude-a1', createdAt: t(3.2), topic: 'performance', priority: 'optional', multiSelect: false,
      text: '可以接受的检索延迟是多少？', whyItMatters: '决定冷数据能否放在对象存储并按需回放',
      options: [{ id: 'tiered', label: '热数据 5 秒内、冷数据 1 分钟内', implication: '冷数据可放对象存储' }, { id: 'fast', label: '全部 5 秒内', implication: '冷热分层收益有限' }],
      defaultOptionIds: ['tiered'], defaultAssumption: '热数据 5 秒内、冷数据 1 分钟内返回检索结果即可' }),
  ];
  const propC = proposal('claude', 2, {
    title: '采集端分级采样 + 冷热分层存储',
    summary: '在节点日志代理上按级别处理：错误与审计日志全量，信息级按 10% 采样，调试级丢弃；热数据在检索集群保留 7 天，之后转存对象存储并按需回放检索。',
    fitWhen: ['日志量以信息级为主', '冷数据检索频率低'], notFitWhen: ['需要对全部信息级日志做精确统计'],
    stack: [{ layer: '采集', choice: '节点日志代理 + 采样规则', reason: '在源头减少传输量' }, { layer: '热存储', choice: '现有检索集群（保留 7 天）', reason: '复用已有能力' }, { layer: '冷存储', choice: '对象存储 + 列式压缩', reason: '单价低' }],
    modules: [
      { id: 'agent', name: '采集代理规则', responsibility: '按级别采样与路由', tech: '日志代理' },
      { id: 'hot', name: '热数据集群', responsibility: '7 天内快速检索', tech: '检索集群' },
      { id: 'archive', name: '冷数据归档', responsibility: '每日转存与压缩', tech: '对象存储' },
      { id: 'replay', name: '按需回放', responsibility: '把冷数据回放到临时索引', tech: null },
    ],
    flows: [{ from: 'agent', to: 'hot', label: '采样后写入', kind: 'data' }, { from: 'hot', to: 'archive', label: '每日转存', kind: 'event' }, { from: 'archive', to: 'replay', label: '按需回放', kind: 'call' }],
    dataModel: '日志字段保持原样；对象存储按 date/service/level 分区，Parquet 列式文件',
    deployment: '采样规则随日志代理配置下发；归档任务以集群定时任务运行',
    tradeoffs: [{ gain: '传输与存储量同时下降，预计月度成本降低约 55%', cost: '信息级日志无法做精确计数' }],
    risks: [{ text: '采样规则配置错误会丢失错误日志', severity: 'high', mitigation: '规则上线前用样本回放校验错误日志条数' }],
    assumptions: [{ text: '冷数据检索 1 分钟内返回即可', questionId: 'Q3' }],
    constraintChecks: [{ constraintId: 'H1', status: 'pass', note: '错误与审计日志不参与采样' }, { constraintId: 'H2', status: 'pass', note: '只改采集端配置' }],
    mvpPlan: plan([{ id: 'W1', title: '采样与路由规则', dependsOn: [] }, { id: 'W2', title: '冷数据归档与回放', dependsOn: [] }], '约 15 人日'),
  });
  const propA = proposal('astra', 2, {
    title: '集中流处理裁剪字段 + 列式压缩存储',
    summary: '日志代理原样上送到集中流处理层，按规则裁剪冗余字段并合并重复堆栈，再写入列式压缩存储；检索层按需回放到临时索引。',
    fitWhen: ['冗余字段占比高', '希望保留全部日志条目'], notFitWhen: ['不希望新增常驻流处理集群'],
    stack: [{ layer: '流处理', choice: '集中流处理集群', reason: '统一裁剪规则' }, { layer: '存储', choice: '列式压缩存储', reason: '压缩率高' }],
    modules: [
      { id: 'ingest', name: '集中接入', responsibility: '接收全部日志', tech: '消息队列' },
      { id: 'trim', name: '字段裁剪', responsibility: '裁剪冗余字段、合并重复堆栈', tech: '流处理' },
      { id: 'columnar', name: '列式存储', responsibility: '压缩保存 30 天', tech: '列式数据库' },
      { id: 'query', name: '检索回放', responsibility: '按需建立临时索引', tech: null },
    ],
    flows: [{ from: 'ingest', to: 'trim', label: '原样上送', kind: 'data' }, { from: 'trim', to: 'columnar', label: '裁剪后写入', kind: 'data' }, { from: 'query', to: 'columnar', label: '按需读取', kind: 'call' }],
    dataModel: '裁剪后的日志表按 service 与 day 分区；重复堆栈存为指纹 + 引用',
    deployment: '新增流处理集群与列式数据库，与现有检索集群并行运行一个月后切换',
    tradeoffs: [{ gain: '保留全部日志条目，统计口径不变', cost: '新增两个常驻组件，运维成本上升' }],
    risks: [{ text: '流处理集群故障时日志积压', severity: 'medium', mitigation: '消息队列保留 48 小时' }],
    assumptions: [{ text: '冗余字段约占日志体积的 35%', questionId: null }],
    constraintChecks: [{ constraintId: 'H1', status: 'pass', note: '不丢弃任何条目' }, { constraintId: 'H2', status: 'pass', note: '裁剪在集中层进行' }],
    mvpPlan: plan([{ id: 'W1', title: '接入与裁剪规则', dependsOn: [] }, { id: 'W2', title: '列式存储与回放', dependsOn: ['W1'] }], '约 22 人日'),
  });
  const full: Run = {
    ...commonFields(), id: LOG_RUN_ID, title: project.title, createdAt: t(0), updatedAt: at(200),
    phase: 'review', phaseStatus: 'running', blockedReason: null, terminal: null, clarifyWith: 'claude',
    designMode: 'dual', riskLevel: 'medium', designResolution: { mode: 'dual', reasons: ['用户显式选择 dual'], architects: ['claude', 'astra'], reviewers: ['claude', 'astra'] },
    criteriaLockedAt: t(9.55), snapshots, currentSnapshotVersion: 2, designSnapshotVersion: 2, tasks, questions,
    modelNotes: [
      { taskId: 't-clarify-claude-a1', role: 'claude', phase: 'clarify', understanding: '你要在不改业务日志格式的前提下，把日志成本降低 40% 以上，错误日志全量保留 30 天。', gaps: ['全量保留的范围未说明', '期限未说明'], whyThisCount: null, rejectedAlternatives: [] },
      { taskId: 't-r1-propose-claude-a1', role: 'claude', phase: 'propose', understanding: null, gaps: [], whyThisCount: '成本主要来自信息级日志的传输与存储，从源头采样见效最快。', rejectedAlternatives: [{ title: '只缩短保留期', reason: '违反 H1 的 30 天检索要求' }] },
      { taskId: 't-r1-propose-astra-a1', role: 'astra', phase: 'propose', understanding: null, gaps: [], whyThisCount: '保留全部条目、只裁剪字段，统计口径不变。', rejectedAlternatives: [] },
    ],
    proposals: [propC, propA], judgments: [], candidates: [], decision: null, docs: structuredClone(EMPTY_DOCS),
    gates: [gate('G1_answers', t(3.25), t(9.5), { action: 'submit' }, { questionCount: 3 })],
    jobBatch: 0, jobs: [], finalChoice: null,
  };
  const trails = {
    't-clarify-claude-a1': trail(byId('t-clarify-claude-a1'), [started('claude-opus-5-5', 'max'), [10, 'tool', '读取需求快照 v1'], [90, 'message', '复述需求：不改日志格式，错误日志全量 30 天，月度成本降低 40% 以上。'], [185, 'message', '提出 3 个澄清问题：全量保留范围、期限、检索延迟。']]),
    't-r1-propose-claude-a1': trail(byId('t-r1-propose-claude-a1'), [started('claude-opus-5-5', 'max'), [20, 'tool', '读取需求快照 v2'], [300, 'info', '估计已生成 6100 tokens'], [520, 'message', '成本大头是信息级日志：在采集端分级采样，冷热分层存储。'], [720, 'message', '提交 1 个方案；放弃“只缩短保留期”（违反 H1）。']]),
    't-r1-propose-astra-a1': trail(byId('t-r1-propose-astra-a1'), [started('gpt-6.2-astra', 'max'), [20, 'tool', '读取需求快照 v2'], [700, 'message', '保留全部条目：集中裁剪冗余字段并合并重复堆栈。'], [1480, 'message', '提交 1 个方案；新增组件的运维成本列为主要代价。']]),
    [REVIEW_CLAUDE]: trail(byId(REVIEW_CLAUDE), [started('claude-opus-5-5', 'max'), [18, 'tool', '读取匿名方案 A、B 与评分锚点'], [92, 'message', '方案 A「需求适配」给 4 分：错误日志在采集端旁路全量保留。'], [150, 'info', '估计已生成 3100 tokens'], [195, 'message', '正在对方案 B 打分']]),
    [REVIEW_ASTRA]: trail(byId(REVIEW_ASTRA), [started('gpt-6.2-astra', 'max'), [25, 'tool', '读取匿名方案 A、B 与评分锚点'], [96, 'message', '方案 B 的 H2 判定满足：裁剪在集中层进行，业务日志格式不变。'], [162, 'tool', '读取方案 A 的采样规则']]),
  };
  const live: RunBundle['live'] = {
    intervalMs: [2200, 4200],
    lines: [
      { taskId: REVIEW_CLAUDE, kind: 'tool', text: '对照评分锚点「开发与维护成本」' },
      { taskId: REVIEW_ASTRA, kind: 'message', text: '方案 A「可靠性」给 4 分：采样规则上线前用样本回放校验。' },
      { taskId: REVIEW_CLAUDE, kind: 'message', text: '方案 B「开发与维护成本」给 3 分：需要新增流处理集群与列式数据库。' },
      { taskId: REVIEW_ASTRA, kind: 'info', text: '估计已生成 {tokens} tokens' },
      { taskId: REVIEW_CLAUDE, kind: 'info', text: '估计已生成 {tokens} tokens' },
      { taskId: REVIEW_ASTRA, kind: 'tool', text: '核对方案 A 的成本估算：传输量与存储量分别下降' },
      { taskId: REVIEW_CLAUDE, kind: 'message', text: '方案 B 的 H1 判定满足：不丢弃任何条目。' },
      { taskId: REVIEW_ASTRA, kind: 'message', text: '方案 A「性能与资源成本」给 5 分：源头减少传输量。' },
      { taskId: REVIEW_CLAUDE, kind: 'tool', text: '读取方案 B 的部署与回滚说明' },
      { taskId: REVIEW_ASTRA, kind: 'info', text: '估计已生成 {tokens} tokens' },
      { taskId: REVIEW_CLAUDE, kind: 'message', text: '方案 B「可靠性」给 4 分：消息队列保留 48 小时可防积压丢失。' },
      { taskId: REVIEW_ASTRA, kind: 'message', text: '提出反对意见：方案 A 信息级采样后无法做精确计数，需在报告中说明。' },
      { taskId: REVIEW_CLAUDE, kind: 'info', text: '估计已生成 {tokens} tokens' },
      { taskId: REVIEW_ASTRA, kind: 'tool', text: '对照评分锚点「后续演进」' },
      { taskId: REVIEW_CLAUDE, kind: 'message', text: '方案 A 与 B 均满足 H2：业务服务日志格式不变。' },
      { taskId: REVIEW_ASTRA, kind: 'message', text: '方案 B「开发与维护成本」给 2 分：两个新常驻组件。' },
      { taskId: REVIEW_CLAUDE, kind: 'tool', text: '整理评分依据与证据引用' },
      { taskId: REVIEW_ASTRA, kind: 'tool', text: '整理评分依据与证据引用' },
    ],
  };
  return { run: full, trails, docs: {}, files: {}, live };
}
