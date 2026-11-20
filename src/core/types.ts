/**
 * 领域对象（持久化到 data/runs/<runId>/run.json）。
 * 这里只放类型；逻辑在各自模块。字段名即接口契约，网页端直接读取这些结构。
 */
import type {
  AdjudicationOutput,
  BuildReportOutput,
  EvaluationOutput,
  FinalReviewOutput,
  ConstraintCheckOut,
  EvidenceOut,
  FailureClass,
  ObjectionOut,
  ProposalOut,
  QuestionOut,
  ScoreOut,
  TaskPhase,
} from './schemas.js';

import type { ContextBudgetOptions, ContextObservation, MilestonePlan } from './context-budget.js';
import type { DesignMode, RiskLevel, DesignResolution, DocWriters } from './design-mode.js';
import type { ChoreSource, DigestOutput, QgroupOutput } from './chores.js';
export type DesignRole = 'claude' | 'astra';
export type ModelRole = DesignRole | 'sol' | 'grok';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type RunMode = 'mock' | 'real';
export type AdapterKind = 'mock' | 'claude-code' | 'codex' | 'cursor';
export type Origin = 'claude' | 'astra' | 'both';

export interface ModelConfig {
  role: ModelRole;
  adapter: AdapterKind;
  /** 请求的型号标识，例如 claude-opus-5-5 / gpt-6.2-astra / gpt-6.2-sol。禁止使用会静默变化的别名 */
  model: string;
  effort: Effort;
}

// ---------------------------------------------------------------- 需求快照
export interface HardConstraint {
  id: string; // H1, H2...
  text: string;
  kind: 'must' | 'must_not';
}

export interface Statement {
  id: string; // F1 / A1 / O1
  text: string;
  /** user_input | answer:Q3 | default:Q3 | unsure:Q3 */
  source: string;
}

export interface ReferenceDocument {
  /** 展示名称；ZIP 中的文档保留归档名与相对路径，不作为本机文件路径使用 */
  name: string;
  content: string;
}

export interface ReferenceArchive {
  /** 由服务端生成，绑定原始 ZIP 内容和文件名 */
  id: string;
  name: string;
  size: number;
  /** name 为包内原名，path 为工作台生成的安全文件路径 */
  files: { name: string; path: string; size: number }[];
  notes: string[];
}

export interface ProjectInput {
  title: string;
  prompt: string;
  coreFlows: string[];
  existingStack: string;
  deployment: string;
  budget: string;
  acceptance: string;
  context: string;
  /** 旧记录可以没有此字段；正文随快照保存，不能当作用户确认的指令 */
  referenceDocuments?: ReferenceDocument[];
  /** 原 ZIP 独立存储，快照只保存可追溯的附件清单 */
  referenceArchives?: ReferenceArchive[];
}

export interface RequirementSnapshot {
  version: number;
  /** v<version>-<hash12>，模型输出必须原样回填 snapshotRef */
  ref: string;
  hash: string;
  createdAt: string;
  reason: string;
  project: ProjectInput;
  constraints: HardConstraint[];
  facts: Statement[];
  assumptions: Statement[];
  openItems: Statement[];
}

// ---------------------------------------------------------------- 问题
export type QuestionStatus = 'open' | 'answered' | 'skipped' | 'unsure';
export type QuestionPhase = 'clarify' | 'propose' | 'review' | 'recheck' | 'adjudicate' | 'build';

export interface Question extends Omit<QuestionOut, 'localId'> {
  id: string; // Q1, Q2...（全局编号）
  localId: string;
  askedBy: ModelRole;
  phase: QuestionPhase;
  taskId: string;
  createdAt: string;
  /** 提问时依据的快照版本 */
  snapshotVersion: number;
  status: QuestionStatus;
  answer: null | {
    optionIds: string[];
    otherText: string | null;
    note: string | null;
    answeredAt: string;
  };
  /** 该回答被并入了哪个快照版本；null 表示尚未并入 */
  appliedInSnapshot: number | null;
  /** 同主题下其他模型提出的相近问题（仅用于界面分组展示） */
  relatedQuestionIds: string[];
}

// ---------------------------------------------------------------- 任务与执行元数据
export type TaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'interrupted';

export type OutputValidity = 'pending' | 'valid' | 'repaired' | 'invalid' | 'n/a';

export type FailureKind =
  | 'not_installed'
  | 'not_logged_in'
  | 'auth_failed'
  | 'model_unavailable'
  | 'effort_unsupported'
  | 'model_mismatch'
  | 'rate_limited'
  | 'refusal'
  | 'timeout'
  | 'cancelled'
  | 'invalid_output'
  | 'snapshot_mismatch'
  | 'process_error'
  | 'unknown';

export interface ExecutionMeta {
  adapter: AdapterKind;
  cliVersion: string | null;
  /** 操作系统是否已成功创建 CLI 子进程；旧记录可能没有该字段。 */
  processStarted?: boolean | null;
  /** 实际执行的命令行（不含提示词；提示词经 stdin 传入） */
  command: string[];
  cwd: string;
  requestedModel: string;
  requestedEffort: Effort;
  /** 执行端报告的型号；Claude 取 result.modelUsage 的键（服务端用量），Codex 只能取 CLI 配置摘要 */
  reportedModels: string[];
  reportedModelSource: 'server_usage' | 'cli_config' | 'init_event' | null;
  /** 只有服务端用量里出现了请求型号才算 true；否则界面显示“未确认” */
  modelConfirmed: boolean;
  reportedEffort: string | null;
  effortConfirmed: boolean;
  sessionId: string | null;
  exitCode: number | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  usage: Record<string, number> | null;
  costUsd: number | null;
  /** 是否用了 CLI 的原生结构化输出（--json-schema / --output-schema） */
  nativeSchema: boolean;
  /** 子进程环境里被移除的认证类变量名（只记名字，不记值） */
  scrubbedEnv: string[];
  warnings: string[];
  /** Native process termination could not confirm the complete tree exited. */
  terminationWarning?: string;
}

export interface TaskRecord {
  id: string; // t-<scope>-<role>-a<attempt>
  runId: string;
  role: ModelRole;
  phase: TaskPhase;
  /** 阶段实例：clarify / r1-propose / r1-review / r1-recheck-1 / job:j-C1-1 */
  scope: string;
  attempt: number;
  /** 同一逻辑任务的重试链：第一次尝试的 id */
  rootTaskId: string;
  status: TaskStatus;
  outputValidity: OutputValidity;
  validationErrors: string[];
  repairAttempted: boolean;
  failure: null | { kind: FailureKind; message: string };
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  lastProgress: string | null;
  lastProgressAt: string | null;
  meta: ExecutionMeta | null;
  simulated: boolean;
  /** build 阶段：对应的验证作业 */
  jobId: string | null;
  /** 被用户接受的“型号不符”输出（默认 false；见 FailureKind=model_mismatch） */
  acceptedDespiteMismatch: boolean;
  /** 本任务读取的输入版本：需求快照 ref（设计任务）或 MVP 规格 ref（构建任务）。用于证明两边读的是同一版本 */
  inputRef: string | null;
  /** 实际适配器调用区间；不含工作区准备、输出校验或服务停机。旧任务缺失时用量未知。 */
  executionCalls?: { kind: 'initial' | 'repair'; startedAt: string; endedAt: string | null; status: TaskStatus }[];
  /** 作业任务必须绑定创建时的批次和轮次；旧记录缺省不推断。 */
  jobBatch?: number;
  buildRound?: number;
  buildKind?: 'init' | 'milestone';
  buildSessionId?: string;
  choreSources?: ChoreSource[];
  choreQuestionIds?: string[];
  staleReason?: string | null;
}

// ---------------------------------------------------------------- 方案、评审、候选
export interface Proposal extends ProposalOut {
  id: string; // r1-claude-1 / r1-astra-2（r = 设计轮次）
  author: DesignRole;
  taskId: string;
  snapshotVersion: number;
  designRound: number;
}

export interface Judgment {
  judge: DesignRole;
  taskId: string;
  designRound: number;
  proposalId: string;
  /** 评审时该候选的匿名编号（审计用） */
  anonymousId: string;
  constraintChecks: ConstraintCheckOut[];
  scores: ScoreOut[];
  objections: ObjectionOut[];
  strengths: string[];
}

export interface Candidate {
  id: string; // C1, C2...
  memberProposalIds: string[];
  origin: Origin;
  representativeProposalId: string;
  /** 只有一位评审认为可能重复（不合并，仅提示） */
  possibleDuplicateOf: string[];
  /** 用户后来回答的问题推翻了该候选依赖的默认假设 */
  invalidatedAssumptions: string[];
}

export interface Override {
  id: string;
  kind: 'score' | 'constraint';
  candidateId: string;
  /** 候选编号可能因合并而变化；用代表提案锚定 */
  proposalAnchor: string;
  criterionId: string | null;
  constraintId: string | null;
  value: number | 'pass' | 'fail';
  reason: string;
  at: string;
}

export interface Criterion {
  id: string;
  name: string;
  weight: number;
  /** anchors[k] = k 分的判定标准（k=0..5） */
  anchors: string[];
}

export interface DecisionParams {
  /** 平局区间 δ：总分差小于 δ 视为“接近” */
  tieMargin: number;
  /** 两位评审分差 ≥ 该值视为“分歧”，不做平均 */
  disagreementThreshold: number;
  /** 只有一位评审给分时的不确定带宽（±） */
  singleJudgeBand: number;
  /** 接近时偏好的整体框架来源 */
  preferredOrigin: DesignRole | 'none';
  /** 偏好也打不破的平局，用哪个评分项做第二平局规则 */
  tiebreakCriterionId: string | null;
  tiebreakMinGap: number;
}

// ---------------------------------------------------------------- 决策报告（decision-engine 输出）
export type CellKind = 'agreed' | 'disputed' | 'single' | 'unknown' | 'user';

export interface CellResult {
  candidateId: string;
  criterionId: string;
  kind: CellKind;
  lo: number;
  hi: number;
  /** agreed/user/single 才有点值；disputed/unknown 为 null（不编造中间分） */
  point: number | null;
  judgeScores: Partial<Record<DesignRole, number | null>>;
  rationales: Partial<Record<DesignRole, string[]>>;
  evidence: Partial<Record<DesignRole, EvidenceOut[]>>;
}

export type ConstraintStatus = 'pass' | 'fail' | 'disputed' | 'unknown';

export interface ConstraintResult {
  candidateId: string;
  constraintId: string;
  status: ConstraintStatus;
  source: 'judges' | 'user';
  judgeStatuses: Partial<Record<DesignRole, 'pass' | 'fail' | 'unknown' | null>>;
  rationales: Partial<Record<DesignRole, string[]>>;
}

export interface CandidateTotals {
  candidateId: string;
  origin: Origin;
  status: 'viable' | 'conditional' | 'eliminated';
  lo: number;
  hi: number;
  /** 只含有点值的格子之和（不含 disputed/unknown 的任何“中间分”） */
  knownScore: number;
  unknownWeight: number;
  disputedWeight: number;
  preferenceEligible: boolean;
  eliminatedBy: string[];
  unresolvedConstraints: string[];
}

export interface PairwiseResult {
  a: string;
  b: string;
  /** a 最差情形 − b 最好情形 */
  dLo: number;
  /** a 最好情形 − b 最差情形 */
  dHi: number;
  aRobustlyPreferred: boolean;
}

export type Outcome = 'recommend' | 'single' | 'tie' | 'needs_verification' | 'none_viable';
export type DecisionBasis = 'clear' | 'preference' | 'tiebreak' | 'only_viable' | null;

export interface KeyUncertainty {
  id: string; // U1, U2...
  candidateId: string;
  kind: 'cell' | 'constraint' | 'assumption';
  criterionId: string | null;
  constraintId: string | null;
  /** kind=assumption：被推翻的问题编号 */
  questionId: string | null;
  /** 加权区间宽度；约束项为 Infinity（总是关键） */
  impact: number;
  isKey: boolean;
  description: string;
  judgeScores: Partial<Record<DesignRole, number | null>>;
}

export interface SelfPreferenceDiag {
  judge: DesignRole;
  /** 该评审对“自己提出的候选”评分 − 另一位评审对同一候选的评分（均值） */
  ownMeanDelta: number | null;
  /** 该评审对“对方提出的候选”评分 − 另一位评审对同一候选的评分（均值） */
  otherMeanDelta: number | null;
  index: number | null;
  sampleSize: number;
}

export interface DecisionReport {
  outcome: Outcome;
  basis: DecisionBasis;
  winnerId: string | null;
  /** 推荐方案仍有未决硬约束 */
  conditional: boolean;
  contenders: string[];
  /** 按区间中点排序，仅供展示参考，不是结论 */
  displayOrder: string[];
  totals: CandidateTotals[];
  cells: CellResult[];
  constraints: ConstraintResult[];
  pairwise: PairwiseResult[];
  keyUncertainties: KeyUncertainty[];
  suggestedValidation: { candidateIds: string[]; reason: string; hypotheses: string[] };
  selfPreference: SelfPreferenceDiag[];
  explanation: string[];
  params: DecisionParams;
  judges: DesignRole[];
  degraded: boolean;
  computedAt: string;
}

// ---------------------------------------------------------------- 关卡（用户确认点）
export type GateId = 'G1_answers' | 'G2_framework' | 'G3_docs' | 'G4_final' | 'G5_prd' | 'G3_final';

export interface GateRecord {
  id: GateId;
  openedAt: string;
  resolvedAt: string | null;
  /** 用户提交的原始决定（已校验） */
  resolution: unknown;
  /** 打开关卡时的上下文摘要，例如 G2 的 decision 计算时间 */
  context: Record<string, unknown>;
}

// ---------------------------------------------------------------- 验证作业（Sol）
export interface AcceptanceCriterion {
  id: string;
  description: string;
  kind: 'command' | 'manual';
  command: string | null;
  expectExitCode: number | null;
  outputIncludes: string | null;
}

export interface MvpSpec {
  /** spec-<hash12>，Sol 报告必须回填 */
  ref: string;
  candidateId: string;
  goal: string;
  scopeIn: string[];
  scopeOut: string[];
  acceptance: AcceptanceCriterion[];
  hypotheses: { id: string; text: string; passCriteria: string }[];
  timeboxMinutes: number;
  allowNetwork: boolean;
  /** 多个候选同时验证时共享的比较问题（来自决策报告的关键不确定项） */
  comparisonQuestions: string[];
}

export type VerificationStatus = 'verified_pass' | 'verified_fail' | 'not_observed' | 'awaiting_user' | 'user_pass' | 'user_fail';

export interface AcceptanceVerification {
  criterionId: string;
  status: VerificationStatus;
  /** 日志里匹配到的命令与退出码 */
  matchedCommand: string | null;
  exitCode: number | null;
  outputExcerpt: string | null;
  note: string;
  /** 合并写者与评审核验时，记录该项实际采用的工具日志任务。 */
  evidenceTaskId?: string;
}

export interface VerificationResult {
  verdict: 'passed' | 'failed' | 'inconclusive' | 'awaiting_manual';
  items: AcceptanceVerification[];
  /** Sol 自报与日志核验不一致的项 */
  selfReportMismatches: string[];
  computedAt: string;
  specRef?: string;
  atCommit?: string | null;
  treeHash?: string | null;
  taskId?: string;
  logRange?: { from: number; to: number } | null;
  staleReason?: string | null;
}

export type JobStatus =
  | 'queued'
  | 'preparing'
  | 'running'
  | 'verifying'
  | 'evaluating'
  | 'final_review'
  | 'passed'
  | 'failed'
  | 'inconclusive'
  | 'awaiting_manual'
  | 'cancelled';

export interface PreflightResult {
  ok: boolean;
  checkedAt: string;
  items: { check: string; status: 'ok' | 'missing' | 'warn'; detail: string }[];
}

export interface BuildLimits {
  maxRounds: number;
  maxWriterSessions: number;
  maxModelCalls: number;
  maxActiveMinutes: number;
}

export interface BuildOptions extends BuildLimits {
  autoRework: boolean;
  resumePolicy: 'never' | 'budgeted';
  /** 旧配置缺省为关闭；在 G2 冻结到各作业。 */
  lightReworkEnabled?: boolean;
  lightReworkMinutes?: number;
}

export interface ReviewOptions {
  enabled: boolean;
  model: string;
  effort: Effort;
  timeoutMinutes: number;
}

export interface BudgetCall {
  id: string;
  taskId: string;
  kind: 'initial' | 'repair';
  writer: boolean;
  state: 'reserved' | 'started' | 'settled' | 'not_started' | 'unknown';
  startedAt: string | null;
  endedAt: string | null;
  activeMs: number | null;
}

export interface JobBudget {
  limits: BuildLimits;
  usage: { buildRounds: number; writerSessions: number; modelCalls: number; activeMs: number };
  reservedCalls: string[];
  reservedWriterSessions: string[];
  exhaustedReason: string | null;
  calls: BudgetCall[];
}

export interface BuildSession {
  id: string; kind: 'init' | 'milestone'; milestoneIds: string[]; finalVerification: boolean;
  taskId: string; startCommit: string | null; endCommit: string | null;
  threadId: string | null; resumedFrom: string | null; resumeReason: string;
  handoffPath: string | null; verification: VerificationResult | null;
  outcome: 'pending' | 'passed' | 'failed' | 'awaiting_manual' | 'stopped';
  context: ContextObservation;
  /** 每次 CLI 调用单独保留身份；结构修复同样占每轮会话上限。 */
  invocations?: { id: string; kind: 'initial' | 'repair'; threadId: string | null; context: ContextObservation;
    processStarted: boolean | null; startedAt: string; endedAt: string | null; status: TaskStatus }[];
  material?: { estimatedTokens: number; targetTokens: number; estimateReference: string; omitted: { id: string; sourcePath: string; reason: string }[] };
  startedAt: string | null; endedAt: string | null;
}
export interface BuildRoundContext {
  plan: MilestonePlan | null; planHash: string | null; planPath: string;
  states: { id: string; status: 'pending' | 'running' | 'passed' | 'failed' | 'awaiting_manual'; attempts: number; verifiedAtCommit: string | null }[];
  sessions: BuildSession[]; dispatchBlocked: string | null;
}
export interface BuildRound {
  round: number;
  kind: 'initial' | 'rework' | 'retry';
  writer: ModelRole;
  buildTaskId: string;
  evaluateTaskId: string | null;
  report: BuildReportOutput | null;
  verification: VerificationResult | null;
  evaluation: EvaluationOutput | null;
  workspaceCommit: string | null;
  treeHash: string | null;
  baselineCommit: string | null;
  fileTree: string[];
  diffStat: string;
  reviewWorkspace: string | null;
  reviewIntegrity: { ok: boolean; errors: string[] } | null;
  verifiedDefectIds: string[];
  reworkBrief: { defectIds: string[]; instructions: string }[];
  /** 仅 G4 显式采用终审意见时冻结；不是可自动返工的缺陷证据。 */
  finalReviewInstructions?: { taskId: string; notes: string[]; requestedAt: string } | null;
  lightRework?: {
    allowedFiles: string[]; sourceCommit: string; sourceTreeHash: string; capabilityRef: string;
    minutes: number; evaluateMinutes: number; finalMinutes: number;
    reservedEvaluateTaskId: string; reservedFinalTaskId: string | null;
  };
  context?: BuildRoundContext;
  outcome: 'pending' | 'passed' | 'rework' | 'exhausted' | 'stopped';
  staleReason: string | null;
  stoppedReason: string | null;
  createdAt: string;
  endedAt: string | null;
  /** 显式保留的未完成代码，不可回放旧任务日志作为当前自动验收。 */
  checkpointId?: string;
}

export interface ValidationJob {
  id: string; // j-C1-1
  runId: string;
  /** 第几次“确认进入验证”（G2 validate）；同一批作业一起进入 G3 */
  batch: number;
  candidateId: string;
  /** 候选的代表提案（候选编号可能变化，以此为准） */
  proposalId: string;
  effort: 'max' | 'ultra';
  effortReason: string;
  workspaceDir: string;
  gitRepo: boolean | null;
  spec: MvpSpec;
  status: JobStatus;
  taskIds: string[];
  report: BuildReportOutput | null;
  verification: VerificationResult | null;
  manualResults: { criterionId: string; pass: boolean; note: string | null; at: string;
    specRef?: string; round?: number; atCommit?: string; treeHash?: string }[];
  failureClass: FailureClass | null;
  failureClassSource: 'sol' | 'grok' | 'user' | 'preflight' | null;
  /** undefined 表示旧作业没有预检能力；null 表示已启用但尚未检查。 */
  preflight?: PreflightResult | null;
  preflightHistory?: PreflightResult[];
  /** 只忽略指定检查版本，不自动沿用到后续重跑。 */
  preflightOverride?: { checkedAt: string; reason: string; at: string } | null;
  /** 忽略记录绑定原报告，重试清除活动覆盖时也不删除审计。 */
  preflightAudit?: { report: PreflightResult; reason: string; ignoredAt: string }[];
  /** 首个构建尝试结束时的核验快照，后续重试/人工结果不覆盖；缺失表示旧记录未知。 */
  firstVerification?: VerificationResult | null;
  /** 最近一次构建实际写进工作区（DEV_GUIDE.md）和提示词的开发文档版本 */
  devGuideVersion: number | null;
  createdAt: string;
  endedAt: string | null;
  rounds?: BuildRound[];
  maxRounds?: number;
  autoRework?: boolean;
  lightRework?: { enabled: boolean; minutes: number; capabilityRef: string | null };
  /** 只由通过完整路由检查的动作设置；普通重试仍使用 Sol。 */
  nextLightRework?: boolean;
  budget?: JobBudget;
  nextRoundKind?: BuildRound['kind'];
  nextFinalReviewInstructions?: BuildRound['finalReviewInstructions'];
  digest?: { taskId: string | null; status: 'pending' | 'ready' | 'skipped'; output: DigestOutput | null; reason: string | null };
  finalReview?: FinalReviewOutput | null;
  finalReviewTaskId?: string | null;
  finalReviewMissingReason?: string | null;
  finalReviewHistory?: { taskId: string; report: FinalReviewOutput | null; missingReason: string | null }[];
  /** 退出未确认时持久化，阻止同工作区启动新任务。 */
  writeLock?: { taskId: string; state: 'held' | 'unconfirmed'; reason: string | null } | null;
  /** 显式保存未完成代码；审计保留旧证据，检查点本身不代表验收通过。 */
  workspaceCheckpoints?: { id: string; at: string; reason: string; previousCommit: string | null;
    commit: string; treeHash: string; auditPath: string }[];
}

// ---------------------------------------------------------------- 文档
export type DocKind = 'prd' | 'handbook' | 'devdoc';

export interface DocBasis {
  batch: number;
  createdAt: string;
  snapshotRef: string;
  designRound: number;
  candidateIds: string[];
  candidates: Candidate[];
  decision: DecisionReport | null;
  specRefs: string[];
  jobIds: string[];
  confirmReason: string | null;
}

export interface DocRequest {
  kind: DocKind;
  version: number;
  seq: number;
  docRef: string;
  reason: 'initial' | 'revision' | 'new_basis';
  revisionNotes: string | null;
  previousVersion: number | null;
  abandoned: boolean;
}

export interface DocVersion {
  kind: DocKind;
  version: number;
  batch: number;
  taskId: string | null;
  docRef: string;
  reason: DocRequest['reason'];
  createdAt: string;
  status: 'draft' | 'approved' | 'superseded';
  content: unknown;
  revisionNotes: string | null;
  previousVersion: number | null;
  warnings: string[];
  approvedAt: string | null;
  approval: null | { reviewers: string | null; conclusion: '通过' | '补充后通过'; note: string | null };
}

export interface DocsState {
  batch: number;
  bases: DocBasis[];
  requests: DocRequest[];
  versions: DocVersion[];
  missing: DocKind[];
  requestSeq: number;
}

// ---------------------------------------------------------------- 运行
/**
 * 阶段（决策计算是即时的，不单独停留）：
 * intake → clarify → answering(G1) → propose → review → framework_gate(G2)
 *   ↘ recheck → framework_gate      ↘ validate → final_gate(G3) → done
 */
export type Phase =
  | 'intake'
  | 'clarify'
  | 'answering'
  | 'propose'
  | 'review'
  | 'framework_gate'
  | 'recheck'
  | 'adjudicate'
  | 'docs'
  | 'docs_gate'
  | 'validate'
  | 'final_gate'
  | 'prd_writing'
  | 'prd_gate'
  | 'done';

export type PhaseStatus = 'running' | 'waiting_user' | 'blocked' | 'completed';

export interface DegradedMark {
  role: DesignRole;
  phase: TaskPhase;
  scope: string;
  reason: string;
  at: string;
}

export interface ModelNote {
  taskId: string;
  role: ModelRole;
  phase: TaskPhase;
  understanding: string | null;
  gaps: string[];
  whyThisCount: string | null;
  rejectedAlternatives: { title: string; reason: string }[];
}

export interface RecheckLogEntry {
  /** 旧日志没有轮次，不能把它猜测成当前轮材料。 */
  designRound?: number;
  batch: number;
  judge: DesignRole;
  itemId: string;
  candidateId: string;
  criterionId: string | null;
  constraintId: string | null;
  before: number | string | null;
  after: number | string | null;
  changed: boolean;
  rationale: string;
}

export interface AnonymizationRecord {
  seed: number;
  /** judge -> 匿名编号 -> proposalId */
  maps: Partial<Record<DesignRole, Record<string, string>>>;
}

export interface RecheckRequest {
  id: string; // U1...
  candidateId: string;
  kind: 'cell' | 'constraint';
  criterionId: string | null;
  constraintId: string | null;
}

/** 裁决输入与结果独立保存；旧建议在输入变更后仅供审计。 */
export interface AdjudicationRecord {
  batch: number;
  designRound: number;
  snapshotRef: string;
  decisionComputedAt: string;
  taskId: string | null;
  requestedAt: string;
  completedAt: string | null;
  staleReason: string | null;
  items: KeyUncertainty[];
  candidateIds: string[];
  report: AdjudicationOutput | null;
}

export interface Run {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  mode: RunMode;
  mockScenario: string | null;
  phase: Phase;
  phaseStatus: PhaseStatus;
  /** blocked 时的原因与可选操作 */
  blockedReason: string | null;
  terminal: null | 'done' | 'cancelled';
  models: Record<DesignRole | 'sol', ModelConfig> & Partial<Record<'grok', ModelConfig>>;
  clarifyWith: 'both' | 'claude' | 'astra' | 'skip';
  allowWebResearch: boolean;
  /** 创建时冻结；旧运行缺字段时不新增预检步骤。 */
  preflight?: { enabled: boolean };
  build?: BuildOptions;
  evaluator?: ReviewOptions;
  finalReview?: ReviewOptions;
  contextBudget?: ContextBudgetOptions;
  chores?: { digest: boolean; qgroup: boolean };
  questionGroups?: { taskId: string | null; status: 'pending' | 'ready' | 'skipped'; output: QgroupOutput | null; reason: string | null };
  designMode?: DesignMode;
  riskLevel?: RiskLevel;
  designResolution?: DesignResolution;
  designResolutionHistory?: { round: number; resolution: DesignResolution }[];
  /** 创建时冻结的有效执行配置指纹；后续派发配置变化时保留指纹并标记漂移。 */
  metricsConfig?: { version: 1; fingerprint: string; drifted?: boolean };
  /** 构建 MVP 前是否撰写并确认架构手册与开发文档 */
  writeDocs: boolean;
  /** 接受 MVP 后是否撰写并确认 PRD */
  writePrd: boolean;
  /** 创建运行时冻结的文档撰写者 */
  docWriter: { role: Exclude<ModelRole, 'grok'>; model: string; effort: Effort };
  docWriters?: DocWriters;
  docs: DocsState;
  criteria: Criterion[];
  criteriaLockedAt: string | null;
  decisionParams: DecisionParams;
  snapshots: RequirementSnapshot[];
  currentSnapshotVersion: number;
  /** 本轮设计（propose/review）基于的快照版本 */
  designSnapshotVersion: number | null;
  degraded: DegradedMark[];
  tasks: TaskRecord[];
  questions: Question[];
  modelNotes: ModelNote[];
  proposals: Proposal[];
  judgments: Judgment[];
  /** 本轮每位评审给出的等价分组（已映射为 proposalId） */
  equivalenceGroups: Partial<Record<DesignRole, string[][]>>;
  /** 你在界面上手动合并的提案（例如只有一位评审认为相同的情况） */
  manualMerges: string[][];
  candidates: Candidate[];
  overrides: Override[];
  decision: DecisionReport | null;
  anonymization: AnonymizationRecord | null;
  recheckBatch: number;
  recheckRequests: RecheckRequest[];
  recheckLog: RecheckLogEntry[];
  /** 旧运行没有此字段，按空列表处理；不将旧复核冒充为 Ultra 裁决。 */
  adjudications?: AdjudicationRecord[];
  gates: GateRecord[];
  jobBatch: number;
  jobs: ValidationJob[];
  /** 最终选择（G4；兼容旧记录的 G3_final） */
  finalChoice: null | { candidateId: string | null; reason: string | null; at: string };
  /** 设计轮次：redesign 时 +1；proposals/judgments 带 designRound，旧轮次保留只读 */
  designRound: number;
  archivedRounds: { round: number; snapshotVersion: number; candidates: Candidate[]; decision: DecisionReport | null }[];
}
