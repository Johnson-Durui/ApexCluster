/**
 * 模型输入/输出与 API 输入的结构定义（zod v4）。
 *
 * 规则（重要）：
 * 1. “模型输出”类 schema 会被转换成严格 JSON Schema 交给 CLI（Claude Code --json-schema /
 *    Codex --output-schema）。OpenAI 严格结构化输出要求：所有字段 required、
 *    additionalProperties=false、不能有可选字段。所以这里一律用 .nullable()，不用 .optional()；
 *    也不在 schema 里写 min/max/length 约束（放到 validate.ts 的语义校验里）。
 * 2. 领域对象（Run、Task 等持久化结构）在 types.ts 里用 TypeScript 接口定义，不在这里。
 */
import { z } from 'zod/v4';
import { REFERENCE_LIMITS } from './reference-documents.js';
import { DigestOutputZ, QgroupOutputZ } from './chores.js';

// ---------- 通用枚举 ----------
export const DesignRoleZ = z.enum(['claude', 'astra']);
export const ModelRoleZ = z.enum(['claude', 'astra', 'sol', 'grok']);
export const EffortZ = z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

export const QuestionTopicZ = z.enum([
  'goal_scope', // 目标与范围
  'users_scale', // 用户与规模
  'core_flow', // 核心流程
  'data', // 数据与存储
  'integration', // 外部集成
  'deployment', // 部署与运行环境
  'security', // 安全与权限
  'performance', // 性能
  'budget_timeline', // 预算与时间
  'team_skills', // 团队与技能
  'ux', // 交互体验
  'other',
]);

export const EvidenceKindZ = z.enum(['doc', 'user_input', 'reasoning', 'experience', 'prototype']);

export const EvidenceOutZ = z.object({
  kind: EvidenceKindZ,
  /** URL、需求快照条目编号（F1/A2/H1/Q3）或原型作业编号；没有就 null */
  ref: z.string().nullable(),
  summary: z.string(),
});

// ---------- 问题（所有阶段的模型都可以提） ----------
export const QuestionOptionOutZ = z.object({
  id: z.string(),
  label: z.string(),
  /** 选这个选项对架构意味着什么 */
  implication: z.string(),
});

export const QuestionOutZ = z.object({
  localId: z.string(),
  topic: QuestionTopicZ,
  priority: z.enum(['blocking', 'important', 'optional']),
  text: z.string(),
  whyItMatters: z.string(),
  multiSelect: z.boolean(),
  options: z.array(QuestionOptionOutZ),
  /** 用户不回答时模型采用的选项（多选题可多个） */
  defaultOptionIds: z.array(z.string()),
  /** 用户不回答时模型采用的假设（文字） */
  defaultAssumption: z.string(),
});

// ---------- 阶段 1：澄清 ----------
export const ClarifyOutputZ = z.object({
  snapshotRef: z.string(),
  /** 模型对需求的复述（帮助用户发现误读） */
  understanding: z.string(),
  gaps: z.array(z.string()),
  questions: z.array(QuestionOutZ),
});

// ---------- 阶段 2：独立提案 ----------
export const StackItemOutZ = z.object({ layer: z.string(), choice: z.string(), reason: z.string() });
export const ModuleOutZ = z.object({
  id: z.string(),
  name: z.string(),
  responsibility: z.string(),
  tech: z.string().nullable(),
});
export const FlowOutZ = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string(),
  kind: z.enum(['call', 'data', 'event']),
});
export const RiskOutZ = z.object({
  text: z.string(),
  severity: z.enum(['high', 'medium', 'low']),
  mitigation: z.string().nullable(),
});
export const AssumptionOutZ = z.object({
  text: z.string(),
  /** 若此假设对应某个问题的默认答案，填问题编号（如 Q3），否则 null */
  questionId: z.string().nullable(),
});
export const ConstraintSelfCheckOutZ = z.object({
  constraintId: z.string(),
  status: z.enum(['pass', 'fail', 'unknown']),
  note: z.string(),
});
export const AcceptanceOutZ = z.object({
  id: z.string(),
  description: z.string(),
  kind: z.enum(['command', 'manual']),
  /** kind=command 时必填：在 Windows PowerShell 下可运行的命令，例如 "npm test" */
  command: z.string().nullable(),
  expectExitCode: z.number().nullable(),
  outputIncludes: z.string().nullable(),
});
export const HypothesisOutZ = z.object({
  id: z.string(),
  text: z.string(),
  howToVerify: z.string(),
  passCriteria: z.string(),
});
export const WorkstreamOutZ = z.object({
  id: z.string(),
  title: z.string(),
  dependsOn: z.array(z.string()),
});
export const MvpPlanOutZ = z.object({
  goal: z.string(),
  scopeIn: z.array(z.string()),
  scopeOut: z.array(z.string()),
  acceptance: z.array(AcceptanceOutZ),
  hypotheses: z.array(HypothesisOutZ),
  workstreams: z.array(WorkstreamOutZ),
  estimatedEffort: z.string(),
});
export const ProposalOutZ = z.object({
  localId: z.string(),
  title: z.string(),
  summary: z.string(),
  fitWhen: z.array(z.string()),
  notFitWhen: z.array(z.string()),
  stack: z.array(StackItemOutZ),
  modules: z.array(ModuleOutZ),
  flows: z.array(FlowOutZ),
  dataModel: z.string(),
  deployment: z.string(),
  tradeoffs: z.array(z.object({ gain: z.string(), cost: z.string() })),
  risks: z.array(RiskOutZ),
  assumptions: z.array(AssumptionOutZ),
  constraintChecks: z.array(ConstraintSelfCheckOutZ),
  mvpPlan: MvpPlanOutZ,
});
export const ProposeOutputZ = z.object({
  snapshotRef: z.string(),
  proposals: z.array(ProposalOutZ),
  /** 为什么是这个数量（1 个也完全可以） */
  whyThisCount: z.string(),
  rejectedAlternatives: z.array(z.object({ title: z.string(), reason: z.string() })),
  questions: z.array(QuestionOutZ),
});

// ---------- 阶段 3：交叉评审 + 评分（匿名候选） ----------
export const ScoreOutZ = z.object({
  criterionId: z.string(),
  /** 0–5 的整数；没有依据时必须为 null，不允许“给个中间分” */
  score: z.number().nullable(),
  rationale: z.string(),
  evidence: z.array(EvidenceOutZ),
});
export const ObjectionOutZ = z.object({
  id: z.string(),
  text: z.string(),
  severity: z.enum(['critical', 'major', 'minor']),
  criterionId: z.string().nullable(),
  verifiable: z.boolean(),
  howToVerify: z.string().nullable(),
  evidence: z.array(EvidenceOutZ),
});
export const ConstraintCheckOutZ = z.object({
  constraintId: z.string(),
  status: z.enum(['pass', 'fail', 'unknown']),
  rationale: z.string(),
  evidence: z.array(EvidenceOutZ),
});
export const CandidateReviewOutZ = z.object({
  candidateId: z.string(),
  constraintChecks: z.array(ConstraintCheckOutZ),
  scores: z.array(ScoreOutZ),
  objections: z.array(ObjectionOutZ),
  strengths: z.array(z.string()),
});
export const ReviewOutputZ = z.object({
  snapshotRef: z.string(),
  /** 实质相同的候选分组（只列 ≥2 个成员的组），用匿名编号 */
  equivalentGroups: z.array(z.array(z.string())),
  reviews: z.array(CandidateReviewOutZ),
  questions: z.array(QuestionOutZ),
});

// ---------- 可选阶段：分歧复核 ----------
export const RecheckItemOutZ = z.object({
  itemId: z.string(),
  /** 评分项：修订后的分数（0–5 整数或 null）；约束项为 null */
  revisedScore: z.number().nullable(),
  /** 约束项：修订后的判定；评分项为 null */
  revisedStatus: z.enum(['pass', 'fail', 'unknown']).nullable(),
  changed: z.boolean(),
  rationale: z.string(),
  evidence: z.array(EvidenceOutZ),
});
export const RecheckOutputZ = z.object({
  snapshotRef: z.string(),
  items: z.array(RecheckItemOutZ),
  questions: z.array(QuestionOutZ),
});

// ---------- D8：Astra Ultra 裁决建议（不覆盖评审或替代 G2） ----------
export const AdjudicationOutputZ = z.object({
  snapshotRef: z.string(),
  recommendation: z.object({ candidateId: z.string().nullable(), rationale: z.string() }),
  items: z.array(z.object({
    itemId: z.string(),
    verdict: z.enum(['resolved', 'unresolved']),
    rationale: z.string(),
    evidence: z.array(EvidenceOutZ),
    verification: z.string().nullable(),
  })),
  risks: z.array(z.string()),
  questions: z.array(QuestionOutZ),
});

// ---------- 阶段 4：Sol 构建最小 MVP ----------
export const AcceptanceResultOutZ = z.object({
  criterionId: z.string(),
  status: z.enum(['pass', 'fail', 'not_run']),
  evidence: z.string(),
});
export const HypothesisResultOutZ = z.object({
  hypothesisId: z.string(),
  status: z.enum(['supported', 'refuted', 'inconclusive']),
  evidence: z.string(),
});
export const FailureClassZ = z.enum([
  'none',
  'implementation_defect', // 实现缺陷
  'environment_issue', // 环境问题
  'experiment_design', // 试验设计不足
  'architecture_mismatch', // 架构不满足要求
]);
export const BuildReportOutputZ = z.object({
  specRef: z.string(),
  summary: z.string(),
  builtComponents: z.array(z.string()),
  howToRun: z.object({
    setup: z.array(z.string()),
    run: z.array(z.string()),
    test: z.array(z.string()),
  }),
  acceptanceResults: z.array(AcceptanceResultOutZ),
  hypothesisResults: z.array(HypothesisResultOutZ),
  failureClass: FailureClassZ,
  failureDetail: z.string().nullable(),
  /** 与已确认框架的任何偏离（换库、换结构等）都必须列出 */
  deviations: z.array(z.string()),
  openIssues: z.array(z.string()),
  questions: z.array(QuestionOutZ),
});

export const SessionBuildReportOutputZ = BuildReportOutputZ.extend({
  milestoneResults: z.array(z.object({ milestoneId: z.string(), status: z.enum(['done', 'incomplete']), note: z.string() })),
  handoffNotes: z.array(z.string()),
});

// ---------- 文档：架构说明手册与开发文档（MVP 前，G3）；PRD（MVP 后，G5） ----------
// 撰写者默认是 Claude Opus 5.5（xhigh，可配置）。叙述由模型写，事实型内容由程序生成。
/** 带来源的段落：sources 只能引用材料中给出的编号（F1/A2/O1/H1/Q3/C1/U1/spec-…/R-01…） */
export const ParaZ = z.object({ text: z.string(), sources: z.array(z.string()) });
export const PendingItemZ = z.object({
  item: z.string(),
  relatedIds: z.array(z.string()),
  impact: z.string(),
  /** 负责人：你 / 老板 / 用户方 / 待指定 */
  owner: z.string(),
  /** 期限：日期或“待定” */
  due: z.string(),
});
const NaZ = { applicable: z.boolean(), reason: z.string().nullable() };

/** PRD：结构与编号规则沿用 docs/templates/prd-template.pdf（8 章） */
export const PrdOutputZ = z.object({
  docRef: z.string(),
  module: z.string(),
  plannedVersion: z.string(),
  background: z.object({ evidence: ParaZ, startReason: ParaZ, goals: ParaZ, constraints: ParaZ, nonGoals: ParaZ }),
  users: z.object({ primary: z.string(), secondary: z.string(), frequency: z.string(), uncovered: z.string() }),
  roles: z.array(z.object({ role: z.string(), scenario: z.string(), problem: z.string(), outcome: z.string(), sources: z.array(z.string()) })),
  userStories: z.array(ParaZ),
  requirements: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      sources: z.array(z.string()),
      priority: z.enum(['必需', '重要', '可延后', '待验证']),
      decision: z.enum(['纳入', '延后', '待验证']),
      reason: z.string(),
      featureIds: z.array(z.string()),
    }),
  ),
  boundary: z.object({
    mustDeliver: ParaZ,
    notDoing: ParaZ,
    dependencies: z.array(z.object({ item: z.string(), provider: z.string(), readiness: z.string(), fallback: z.string() })),
  }),
  flows: z.array(
    z.object({ name: z.string(), requirementIds: z.array(z.string()), entry: z.string(), precondition: z.string(), successFlag: z.string(), path: z.string(), exceptions: z.string() }),
  ),
  states: z.object({ ...NaZ, rows: z.array(z.object({ current: z.string(), trigger: z.string(), precondition: z.string(), next: z.string(), forbidden: z.string() })), consistency: z.string() }),
  permissions: z.object({ ...NaZ, rows: z.array(z.object({ role: z.string(), visibleData: z.string(), allowed: z.string(), forbidden: z.string() })) }),
  features: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      requirementIds: z.array(z.string()),
      priority: z.string(),
      entry: z.string(),
      scenario: z.string(),
      pageStructure: z.string(),
      fields: z.array(z.object({ name: z.string(), format: z.string(), defaultValue: z.string(), validation: z.string(), errorMessage: z.string() })),
      rules: z.string(),
      actions: z.string(),
      success: z.string(),
      emptyAndFailure: z.string(),
      duplicateHandling: z.string(),
      acceptanceIds: z.array(z.string()),
    }),
  ),
  data: z.object({ objects: z.array(z.object({ object: z.string(), source: z.string(), uniqueness: z.string(), access: z.string() })), lifecycle: z.string(), privacy: z.string() }),
  quality: z.array(z.object({ kind: z.string(), condition: z.string(), threshold: z.string(), method: z.string() })),
  dependencyFailure: z.object({ external: z.string(), monitoring: z.string() }),
  acceptance: z.array(
    z.object({
      id: z.string(),
      featureId: z.string(),
      requirementId: z.string(),
      type: z.enum(['正常', '异常', '边界', '权限', '重复']),
      given: z.string(),
      when: z.string(),
      then: z.string(),
      inMvp: z.boolean(),
    }),
  ),
  /** 每一条 MVP 规格验收项（实现层面的检查）都要挂到一条 PRD 验收标准（产品层面的行为）上 */
  mvpAcceptanceMap: z.array(z.object({ specRef: z.string(), specAcceptanceId: z.string(), acId: z.string() })),
  metrics: z.array(z.object({ id: z.string(), name: z.string(), requirementIds: z.array(z.string()), formula: z.string(), baselineAndTarget: z.string(), periodAndSource: z.string() })),
  events: z.array(z.object({ name: z.string(), trigger: z.string(), fields: z.string(), verification: z.string() })),
  release: z.object({ ...NaZ, scope: z.string(), preconditions: z.string(), rollback: z.string() }),
  ai: z.object({ ...NaZ, boundary: z.string(), io: z.string(), toolsAndFallback: z.string(), evaluation: z.string() }),
  pending: z.array(PendingItemZ),
});

/** 架构手册：给用户方、老板等阅读；程序负责图、表、决策记录，撰写者负责通俗说明 */
export const HandbookOutputZ = z.object({
  docRef: z.string(),
  summary: z.object({ problem: ParaZ, solution: ParaZ, whyThis: ParaZ, costAndTimeline: ParaZ, risks: ParaZ, decisionsNeeded: ParaZ }),
  candidates: z.array(
    z.object({
      candidateId: z.string(),
      overview: ParaZ,
      modules: z.array(z.object({ moduleId: z.string(), plainExplanation: z.string() })),
      keyFlows: z.array(z.object({ name: z.string(), steps: z.array(z.string()), sources: z.array(z.string()) })),
      dataAndSecurity: ParaZ,
      operations: ParaZ,
      quality: ParaZ,
    }),
  ),
  glossary: z.array(z.object({ term: z.string(), explanation: z.string() })),
  pending: z.array(PendingItemZ),
});

/**
 * 开发文档：给 AI 开发者（构建 MVP 的 Sol，以及之后接手的 AI）阅读。
 * 在已确认的框架内细化：接口、目录、数据、实施步骤、每个验收项怎么验证。不得改变框架。
 */
export const DevDocOutputZ = z.object({
  docRef: z.string(),
  candidates: z.array(
    z.object({
      candidateId: z.string(),
      /** 这个 MVP 要证明什么（一两句） */
      purpose: z.string(),
      /** 不要做的事（至少覆盖 MVP 规格的“范围外”） */
      nonGoals: z.array(z.string()),
      modules: z.array(
        z.object({
          moduleId: z.string(),
          responsibility: z.string(),
          /** 对外接口：函数签名、HTTP 端点或事件，写清输入、输出和错误 */
          interfaces: z.string(),
          dependsOn: z.array(z.string()),
          /** 实现要点与禁止事项 */
          notes: z.string(),
        }),
      ),
      /** 目录与关键文件（相对工作区的路径） */
      layout: z.array(z.object({ path: z.string(), purpose: z.string() })),
      dataModel: z.array(z.object({ entity: z.string(), fields: z.string(), rules: z.string() })),
      flows: z.array(z.object({ name: z.string(), steps: z.array(z.string()) })),
      /** 编码约定、错误处理、日志、配置、Windows 注意事项 */
      conventions: z.array(z.string()),
      /** 实施步骤：S1、S2…；workstreamId 对应 MVP 计划里的工作流（没有就 null） */
      plan: z.array(z.object({ id: z.string(), step: z.string(), workstreamId: z.string().nullable(), dependsOn: z.array(z.string()), done: z.string() })),
      /** 每个 MVP 验收项怎么验证；命令型必须原样写出规格里的命令 */
      testPlan: z.array(z.object({ acceptanceId: z.string(), approach: z.string(), command: z.string().nullable() })),
      hypothesisChecks: z.array(z.object({ hypothesisId: z.string(), method: z.string() })),
      commands: z.object({ setup: z.array(z.string()), run: z.array(z.string()), test: z.array(z.string()) }),
      pitfalls: z.array(z.object({ risk: z.string(), avoid: z.string() })),
      /** 未定的问题与默认处理；relatedIds 只能引用材料中的编号 */
      openQuestions: z.array(z.object({ question: z.string(), defaultDecision: z.string(), relatedIds: z.array(z.string()) })),
    }),
  ),
});

// ---------- 探测（真实调用的最小请求） ----------
export const ProbeOutputZ = z.object({ ok: z.boolean(), note: z.string() });

// 程序核验与独立评审保持分开；模型不能覆盖日志结论。
export const EvaluationOutputZ = z.object({
  specRef: z.string(), round: z.number(), workspaceCommit: z.string().nullable(),
  verdict: z.enum(['pass', 'fail', 'cannot_verify']),
  acceptance: z.array(z.object({ criterionId: z.string(), status: z.enum(['pass', 'fail', 'cannot_verify', 'awaiting_manual']), evidence: z.string() })),
  defects: z.array(z.object({
    id: z.string(), criterionIds: z.array(z.string()), severity: z.enum(['minor', 'major', 'critical']),
    failureClass: FailureClassZ, location: z.string(), evidence: z.string(),
    reproduction: z.object({ command: z.string(), logSeq: z.number().nullable(),
      expectedExitCode: z.number().describe('原样填写对应规格验收项的期望退出码，不是本次实际退出码'),
      outputIncludes: z.string().nullable().describe('原样填写对应规格验收项的期望输出片段或 null，不是失败日志片段') }),
    fix: z.string(),
  })),
  reworkBrief: z.array(z.object({ defectIds: z.array(z.string()), instructions: z.string() })),
  environmentIssues: z.array(z.string()), deviationsNoted: z.array(z.string()), questions: z.array(QuestionOutZ),
});
export const FinalReviewOutputZ = z.object({
  specRef: z.string(), workspaceCommit: z.string().nullable(), roundsReviewed: z.array(z.number()),
  verdict: z.enum(['accept', 'accept_with_notes', 'reject']), summary: z.string(),
  findings: z.array(z.object({ round: z.number(), defectIds: z.array(z.string()), severity: z.enum(['minor', 'major', 'critical']), text: z.string() })),
  frameworkCompliance: z.enum(['compliant', 'deviations', 'cannot_verify']),
  reworkNotes: z.array(z.string()), questions: z.array(QuestionOutZ),
});

export const BuildLimitsZ = z.object({
  maxRounds: z.number().int().min(1).max(4), maxWriterSessions: z.number().int().min(1).max(100),
  maxModelCalls: z.number().int().min(1).max(200), maxActiveMinutes: z.number().int().min(1).max(1440),
}).strict();
export const BuildOptionsZ = BuildLimitsZ.extend({ autoRework: z.boolean(), resumePolicy: z.enum(['never', 'budgeted']), lightReworkEnabled: z.boolean().optional(), lightReworkMinutes: z.number().int().min(1).max(15).optional() }).strict();
export const ReviewInputZ = z.object({ enabled: z.boolean().optional(), effort: EffortZ.optional(), timeoutMinutes: z.number().int().min(1).max(120).optional() }).strict();

export type QuestionOut = z.infer<typeof QuestionOutZ>;
export type ClarifyOutput = z.infer<typeof ClarifyOutputZ>;
export type ProposalOut = z.infer<typeof ProposalOutZ>;
export type ProposeOutput = z.infer<typeof ProposeOutputZ>;
export type ScoreOut = z.infer<typeof ScoreOutZ>;
export type ObjectionOut = z.infer<typeof ObjectionOutZ>;
export type ConstraintCheckOut = z.infer<typeof ConstraintCheckOutZ>;
export type CandidateReviewOut = z.infer<typeof CandidateReviewOutZ>;
export type ReviewOutput = z.infer<typeof ReviewOutputZ>;
export type RecheckItemOut = z.infer<typeof RecheckItemOutZ>;
export type RecheckOutput = z.infer<typeof RecheckOutputZ>;
export type AdjudicationOutput = z.infer<typeof AdjudicationOutputZ>;
export type BuildReportOutput = z.infer<typeof BuildReportOutputZ>;
export type EvaluationOutput = z.infer<typeof EvaluationOutputZ>;
export type FinalReviewOutput = z.infer<typeof FinalReviewOutputZ>;
export type AcceptanceOut = z.infer<typeof AcceptanceOutZ>;
export type HypothesisOut = z.infer<typeof HypothesisOutZ>;
export type MvpPlanOut = z.infer<typeof MvpPlanOutZ>;
export type EvidenceOut = z.infer<typeof EvidenceOutZ>;
export type FailureClass = z.infer<typeof FailureClassZ>;
export type Para = z.infer<typeof ParaZ>;
export type PendingItem = z.infer<typeof PendingItemZ>;
export type PrdOutput = z.infer<typeof PrdOutputZ>;
export type HandbookOutput = z.infer<typeof HandbookOutputZ>;
export type DevDocOutput = z.infer<typeof DevDocOutputZ>;

/** 每个模型任务阶段对应的输出 schema */
export const OUTPUT_SCHEMAS = {
  digest: DigestOutputZ,
  qgroup: QgroupOutputZ,
  clarify: ClarifyOutputZ,
  propose: ProposeOutputZ,
  review: ReviewOutputZ,
  recheck: RecheckOutputZ,
  adjudicate: AdjudicationOutputZ,
  build: BuildReportOutputZ,
  evaluate: EvaluationOutputZ,
  final_review: FinalReviewOutputZ,
  prd: PrdOutputZ,
  handbook: HandbookOutputZ,
  devdoc: DevDocOutputZ,
  probe: ProbeOutputZ,
} as const;
export type TaskPhase = keyof typeof OUTPUT_SCHEMAS;

// =====================================================================
// API 输入（来自浏览器），一律严格校验
// =====================================================================
const shortText = z.string().max(20_000);

export const ReferenceDocumentsZ = z.array(z.object({
  name: z.string().trim().min(1).max(240)
    .regex(/\.(md|txt)$/i, '参考文档名称必须以 .md 或 .txt 结尾')
    .refine(name => !/[\x00-\x1f\x7f\\:]/.test(name) && !name.startsWith('/') && !name.split('/').some(part => part === '..' || part === '.' || !part), '参考文档名称必须是有效相对路径'),
  content: z.string().min(1).max(REFERENCE_LIMITS.maxDocumentChars)
    .refine(content => content.trim().length > 0, '参考文档内容不能为空')
    .refine(content => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content), '参考文档不能包含二进制控制字符'),
}).strict()).max(REFERENCE_LIMITS.maxDocuments).superRefine((documents, ctx) => {
  if (documents.reduce((sum, document) => sum + document.content.length, 0) > REFERENCE_LIMITS.maxTotalChars) {
    ctx.addIssue({ code: 'custom', message: `参考文档总字符数不能超过 ${REFERENCE_LIMITS.maxTotalChars}` });
  }
  const names = documents.map(document => document.name.normalize('NFC').toLowerCase());
  if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', message: '参考文档名称重复，请先重命名或移除重复文档' });
});

export const ReferenceArchiveNameZ = z.string().trim().min(1).max(240).regex(/\.zip$/i)
  .refine(name => !/[\\/:\x00-\x1f\x7f]/.test(name), 'ZIP 名称不能包含路径或控制字符');

export const ReferenceArchivesZ = z.array(z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  name: ReferenceArchiveNameZ,
  size: z.number().int().min(22),
  files: z.array(z.object({
    name: z.string().min(1).max(1024),
    path: z.string().regex(/^files\/[0-9]+(?:\.[a-z0-9]{1,16})?$/),
    size: z.number().int().nonnegative().max(REFERENCE_LIMITS.maxEntryBytes),
  }).strict()).max(REFERENCE_LIMITS.maxArchiveEntries),
  notes: z.array(z.string().max(2000)).max(REFERENCE_LIMITS.maxArchiveEntries),
}).strict()).max(REFERENCE_LIMITS.maxArchives).superRefine((archives, ctx) => {
  if (new Set(archives.map(a => a.id)).size !== archives.length || new Set(archives.map(a => a.name.normalize('NFC').toLowerCase())).size !== archives.length) {
    ctx.addIssue({ code: 'custom', message: 'ZIP 附件不能重复' });
  }
});

export const ReferenceImportInputZ = z.object({
  name: z.string().trim().min(1).max(240),
  contentBase64: z.string().min(4).max(4 * Math.ceil(REFERENCE_LIMITS.maxZipBytes / 3))
    .refine(value => {
      const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
      return value.length % 4 === 0 && !/[^A-Za-z0-9+/]/.test(value.slice(0, value.length - padding));
    }, '文件数据不是合法 Base64'),
}).strict();

export const CreateRunInputZ = z.object({
  title: z.string().min(1).max(200),
  mode: z.enum(['mock', 'real']),
  /** mock 模式下使用的场景（见 adapters/mock-scenarios.ts） */
  mockScenario: z.string().max(64).nullable().default(null),
  project: z.object({
    prompt: z.string().min(1).max(50_000),
    coreFlows: z.array(z.string().max(2000)).max(30).default([]),
    existingStack: shortText.default(''),
    deployment: shortText.default(''),
    budget: shortText.default(''),
    acceptance: shortText.default(''),
    context: shortText.default(''),
    referenceDocuments: ReferenceDocumentsZ.optional(),
    referenceArchives: z.array(z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).strict())
      .max(REFERENCE_LIMITS.maxArchives)
      .refine(items => new Set(items.map(item => item.id)).size === items.length, 'ZIP 附件不能重复').optional(),
  }),
  constraints: z
    .array(z.object({ text: z.string().min(1).max(2000), kind: z.enum(['must', 'must_not']) }))
    .max(30)
    .default([]),
  /** 澄清阶段由谁提问；默认由 Claude 统一提问，避免重复询问用户。 */
  clarifyWith: z.enum(['both', 'claude', 'astra', 'skip']).default('claude'),
  allowWebResearch: z.boolean().default(true),
  /** 本机固定命令预检，不调用模型；未传时使用配置默认值。 */
  preflightEnabled: z.boolean().optional(),
  build: BuildOptionsZ.partial().optional(),
  evaluator: ReviewInputZ.optional(),
  finalReview: ReviewInputZ.optional(),
  contextBudget: z.object({ enabled: z.boolean() }).strict().optional(),
  chores: z.object({ digest: z.boolean().optional(), qgroup: z.boolean().optional() }).strict().optional(),
  /** 默认由 Claude 主导架构、Astra 评审；旧运行缺失字段时仍由迁移逻辑保持原行为。 */
  designMode: z.enum(['auto', 'dual', 'single']).default('single'),
  riskLevel: z.enum(['low', 'medium', 'high']).optional(),
  docWriters: z.object({
    handbook: z.object({ role: z.enum(['claude', 'astra', 'sol']), effort: EffortZ }).strict().optional(),
    devdoc: z.object({ role: z.enum(['claude', 'astra', 'sol']), effort: EffortZ }).strict().optional(),
    prd: z.object({ role: z.enum(['claude', 'astra', 'sol']), effort: EffortZ }).strict().optional(),
  }).strict().optional(),
  /** 确认框架后、构建 MVP 前，先写《架构说明手册》（给老板、用户方）和《开发文档》（给 AI），G3 确认后才构建（默认开启） */
  writeDocs: z.boolean().default(true),
  /** MVP 在 G4 被接受后，依据真实结果写 PRD，G5 确认（默认开启） */
  writePrd: z.boolean().default(true),
  /** 显式选择的强度；不传则用配置默认值（Max）。界面必须展示当前值，不能静默更改 */
  efforts: z
    .object({ claude: EffortZ.optional(), astra: EffortZ.optional(), sol: EffortZ.optional(), docs: EffortZ.optional() })
    .default({}),
  /** 评分权重（开始评分后锁定）。不传用默认 */
  criteriaWeights: z.record(z.string(), z.number().min(0).max(1)).nullable().default(null),
});
export type CreateRunInput = z.infer<typeof CreateRunInputZ>;

export const AnswerInputZ = z.object({
  /** answered = 选了选项或填了“其他”；skipped = 采用默认假设；unsure = 暂不确定（记为待确认事项） */
  status: z.enum(['answered', 'skipped', 'unsure']),
  optionIds: z.array(z.string().max(64)).max(20).default([]),
  otherText: z.string().max(5000).nullable().default(null),
  note: z.string().max(5000).nullable().default(null),
});
export type AnswerInput = z.infer<typeof AnswerInputZ>;

export const OverrideInputZ = z.object({
  kind: z.enum(['score', 'constraint']),
  candidateId: z.string().max(32),
  criterionId: z.string().max(64).nullable().default(null),
  constraintId: z.string().max(64).nullable().default(null),
  /** score: 0–5 整数；constraint: 'pass' | 'fail'；null 表示撤销覆盖 */
  value: z.union([z.number().int().min(0).max(5), z.enum(['pass', 'fail']), z.null()]),
  reason: z.string().min(1).max(5000),
});
export type OverrideInput = z.infer<typeof OverrideInputZ>;

export const AcceptanceCriterionInputZ = z.object({
  id: z.string().min(1).max(32),
  description: z.string().min(1).max(2000),
  kind: z.enum(['command', 'manual']),
  command: z.string().max(500).nullable().default(null),
  expectExitCode: z.number().int().nullable().default(0),
  outputIncludes: z.string().max(500).nullable().default(null),
});

export const G1InputZ = z.object({
  gate: z.literal('G1_answers'),
  /** 提交：未回答的问题全部按默认假设处理 */
  action: z.enum(['submit', 'cancel']),
});

export const G2InputZ = z.object({
  gate: z.literal('G2_framework'),
  action: z.enum(['validate', 'recheck', 'redesign', 'escalate_dual', 'stop', 'cancel']),
  architectOverride: z.object({ from: z.literal('claude'), to: z.literal('astra'), reason: z.string().trim().min(1) }).strict().optional(),
  /** action=validate：确认进入验证的候选（1–3 个） */
  candidateIds: z.array(z.string().max(32)).max(3).default([]),
  /** action=validate：每个候选确认后的 MVP 规格（用户可编辑验收项） */
  specs: z
    .array(
      z.object({
        candidateId: z.string().max(32),
        goal: z.string().min(1).max(5000),
        scopeIn: z.array(z.string().max(2000)).max(30),
        scopeOut: z.array(z.string().max(2000)).max(30),
        acceptance: z.array(AcceptanceCriterionInputZ).min(1).max(20),
        hypotheses: z
          .array(z.object({ id: z.string().max(32), text: z.string().max(2000), passCriteria: z.string().max(2000) }))
          .max(10)
          .default([]),
        timeboxMinutes: z.number().int().min(10).max(600).default(120),
        allowNetwork: z.boolean().default(true),
      }),
    )
    .max(3)
    .default([]),
  /** 每个候选的 Sol 强度；不传按规则自动选（单工作流 Max，多个独立工作流 Ultra） */
  efforts: z.record(z.string(), z.enum(['max', 'ultra'])).default({}),
  /** 每个候选的最终构建上限；只在 G2 创建新批次时冻结。 */
  buildOverrides: z.record(z.string(), BuildOptionsZ.omit({ resumePolicy: true }).partial()).optional(),
  /** action=recheck：要复核的不确定项编号（来自 DecisionReport.keyUncertainties[].id），空 = 全部关键项 */
  recheckItemIds: z.array(z.string().max(64)).max(50).default([]),
  reason: z.string().max(5000).nullable().default(null),
});

export const G3InputZ = z.object({
  gate: z.literal('G3_docs'),
  /** approve：架构说明手册与开发文档通过，开始构建 MVP；revise：按意见修订；back_to_framework：回到 G2 修改框架或 MVP 范围 */
  action: z.enum(['approve', 'revise', 'back_to_framework', 'stop', 'cancel']),
  /** approve：评审人及角色，例如“王总（老板）；李经理（用户方）” */
  reviewers: z.string().max(500).nullable().default(null),
  conclusion: z.enum(['通过', '补充后通过']).default('通过'),
  /** revise：每份文档的修改意见，至少一份 */
  handbookNotes: z.string().max(10_000).nullable().default(null),
  devdocNotes: z.string().max(10_000).nullable().default(null),
  reason: z.string().max(5000).nullable().default(null),
});

export const G4InputZ = z.object({
  gate: z.literal('G4_final'),
  action: z.enum(['accept', 'retry_job', 'rework_job', 'light_rework_job', 'rework_with_final_review', 'retry_evaluation', 'retry_final_review', 'rerun_preflight', 'ignore_preflight', 'validate_more', 'stop']),
  chosenCandidateId: z.string().max(32).nullable().default(null),
  jobId: z.string().max(64).nullable().default(null),
  /** 用户对人工验收项的判定 */
  manualResults: z
    .array(z.object({ jobId: z.string().max(64), criterionId: z.string().max(32), pass: z.boolean(), note: z.string().max(2000).nullable().default(null) }))
    .max(60)
    .default([]),
  /** 用户确认的失败分类（可修正 Sol 的自报） */
  failureClassOverrides: z.record(z.string(), FailureClassZ).default({}),
  reason: z.string().max(5000).nullable().default(null),
});

/** 旧客户端兼容：解析后统一归一化为 G4_final。 */
export const LegacyG3FinalInputZ = z.object({
  gate: z.literal('G3_final'),
  action: z.enum(['accept', 'retry_job', 'validate_more', 'stop']),
  chosenCandidateId: z.string().max(32).nullable().default(null),
  jobId: z.string().max(64).nullable().default(null),
  manualResults: z
    .array(z.object({ jobId: z.string().max(64), criterionId: z.string().max(32), pass: z.boolean(), note: z.string().max(2000).nullable().default(null) }))
    .max(60)
    .default([]),
  failureClassOverrides: z.record(z.string(), FailureClassZ).default({}),
  reason: z.string().max(5000).nullable().default(null),
});

/** G5：MVP 之后撰写的 PRD 确认 */
export const G5InputZ = z.object({
  gate: z.literal('G5_prd'),
  /** approve：PRD 确认，运行结束；revise：按意见修订；stop：不确认 PRD，直接结束（PRD 保持草稿） */
  action: z.enum(['approve', 'revise', 'stop']),
  reviewers: z.string().max(500).nullable().default(null),
  conclusion: z.enum(['通过', '补充后通过']).default('通过'),
  prdNotes: z.string().max(10_000).nullable().default(null),
  reason: z.string().max(5000).nullable().default(null),
});

export const GateInputZ = z
  .union([z.discriminatedUnion('gate', [G1InputZ, G2InputZ, G3InputZ, G4InputZ, G5InputZ]), LegacyG3FinalInputZ])
  .transform((input) => (input.gate === 'G3_final' ? { ...input, gate: 'G4_final' as const } : input));
export type GateInput = z.infer<typeof GateInputZ>;
export type G2Input = z.infer<typeof G2InputZ>;
export type G3Input = z.infer<typeof G3InputZ>;
export type G4Input = z.infer<typeof G4InputZ>;
export type G5Input = z.infer<typeof G5InputZ>;
