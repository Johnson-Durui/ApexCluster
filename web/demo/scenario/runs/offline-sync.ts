// Run 2 of 4 (README.md "Runs"): 移动端离线同步策略评审 — dual design, waiting at G2 with a recommendation,
// one disputed score cell and one disputed hard constraint. Times are relative to `now` (the G2 gate opened 25 minutes
// before the demo was loaded), so the gate wait and wall-clock numbers stay plausible on any day.
import type { HardConstraint, ProjectInput, RequirementSnapshot, Run } from '../../../src/lib/types';
import {
  candidate, commonFields, constraintResult, dualCell, EMPTY_DOCS, gate, judgment, proposal, question, started, task, timeline, totals, trail,
  type ProposalBody, type RunBundle,
} from './common';

export const SYNC_RUN_ID = 'r-20261120-a74d02';
const V1 = 'v1-2d8b6f0e41a9';
const V2 = 'v2-b51c93e7f028';

const project: ProjectInput = {
  title: '移动端离线同步策略评审',
  prompt: '团队的移动端待办与笔记 App 需要支持离线编辑：在地铁、电梯等弱网环境下可以新建和修改条目，恢复联网后自动同步到服务端；同一用户在多台设备上同时修改同一条目时，不能静默丢失内容。',
  coreFlows: ['离线新建与编辑条目', '联网后增量同步', '多设备并发修改的冲突处理'],
  existingStack: 'iOS 与 Android 原生客户端；服务端为 Node.js + PostgreSQL 的 REST 接口',
  deployment: '服务端已在云上运行；客户端通过应用商店发布',
  budget: '两名客户端开发与一名服务端开发，六周',
  acceptance: '断网 30 分钟内的修改恢复联网后全部同步；并发修改不丢内容',
  context: '',
};
const constraints: HardConstraint[] = [
  { id: 'H1', text: '离线期间的修改在恢复联网后不能丢失', kind: 'must' },
  { id: 'H2', text: '要求用户手动处理每一次字段级冲突', kind: 'must_not' },
];
const acceptance = [
  { id: 'AC1', description: '同步与合并逻辑的单元测试全部通过', kind: 'command' as const, command: 'npm test', expectExitCode: 0, outputIncludes: null },
  { id: 'AC2', description: '模拟两台设备断网 30 分钟后恢复，记录全部同步且无重复', kind: 'command' as const, command: 'npm run test:offline', expectExitCode: 0, outputIncludes: '0 lost' },
  { id: 'AC3', description: '在真机上完成一次离线编辑并恢复同步', kind: 'manual' as const, command: null, expectExitCode: null, outputIncludes: null },
];
const common = (title: string, summary: string, rest: Omit<ProposalBody, 'title' | 'summary' | 'fitWhen' | 'notFitWhen' | 'dataModel' | 'assumptions' | 'mvpPlan'> & { workstreams: { id: string; title: string; dependsOn: string[] }[]; effort: string; dataModel: string }): ProposalBody => ({
  title, summary, fitWhen: ['离线时长以小时计', '冲突主要发生在同一用户的多台设备之间'], notFitWhen: ['多人实时协同编辑同一段文字'],
  stack: rest.stack, modules: rest.modules, flows: rest.flows, dataModel: rest.dataModel, deployment: rest.deployment, tradeoffs: rest.tradeoffs, risks: rest.risks,
  assumptions: [{ text: '冲突自动合并并保留冲突副本，不打断用户', questionId: 'Q3' }], constraintChecks: rest.constraintChecks,
  mvpPlan: { goal: '验证断网期间的修改在恢复联网后完整同步，并发修改不丢内容', scopeIn: ['离线编辑队列', '增量同步端点', '冲突合并与冲突副本'], scopeOut: ['多人协同编辑', '附件同步', 'Web 端'], acceptance,
    hypotheses: [{ id: 'HY1', text: '单设备离线累积 500 条修改可在 10 秒内完成同步', howToVerify: '模拟 500 条离线修改后计时', passCriteria: '10 秒内完成且无丢失' }],
    workstreams: rest.workstreams, estimatedEffort: rest.effort },
});

export function buildSyncRun(now: number): RunBundle {
  const t = timeline(now - 96 * 60_000);
  const run = { id: SYNC_RUN_ID, models: commonFields().models };
  const snapshots: RequirementSnapshot[] = [
    { version: 1, ref: V1, hash: V1.slice(3), createdAt: t(0), reason: '用户输入', project, constraints, facts: [{ id: 'F1', text: 'iOS 与 Android 双端，约 3 万日活', source: 'user_input' }], assumptions: [], openItems: [] },
    { version: 2, ref: V2, hash: V2.slice(3), createdAt: t(41), reason: '合并 G1 回答', project, constraints,
      facts: [
        { id: 'F1', text: 'iOS 与 Android 双端，约 3 万日活', source: 'user_input' },
        { id: 'F2', text: '单设备离线修改通常不超过 500 条', source: 'answer:Q1' },
        { id: 'F3', text: '服务端为 REST 接口，可以新增同步端点', source: 'answer:Q2' },
        { id: 'F4', text: '冲突自动合并并保留冲突副本，不打断用户', source: 'answer:Q3' },
      ],
      assumptions: [{ id: 'A1', text: '设备端沿用系统级存储加密', source: 'default:Q4' }], openItems: [] },
  ];
  const tasks = [
    task(run, { id: 't-clarify-claude-a1', role: 'claude', phase: 'clarify', scope: 'clarify', createdAt: t(0.02), startedAt: t(0.05), endedAt: t(2.9), inputRef: V1 }),
    task(run, { id: 't-clarify-astra-a1', role: 'astra', phase: 'clarify', scope: 'clarify', createdAt: t(0.02), startedAt: t(0.05), endedAt: t(3.6), inputRef: V1 }),
    task(run, { id: 't-r1-propose-claude-a1', role: 'claude', phase: 'propose', scope: 'r1-propose', createdAt: t(41.05), startedAt: t(41.1), endedAt: t(52.3), inputRef: V2 }),
    task(run, { id: 't-r1-propose-astra-a1', role: 'astra', phase: 'propose', scope: 'r1-propose', createdAt: t(41.05), startedAt: t(41.1), endedAt: t(56.8), inputRef: V2 }),
    task(run, { id: 't-r1-review-claude-a1', role: 'claude', phase: 'review', scope: 'r1-review', createdAt: t(56.85), startedAt: t(56.9), endedAt: t(68.4), inputRef: V2 }),
    task(run, { id: 't-r1-review-astra-a1', role: 'astra', phase: 'review', scope: 'r1-review', createdAt: t(56.85), startedAt: t(56.9), endedAt: t(71.2), inputRef: V2 }),
  ];
  const byId = (id: string) => tasks.find(item => item.id === id)!;
  const questions = [
    question({ id: 'Q1', askedBy: 'claude', taskId: 't-clarify-claude-a1', createdAt: t(2.9), topic: 'data', priority: 'blocking', multiSelect: false,
      text: '离线期间单台设备大约会累积多少条修改？', whyItMatters: '决定离线队列是否需要压缩与分批上传',
      options: [{ id: 'lt500', label: '500 条以内', implication: '整队列一次上传即可' }, { id: 'lt5k', label: '5000 条以内', implication: '需要分批上传与断点续传' }],
      defaultOptionIds: ['lt500'], defaultAssumption: '单设备离线修改不超过 500 条', answer: { optionIds: ['lt500'], at: t(22.4) } }),
    question({ id: 'Q2', askedBy: 'claude', taskId: 't-clarify-claude-a1', createdAt: t(2.9), topic: 'integration', priority: 'important', multiSelect: false,
      text: '服务端能否新增专门的同步端点？', whyItMatters: '决定同步协议是复用现有 REST 资源还是新增增量端点',
      options: [{ id: 'new', label: '可以新增同步端点', implication: '协议可按增量设计' }, { id: 'reuse', label: '只能复用现有接口', implication: '客户端需要逐条重放请求' }],
      defaultOptionIds: ['new'], defaultAssumption: '可以新增同步端点', answer: { optionIds: ['new'], at: t(25.0) } }),
    question({ id: 'Q3', askedBy: 'astra', taskId: 't-clarify-astra-a1', createdAt: t(3.6), topic: 'ux', priority: 'blocking', multiSelect: false,
      text: '发生冲突时希望怎样提示用户？', whyItMatters: '决定合并策略是自动进行还是需要交互',
      options: [{ id: 'auto', label: '自动合并，保留冲突副本', implication: '用户不被打断，副本可事后查看' }, { id: 'ask', label: '每次让用户选择', implication: '实现简单，但频繁打断用户' }],
      defaultOptionIds: ['auto'], defaultAssumption: '冲突自动合并并保留冲突副本', answer: { optionIds: ['auto'], at: t(33.7) } }),
    question({ id: 'Q4', askedBy: 'astra', taskId: 't-clarify-astra-a1', createdAt: t(3.6), topic: 'security', priority: 'optional', multiSelect: false,
      text: '离线数据需要在设备上额外加密吗？', whyItMatters: '影响本地存储选型与性能',
      options: [{ id: 'system', label: '沿用系统级存储加密', implication: '无额外开发' }, { id: 'app', label: '应用层再加密一次', implication: '需要密钥管理' }],
      defaultOptionIds: ['system'], defaultAssumption: '设备端沿用系统级存储加密' }),
  ];
  const propC = proposal('claude', 2, common('操作日志增量同步 + 服务端字段级合并 + 冲突副本',
    '客户端把每次修改记为带设备时钟的操作日志，联网后批量上传到新的同步端点；服务端按字段做最后写入合并，同一字段的并发修改生成冲突副本供用户事后查看。', {
      stack: [{ layer: '客户端存储', choice: 'SQLite（操作日志表）', reason: '双端都有成熟实现' }, { layer: '同步协议', choice: 'REST 增量端点 + 游标', reason: '复用现有服务端技术栈' }, { layer: '合并', choice: '字段级最后写入 + 冲突副本', reason: '实现简单，结果可解释' }],
      modules: [
        { id: 'oplog', name: '离线操作日志', responsibility: '记录每次修改并去重', tech: 'SQLite' },
        { id: 'uploader', name: '同步上传器', responsibility: '联网后分批上传并重试', tech: null },
        { id: 'endpoint', name: '同步端点', responsibility: '幂等接收操作并返回游标', tech: 'Node.js' },
        { id: 'merge', name: '字段合并器', responsibility: '按字段合并并生成冲突副本', tech: null },
        { id: 'store', name: '条目库', responsibility: '保存条目与冲突副本', tech: 'PostgreSQL' },
      ],
      flows: [
        { from: 'oplog', to: 'uploader', label: '读取未同步操作', kind: 'data' }, { from: 'uploader', to: 'endpoint', label: '批量上传', kind: 'call' },
        { from: 'endpoint', to: 'merge', label: '按条目合并', kind: 'call' }, { from: 'merge', to: 'store', label: '写入条目与副本', kind: 'data' },
        { from: 'endpoint', to: 'uploader', label: '返回新游标', kind: 'event' },
      ],
      dataModel: 'ops(op_id, device_id, item_id, field, value, hlc)；items(id, owner_id, fields, version)；conflicts(item_id, field, losing_value, op_id)',
      deployment: '同步端点部署在现有服务端；客户端随下一个版本发布，旧版本继续使用原接口',
      tradeoffs: [{ gain: '协议简单，服务端合并结果可解释', cost: '同一字段的并发修改只能保留一方，另一方进入冲突副本' }],
      risks: [{ text: '设备时钟偏差导致合并顺序不符合直觉', severity: 'medium', mitigation: '使用混合逻辑时钟（HLC）' }],
      constraintChecks: [{ constraintId: 'H1', status: 'pass', note: '操作日志在确认前不删除' }, { constraintId: 'H2', status: 'pass', note: '冲突自动生成副本，不打断用户' }],
      workstreams: [{ id: 'W1', title: '客户端操作日志与上传', dependsOn: [] }, { id: 'W2', title: '服务端同步端点与合并', dependsOn: [] }], effort: '约 12 人日',
    }));
  const propA = proposal('astra', 2, common('CRDT 文档模型 + 二进制增量同步',
    '每个条目表示为 CRDT 文档，客户端离线时本地合并，联网后交换二进制增量；服务端只做存储与转发，冲突由数据结构自动收敛。', {
      stack: [{ layer: '数据模型', choice: 'CRDT 文档（开源库）', reason: '并发修改自动收敛' }, { layer: '同步协议', choice: '二进制增量 + 版本向量', reason: '传输量小' }, { layer: '服务端', choice: 'Node.js 转发 + 对象存储', reason: '服务端不解析内容' }],
      modules: [
        { id: 'doc', name: 'CRDT 文档层', responsibility: '本地修改与合并', tech: 'CRDT' },
        { id: 'sync', name: '增量交换', responsibility: '按版本向量交换增量', tech: null },
        { id: 'relay', name: '服务端转发', responsibility: '存储与转发增量', tech: 'Node.js' },
        { id: 'compact', name: '历史压缩', responsibility: '定期压缩文档历史', tech: null },
      ],
      flows: [
        { from: 'doc', to: 'sync', label: '生成增量', kind: 'data' }, { from: 'sync', to: 'relay', label: '上传增量', kind: 'call' },
        { from: 'relay', to: 'sync', label: '下发其他设备增量', kind: 'event' }, { from: 'compact', to: 'relay', label: '写回压缩快照', kind: 'data' },
      ],
      dataModel: 'docs(item_id, snapshot_blob, version_vector)；changes(item_id, device_id, seq, blob)',
      deployment: '服务端新增转发服务；客户端引入 CRDT 库，双端各自集成',
      tradeoffs: [{ gain: '并发修改自动收敛，文本字段也能合并', cost: '文档体积随历史增长，需要压缩策略' }],
      risks: [{ text: '历史压缩与离线设备的未同步增量交错时可能丢失操作', severity: 'high', mitigation: '压缩只作用于全部设备已确认的版本' }],
      constraintChecks: [{ constraintId: 'H1', status: 'pass', note: '增量在确认前保留' }, { constraintId: 'H2', status: 'pass', note: '自动收敛' }],
      workstreams: [{ id: 'W1', title: 'CRDT 文档层集成', dependsOn: [] }, { id: 'W2', title: '转发服务与压缩', dependsOn: ['W1'] }], effort: '约 18 人日',
    }));
  const C1 = candidate('C1', 'claude');
  const C2 = candidate('C2', 'astra');
  const why = (claude: string, astra: string) => ({ claude, astra });
  const cells = [
    dualCell('C1', 'fit', 5, 4, why('三个核心流程都有直接支撑', '冲突副本需要额外的查看入口')),
    dualCell('C1', 'cost', 4, 4, why('沿用现有技术栈', '新增一个端点与合并器')),
    dualCell('C1', 'reliability', 4, 2, why('操作日志确认前不删除，可自动化测试', '字段级最后写入会让一方的文本修改只留在冲突副本里')),
    dualCell('C1', 'performance', 4, 4, why('批量上传满足 500 条目标', '余量充足')),
    dualCell('C1', 'evolution', 4, 3, why('合并器可替换为更细粒度策略', '协议与合并逻辑耦合')),
    dualCell('C2', 'fit', 3, 4, why('文本字段合并超出本期需要', '并发修改自动收敛')),
    dualCell('C2', 'cost', 3, 3, why('双端都要引入并维护 CRDT 库', '学习成本较高')),
    dualCell('C2', 'reliability', 4, 3, why('收敛性有理论保证', '压缩策略未经验证')),
    dualCell('C2', 'performance', 3, 3, why('文档体积随历史增长', '需要定期压缩')),
    dualCell('C2', 'evolution', 4, 4, why('可扩展到多人协同', '数据模型通用')),
  ];
  const constraintResults = [
    constraintResult('C1', constraints[0]!, 'pass', 'pass', why('操作日志在确认前不删除', '满足')),
    constraintResult('C1', constraints[1]!, 'pass', 'pass', why('自动生成冲突副本', '满足')),
    constraintResult('C2', constraints[0]!, 'fail', 'pass', why('历史压缩时未说明离线端尚未同步的操作如何保留', '压缩只作用于全部设备已确认的版本')),
    constraintResult('C2', constraints[1]!, 'pass', 'pass', why('自动收敛', '自动收敛')),
  ];
  const totalC1 = totals('C1', 'claude', cells, constraintResults);
  const totalC2 = totals('C2', 'astra', cells, constraintResults);
  const dLo = Number((totalC1.lo - totalC2.hi).toFixed(3));
  const dHi = Number((totalC1.hi - totalC2.lo).toFixed(3));
  const full: Run = {
    ...commonFields(), id: SYNC_RUN_ID, title: project.title, createdAt: t(0), updatedAt: t(71.3),
    phase: 'framework_gate', phaseStatus: 'waiting_user', blockedReason: null, terminal: null, clarifyWith: 'both',
    designMode: 'auto', riskLevel: 'high', designResolution: { mode: 'dual', reasons: ['风险等级为 high'], architects: ['claude', 'astra'], reviewers: ['claude', 'astra'] },
    criteriaLockedAt: t(41.05), snapshots, currentSnapshotVersion: 2, designSnapshotVersion: 2, tasks, questions,
    modelNotes: [
      { taskId: 't-clarify-claude-a1', role: 'claude', phase: 'clarify', understanding: '你要让待办与笔记 App 在弱网下可离线编辑，联网后自动同步，并发修改不丢内容。', gaps: ['离线累积量未说明', '服务端能否新增端点未说明'], whyThisCount: null, rejectedAlternatives: [] },
      { taskId: 't-r1-propose-claude-a1', role: 'claude', phase: 'propose', understanding: null, gaps: [], whyThisCount: '冲突集中在同一用户的多台设备，字段级合并足够，给出一个方案。', rejectedAlternatives: [{ title: '整条目最后写入', reason: '会整条覆盖另一台设备的修改，违反 H1' }] },
      { taskId: 't-r1-propose-astra-a1', role: 'astra', phase: 'propose', understanding: null, gaps: [], whyThisCount: '从并发收敛的确定性出发给出一个 CRDT 方案。', rejectedAlternatives: [] },
    ],
    proposals: [propC, propA],
    judgments: [
      judgment('claude', 'r1-claude-1', 'B', { constraintChecks: [{ constraintId: 'H1', status: 'pass', rationale: '操作日志确认前不删除', evidence: [] }, { constraintId: 'H2', status: 'pass', rationale: '冲突副本自动生成', evidence: [] }], objections: [], strengths: ['协议简单可测试'] }),
      judgment('claude', 'r1-astra-1', 'A', { constraintChecks: [{ constraintId: 'H1', status: 'fail', rationale: '历史压缩时未说明离线端尚未同步的操作如何保留', evidence: [{ kind: 'reasoning', ref: 'H1', summary: 'H1 要求离线修改不能丢失' }] }, { constraintId: 'H2', status: 'pass', rationale: '自动收敛', evidence: [] }],
        objections: [{ id: 'O1', text: '压缩与长时间离线设备的增量交错时，未同步的操作可能被丢弃', severity: 'major', criterionId: 'reliability', verifiable: true, howToVerify: '一台设备离线 24 小时，期间另一台触发压缩，检查恢复后的内容', evidence: [{ kind: 'reasoning', ref: 'H1', summary: '压缩边界未定义' }] }], strengths: ['文本字段可合并'] }),
      judgment('astra', 'r1-claude-1', 'A', { constraintChecks: [{ constraintId: 'H1', status: 'pass', rationale: '满足，但一方修改只保留在冲突副本中', evidence: [] }, { constraintId: 'H2', status: 'pass', rationale: '不打断用户', evidence: [] }],
        objections: [{ id: 'O1', text: '同一文本字段的并发修改只保留一方，另一方需要用户从冲突副本中找回', severity: 'major', criterionId: 'reliability', verifiable: true, howToVerify: '两台设备离线修改同一条目的正文后恢复同步', evidence: [{ kind: 'reasoning', ref: null, summary: '字段级最后写入的固有限制' }] }], strengths: [] }),
      judgment('astra', 'r1-astra-1', 'B', { constraintChecks: [{ constraintId: 'H1', status: 'pass', rationale: '压缩只作用于已确认版本', evidence: [] }, { constraintId: 'H2', status: 'pass', rationale: '自动收敛', evidence: [] }], objections: [], strengths: [] }),
    ],
    equivalenceGroups: { claude: [], astra: [] },
    anonymization: { seed: 2683, maps: { claude: { A: 'r1-astra-1', B: 'r1-claude-1' }, astra: { A: 'r1-claude-1', B: 'r1-astra-1' } } },
    candidates: [C1, C2],
    decision: { outcome: 'recommend', basis: 'preference', winnerId: 'C1', conditional: false, contenders: ['C1', 'C2'], displayOrder: ['C1', 'C2'],
      totals: [totalC1, totalC2], cells, constraints: constraintResults,
      pairwise: [{ a: 'C1', b: 'C2', dLo, dHi, aRobustlyPreferred: false }, { a: 'C2', b: 'C1', dLo: -dHi, dHi: -dLo, aRobustlyPreferred: false }],
      keyUncertainties: [
        { id: 'U1', candidateId: 'C2', kind: 'constraint', criterionId: null, constraintId: 'H1', questionId: null, impact: Number.POSITIVE_INFINITY, isKey: true, description: 'C2 · H1：两位评审判定不一致（Claude 不满足 / Astra 满足）', judgeScores: {} },
        { id: 'U2', candidateId: 'C1', kind: 'cell', criterionId: 'reliability', constraintId: null, questionId: null, impact: 0.5, isKey: false, description: 'C1 · 可靠性与可验证性：两位评审分歧（Claude 4.00 / Astra 2.00），可能影响总分 0.50', judgeScores: { claude: 4, astra: 2 } },
      ],
      suggestedValidation: { candidateIds: ['C1'], reason: 'C1 为推荐方案；离线合并是关键假设，建议在 MVP 中验证。', hypotheses: ['断网 30 分钟内的修改在恢复联网后全部同步且无丢失'] },
      selfPreference: [{ judge: 'claude', ownMeanDelta: 0.6, otherMeanDelta: 0.2, index: 0.4, sampleSize: 10 }, { judge: 'astra', ownMeanDelta: 0.2, otherMeanDelta: -0.6, index: 0.4, sampleSize: 10 }],
      explanation: [
        `推荐 C1：C1（${totalC1.lo.toFixed(2)}–${totalC1.hi.toFixed(2)}）与 C2（${totalC2.lo.toFixed(2)}）的区间差距不足以稳定排序，按已确认的偏好采用 Claude 提出的整体框架。`,
        'C2 的硬约束 H1 两位评审判定不一致，在复核或你确认前 C2 仅为有条件候选。',
        'C1「可靠性与可验证性」存在分歧（4 / 2），不改变当前推荐，建议在 MVP 中验证并发修改的结果。',
      ],
      params: commonFields().decisionParams, judges: ['claude', 'astra'], degraded: false, computedAt: t(71.25) },
    docs: structuredClone(EMPTY_DOCS),
    gates: [
      gate('G1_answers', t(3.65), t(41), { action: 'submit' }, { questionCount: 4 }),
      gate('G2_framework', t(71.3), null, null, { outcome: 'recommend', computedAt: t(71.25), adjudicationTaskId: null }),
    ],
    jobBatch: 0, jobs: [], finalChoice: null,
  };
  const trails = {
    't-clarify-claude-a1': trail(byId('t-clarify-claude-a1'), [started('claude-opus-5-5', 'max'), [10, 'tool', '读取需求快照 v1'], [80, 'message', '复述需求：弱网离线编辑、联网自动同步、多设备并发不丢内容。'], [165, 'message', '提出 2 个澄清问题：离线累积量、能否新增同步端点。']]),
    't-clarify-astra-a1': trail(byId('t-clarify-astra-a1'), [started('gpt-6.2-astra', 'max'), [12, 'tool', '读取需求快照 v1'], [140, 'message', '冲突的交互方式决定合并策略，需要先确认。'], [208, 'message', '提出 2 个澄清问题：冲突提示方式、本地加密。']]),
    't-r1-propose-claude-a1': trail(byId('t-r1-propose-claude-a1'), [started('claude-opus-5-5', 'max'), [20, 'tool', '读取需求快照 v2（合并了 3 条回答与 1 条默认）'], [330, 'info', '估计已生成 7400 tokens'], [520, 'message', '选择操作日志 + 字段级合并：冲突集中在同一用户的多台设备。'], [660, 'message', '提交 1 个方案；放弃整条目最后写入（违反 H1）。']]),
    't-r1-propose-astra-a1': trail(byId('t-r1-propose-astra-a1'), [started('gpt-6.2-astra', 'max'), [20, 'tool', '读取需求快照 v2'], [420, 'message', '选择 CRDT 文档模型：并发修改自动收敛，文本字段也能合并。'], [930, 'message', '提交 1 个方案；历史压缩策略列为高风险。']]),
    't-r1-review-claude-a1': trail(byId('t-r1-review-claude-a1'), [started('claude-opus-5-5', 'max'), [15, 'tool', '读取匿名方案 A、B 与评分锚点'], [300, 'message', '方案 A 的 H1 判定不满足：压缩边界未定义。'], [640, 'message', '完成评审：方案 B 全部硬约束满足。']]),
    't-r1-review-astra-a1': trail(byId('t-r1-review-astra-a1'), [started('gpt-6.2-astra', 'max'), [15, 'tool', '读取匿名方案 A、B 与评分锚点'], [480, 'message', '方案 A「可靠性」给 2 分：同一文本字段只保留一方。'], [840, 'message', '完成评审：两个方案的 H2 均满足。']]),
  };
  return { run: full, trails, docs: {}, files: {} };
}
