import type { DesignRole, DocKind, Effort, ModelRole, Question } from './types.js';

export type DesignMode = 'auto' | 'dual' | 'single';
export type RiskLevel = 'low' | 'medium' | 'high';

export interface ArchitectOverride {
  from: 'claude';
  to: 'astra';
  reason: string;
  /** 覆盖产生的是非主导者方案，不改变 preferredOrigin。 */
  proposalIsNonLeading: true;
}

export interface DesignResolution {
  mode: 'single' | 'dual';
  reasons: string[];
  architects: DesignRole[];
  reviewers: DesignRole[];
  architectOverride?: ArchitectOverride;
}

export interface ResolveDesignModeInput {
  mode: DesignMode;
  riskLevel: RiskLevel;
  constraints: readonly unknown[];
  questions: readonly Question[];
  /** 只能由用户显式选择 Claude -> Astra；不得由任务失败自动构造。 */
  architectOverride?: { from: 'claude'; to: 'astra'; reason: string };
}

const DUAL_ARCHITECTS: DesignRole[] = ['claude', 'astra'];
const DUAL_REVIEWERS: DesignRole[] = ['claude', 'astra'];

function unresolvedBlockingCount(questions: readonly Question[]): number {
  return questions.filter((question) => question.priority === 'blocking'
    && question.status !== 'answered').length;
}

/**
 * 解析创建时冻结的设计任务集合。调用者在 G1 提交、或跳过澄清后提案前调用同一函数；
 * 函数不接受失败状态，因此不会把 Claude 故障偷偷转换为 Astra 接管。
 */
export function resolveDesignMode(input: ResolveDesignModeInput): DesignResolution {
  const automaticReasons: string[] = [];
  if (input.constraints.length >= 4) automaticReasons.push(`硬约束 ${input.constraints.length} 条（达到 4 条）`);
  if (input.riskLevel === 'high') automaticReasons.push('风险等级为 high');
  const blocking = unresolvedBlockingCount(input.questions);
  if (blocking >= 3) automaticReasons.push(`阻塞级未答问题 ${blocking} 条（达到 3 条）`);

  const mode = input.mode === 'auto' ? (automaticReasons.length ? 'dual' : 'single') : input.mode;
  const reasons = input.mode === 'auto'
    ? automaticReasons.length ? automaticReasons : ['未触发 dual 规则']
    : [`用户显式选择 ${input.mode}`];

  if (mode === 'dual') {
    if (input.architectOverride) throw new Error('dual 模式不接受单架构师覆盖');
    return { mode, reasons, architects: [...DUAL_ARCHITECTS], reviewers: [...DUAL_REVIEWERS] };
  }

  if (!input.architectOverride) {
    return { mode, reasons, architects: ['claude'], reviewers: ['astra'] };
  }

  const reason = input.architectOverride.reason.trim();
  if (!reason) throw new Error('架构师覆盖必须填写原因');
  const architectOverride: ArchitectOverride = {
    from: 'claude',
    to: 'astra',
    reason,
    proposalIsNonLeading: true,
  };
  return {
    mode,
    reasons: [...reasons, '用户显式将本轮架构师由 Claude 覆盖为 Astra；该方案标记为非主导者方案'],
    architects: ['astra'],
    reviewers: ['claude'],
    architectOverride,
  };
}

export interface RankedQuestions {
  visible: Question[];
  collapsed: Question[];
  all: Question[];
}

const PRIORITY_RANK: Record<Question['priority'], number> = { blocking: 0, important: 1, optional: 2 };
const STATUS_RANK: Record<Question['status'], number> = { open: 0, unsure: 1, skipped: 2, answered: 3 };

function questionNumber(id: string): number {
  const match = /^Q(\d+)$/.exec(id);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

/** 只改变展示顺序与折叠边界；题目、答案和选项对象保持原样。 */
export function rankQuestions(questions: readonly Question[], visibleLimit = 12): RankedQuestions {
  if (!Number.isInteger(visibleLimit) || visibleLimit < 0) throw new Error('visibleLimit 必须是非负整数');
  const ranked = questions
    .map((question, index) => ({ question, index }))
    .sort((a, b) => PRIORITY_RANK[a.question.priority] - PRIORITY_RANK[b.question.priority]
      || STATUS_RANK[a.question.status] - STATUS_RANK[b.question.status]
      || questionNumber(a.question.id) - questionNumber(b.question.id)
      || a.index - b.index)
    .map(({ question }) => question);
  return {
    visible: ranked.slice(0, visibleLimit),
    collapsed: ranked.slice(visibleLimit),
    all: ranked,
  };
}

export interface FrozenDocWriter {
  role: DocWriterRole;
  model: string;
  effort: Effort;
}

export type DocWriters = Record<DocKind, FrozenDocWriter>;
export type DocWriterRole = 'claude' | 'astra' | 'sol';
export type DocWriterInput = Partial<Record<DocKind, { role: DocWriterRole; effort: Effort; model?: string }>>;
export type ModelCatalog = Record<DocWriterRole, { model: string }>;

/** 新运行可显式采用的建议值。旧运行迁移不得调用此 helper 覆盖历史。 */
export function defaultDocWriters(models: ModelCatalog): DocWriters {
  return {
    handbook: { role: 'claude', model: models.claude.model, effort: 'xhigh' },
    devdoc: { role: 'astra', model: models.astra.model, effort: 'max' },
    prd: { role: 'claude', model: models.claude.model, effort: 'xhigh' },
  };
}

/** 缺少逐文档字段时严格沿用旧 docWriter 的角色、型号和强度。 */
export function resolveDocWriters(models: ModelCatalog, legacyDocWriter: FrozenDocWriter, input?: DocWriterInput): DocWriters {
  const resolve = (kind: DocKind): FrozenDocWriter => {
    const selected = input?.[kind];
    if (!selected) return { ...legacyDocWriter };
    return { role: selected.role, model: selected.model ?? models[selected.role].model, effort: selected.effort };
  };
  return { handbook: resolve('handbook'), devdoc: resolve('devdoc'), prd: resolve('prd') };
}

export interface ConditionalCallAddition {
  key: 'recheck' | 'adjudication' | 'document_revision' | 'retry' | 'structural_repair' | 'rework';
  description: string;
  role: ModelRole | 'configured';
  callsPerOccurrence: number;
}

export interface CallEstimateOptions {
  clarifyWith: 'both' | 'claude' | 'astra' | 'skip';
  design: Pick<DesignResolution, 'architects' | 'reviewers'>;
  writeDocs: boolean;
  writePrd: boolean;
  docWriters: DocWriters;
  jobs: number;
  builderRole?: ModelRole;
  evaluator?: { enabled: boolean; role: ModelRole };
  finalReview?: { enabled: boolean; role: ModelRole };
  /** 每个作业冻结的 maxModelCalls；只表示构建作业内上限。 */
  maxModelCallsPerJob?: number | null;
  contextEnabled?: boolean;
}

export interface CallEstimate {
  baseByRole: Record<CallRole, number>;
  baseTotal: number;
  conditionalAdditions: ConditionalCallAddition[];
  jobBudgetUpperBound: { perJob: number | null; allJobs: number | null };
}

export type CallRole = 'claude' | 'astra' | 'sol' | 'grok';

function assertCount(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} 必须是非负整数`);
}

/** 按实际任务集合逐项计数，不假设固定调用次数。 */
export function estimateCalls(options: CallEstimateOptions): CallEstimate {
  assertCount(options.jobs, 'jobs');
  if (options.maxModelCallsPerJob !== undefined && options.maxModelCallsPerJob !== null) {
    assertCount(options.maxModelCallsPerJob, 'maxModelCallsPerJob');
  }
  const baseByRole: Record<CallRole, number> = { claude: 0, astra: 0, sol: 0, grok: 0 };
  const add = (role: ModelRole, count = 1): void => { baseByRole[role] += count; };

  if (options.clarifyWith === 'both') {
    add('claude');
    add('astra');
  } else if (options.clarifyWith !== 'skip') {
    add(options.clarifyWith);
  }
  for (const role of options.design.architects) add(role);
  for (const role of options.design.reviewers) add(role);

  if (options.writeDocs) {
    add(options.docWriters.handbook.role);
    add(options.docWriters.devdoc.role);
  }
  if (options.writePrd) add(options.docWriters.prd.role);

  const builderRole = options.builderRole ?? 'sol';
  add(builderRole, options.jobs * (options.contextEnabled ? 2 : 1));
  if (options.evaluator?.enabled) add(options.evaluator.role, options.jobs);
  if (options.finalReview?.enabled) add(options.finalReview.role, options.jobs);

  const perJob = options.maxModelCallsPerJob ?? null;
  return {
    baseByRole,
    baseTotal: baseByRole.claude + baseByRole.astra + baseByRole.sol + baseByRole.grok,
    conditionalAdditions: [
      { key: 'recheck', description: '选择分歧复核时，按实际参与的设计评审角色增加', role: 'configured', callsPerOccurrence: 1 },
      { key: 'adjudication', description: '复核后满足升级条件时增加一次 Astra 裁决', role: 'astra', callsPerOccurrence: 1 },
      { key: 'document_revision', description: '每份被要求修订的文档由其冻结撰写者增加一次', role: 'configured', callsPerOccurrence: 1 },
      { key: 'retry', description: '任务失败后的显式重试按实际任务角色增加', role: 'configured', callsPerOccurrence: 1 },
      { key: 'structural_repair', description: '结构修复最多一次，按原任务角色增加并计入作业预算', role: 'configured', callsPerOccurrence: 1 },
      { key: 'rework', description: '每个返工轮次包含写者，并按配置可能增加评审与终审', role: 'configured', callsPerOccurrence: 1 },
    ],
    jobBudgetUpperBound: { perJob, allJobs: perJob === null ? null : perJob * options.jobs },
  };
}
