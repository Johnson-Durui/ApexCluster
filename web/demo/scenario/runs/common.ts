// Shared constants and builders for the four synthetic review runs of the online demo (README.md "Runs").
// The shapes follow web/src/lib/types.ts (which re-exports src/core/types.ts); every record here is invented sample
// data for the demo. Nothing in this folder is read from a real run.
import type {
  Candidate, CandidateTotals, CellResult, ConstraintResult, Criterion, DecisionParams, DocKind, DocsState, Effort,
  ExecutionMeta, GateRecord, HardConstraint, Judgment, ModelRole, ProgressEntry, Proposal, Question, Run, TaskRecord,
  TaskStatus, ValidationJob,
} from '../../../src/lib/types';

/** Model seats of a review run, as config/workbench.config.example.json and src/config.ts define them. */
export const MODELS: Run['models'] = {
  claude: { role: 'claude', adapter: 'claude-code', model: 'claude-opus-5-5', effort: 'max' },
  astra: { role: 'astra', adapter: 'codex', model: 'gpt-6.2-astra', effort: 'max' },
  sol: { role: 'sol', adapter: 'codex', model: 'gpt-6.2-sol', effort: 'max' },
  grok: { role: 'grok', adapter: 'cursor', model: 'grok-4.7-high-fast', effort: 'high' },
};

/** DEFAULT_CRITERIA of src/core/criteria.ts (weights sum to 1). */
export const CRITERIA: Criterion[] = [
  { id: 'fit', name: '需求适配', weight: 0.3, anchors: ['无法满足核心流程（通常已被硬约束淘汰）', '多个核心流程只能部分满足', '有一个核心流程只能部分满足', '满足全部核心流程，但至少一个依赖变通或额外组件', '满足全部核心流程，只有次要需求需要变通', '满足全部硬约束与核心流程，设计直接支撑每个核心流程，无已知冲突'] },
  { id: 'cost', name: '开发与维护成本', weight: 0.25, anchors: ['超出可承受的成本', '需要专门运维或多人协作才能维护', '多项新技术或多个常驻服务，或依赖不够成熟', '需要学习一项新技术或维护一个常驻服务', '少量新技术或少量运维工作', '单人可在现有技能内维护；依赖少且成熟；无额外运维'] },
  { id: 'reliability', name: '可靠性与可验证性', weight: 0.25, anchors: ['核心行为不可验证', '多个关键路径不可验证或没有失败处理', '存在已知单点故障或难以测试的关键路径', '失败处理一般，部分关键行为难以自动化验证', '主要失败场景有处理，自动化测试可覆盖大部分关键行为', '关键失败场景有明确处理，核心行为可被自动化测试覆盖，有可观测性'] },
  { id: 'performance', name: '性能与资源成本', weight: 0.1, anchors: ['无法满足目标负载', '存在已知瓶颈，难以满足', '需要专门优化才能满足', '刚好满足目标负载', '满足目标并有余量', '明显超出目标负载要求，资源占用低'] },
  { id: 'evolution', name: '后续演进', weight: 0.1, anchors: ['无法演进', '预期变化需要重写主要部分', '预期变化需要较大重构', '部分预期变化需要跨模块修改', '大部分预期变化可局部修改', '模块边界清晰，主要变化方向都可局部修改'] },
];

/** DEFAULT_DECISION_PARAMS (config/workbench.config.example.json "decision"). */
export const DECISION_PARAMS: DecisionParams = { tieMargin: 0.25, disagreementThreshold: 2, singleJudgeBand: 1, preferredOrigin: 'claude', tiebreakCriterionId: 'cost', tiebreakMinGap: 1 };

export const BUILD: NonNullable<Run['build']> = { autoRework: false, maxRounds: 3, maxWriterSessions: 12, maxModelCalls: 20, maxActiveMinutes: 360, resumePolicy: 'never', lightReworkEnabled: false, lightReworkMinutes: 5 };
export const DOC_WRITER: Run['docWriter'] = { role: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' };
export const DOC_WRITERS: NonNullable<Run['docWriters']> = {
  handbook: { role: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' },
  devdoc: { role: 'astra', model: 'gpt-6.2-astra', effort: 'max' },
  prd: { role: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' },
};
export const EMPTY_DOCS: DocsState = { batch: 0, bases: [], requests: [], versions: [], missing: [], requestSeq: 0 };

/** Fields every demo run shares; each run file spreads this and adds its own state. */
export function commonFields(): Pick<Run, 'mode' | 'mockScenario' | 'models' | 'allowWebResearch' | 'preflight' | 'build' | 'evaluator' | 'finalReview' | 'chores' | 'writeDocs' | 'writePrd' | 'docWriter' | 'docWriters' | 'criteria' | 'decisionParams' | 'degraded' | 'equivalenceGroups' | 'manualMerges' | 'overrides' | 'anonymization' | 'recheckBatch' | 'recheckRequests' | 'recheckLog' | 'adjudications' | 'designRound' | 'archivedRounds'> {
  return {
    mode: 'real', mockScenario: null, models: structuredClone(MODELS), allowWebResearch: true,
    preflight: { enabled: true }, build: { ...BUILD },
    evaluator: { enabled: false, model: 'gpt-6.2-astra', effort: 'max', timeoutMinutes: 30 },
    finalReview: { enabled: false, model: 'claude-opus-5-5', effort: 'xhigh', timeoutMinutes: 30 },
    chores: { digest: false, qgroup: false },
    writeDocs: true, writePrd: true, docWriter: { ...DOC_WRITER }, docWriters: structuredClone(DOC_WRITERS),
    criteria: structuredClone(CRITERIA), decisionParams: { ...DECISION_PARAMS },
    degraded: [], equivalenceGroups: {}, manualMerges: [], overrides: [], anonymization: null,
    recheckBatch: 0, recheckRequests: [], recheckLog: [], adjudications: [], designRound: 1, archivedRounds: [],
  };
}

// ---------------------------------------------------------------- time

/** A clock for one run: t(minutes) is the ISO time `minutes` after the run was created. */
export function timeline(createdAtMs: number): (minutes: number) => string {
  return minutes => new Date(createdAtMs + Math.round(minutes * 60_000)).toISOString();
}

/** Milliseconds between two ISO times (end may be null: then 0). */
export const spanMs = (start: string, end: string | null) => end ? Math.max(0, Date.parse(end) - Date.parse(start)) : 0;

// ---------------------------------------------------------------- tasks

/** ExecutionMeta of a finished CLI task, with the command line the adapters in src/adapters build. */
export function meta(role: ModelRole, model: string, effort: Effort, startedAt: string, endedAt: string, exitCode = 0): ExecutionMeta {
  const claude = role === 'claude';
  return {
    adapter: claude ? 'claude-code' : 'codex', cliVersion: null, processStarted: true,
    command: claude
      ? ['claude', '-p', '--output-format', 'stream-json', '--verbose', '--model', model, '--effort', effort, '--json-schema', '<schema>', '--safe-mode']
      : ['codex', 'exec', '--json', '-m', model, '-c', `model_reasoning_effort=${effort}`, '--sandbox', role === 'sol' ? 'workspace-write' : 'read-only', '--output-schema', '<schema.json>', '-o', '<last-message.txt>', '--color', 'never'],
    cwd: 'D:\\workbench-demo\\tasks', requestedModel: model, requestedEffort: effort,
    reportedModels: exitCode === 0 ? [model] : [], reportedModelSource: exitCode === 0 ? (claude ? 'server_usage' : 'cli_config') : null,
    modelConfirmed: claude && exitCode === 0, reportedEffort: null, effortConfirmed: false, sessionId: null, exitCode,
    startedAt, endedAt, durationMs: spanMs(startedAt, endedAt), usage: null, costUsd: null, nativeSchema: true, scrubbedEnv: [], warnings: [],
  };
}

export interface TaskInput {
  id: string; role: ModelRole; phase: TaskRecord['phase']; scope: string; createdAt: string; startedAt: string | null; endedAt: string | null;
  status?: TaskStatus; inputRef?: string | null; jobId?: string | null; effort?: Effort; model?: string;
  failure?: TaskRecord['failure']; lastProgress?: string | null; extra?: Partial<TaskRecord>;
}

/** A TaskRecord with its execution meta and one execution call (src/core/metrics.ts reads executionCalls). */
export function task(run: Pick<Run, 'id' | 'models'>, input: TaskInput): TaskRecord {
  const status = input.status ?? 'succeeded';
  const configured = run.models[input.role];
  const model = input.model ?? configured?.model ?? 'unknown';
  const effort = input.effort ?? configured?.effort ?? 'max';
  const finished = status !== 'running' && status !== 'queued';
  const failed = status === 'failed' || status === 'timed_out';
  return {
    id: input.id, runId: run.id, role: input.role, phase: input.phase, scope: input.scope, attempt: 1, rootTaskId: input.id,
    status, outputValidity: status === 'succeeded' ? 'valid' : failed ? 'n/a' : 'pending', validationErrors: [], repairAttempted: false,
    failure: input.failure ?? null, createdAt: input.createdAt, startedAt: input.startedAt, endedAt: input.endedAt,
    lastProgress: input.lastProgress ?? null, lastProgressAt: input.lastProgress ? (input.endedAt ?? input.startedAt) : null,
    meta: finished && input.startedAt && input.endedAt ? meta(input.role, model, effort, input.startedAt, input.endedAt, failed ? 1 : 0) : null,
    simulated: false, jobId: input.jobId ?? null, acceptedDespiteMismatch: false, inputRef: input.inputRef ?? null,
    executionCalls: input.startedAt ? [{ kind: 'initial', startedAt: input.startedAt, endedAt: input.endedAt, status }] : [],
    ...input.extra,
  };
}

// ---------------------------------------------------------------- progress trails

/** One progress line of a task: seconds after the task started, kind and text (lib/labels.ts progressKindLabels). */
export type TrailLine = [seconds: number, kind: 'started' | 'tool' | 'message' | 'retry' | 'usage' | 'stderr' | 'info', text: string];

/** Turns trail lines into ProgressEntry records anchored at the task's start. */
export function trail(task: TaskRecord, lines: TrailLine[]): ProgressEntry[] {
  const start = Date.parse(task.startedAt ?? task.createdAt);
  return lines.map(([seconds, kind, text]) => ({ at: new Date(start + seconds * 1000).toISOString(), kind, text }));
}

/** The first progress line every CLI task reports. */
export const started = (model: string, effort: string): TrailLine => [2, 'started', `会话已启动（${model} · ${effort}）`];

// ---------------------------------------------------------------- questions, proposals, judgments

export type QuestionInput = Pick<Question, 'id' | 'askedBy' | 'taskId' | 'createdAt' | 'topic' | 'priority' | 'multiSelect' | 'text' | 'whyItMatters' | 'options' | 'defaultOptionIds' | 'defaultAssumption'>
  & { answer?: { optionIds: string[]; at: string; otherText?: string }; status?: Question['status']; appliedInSnapshot?: number | null };

export function question(input: QuestionInput): Question {
  const { answer, status, appliedInSnapshot, ...rest } = input;
  return {
    ...rest, localId: input.id.toLowerCase(), phase: 'clarify', snapshotVersion: 1,
    status: status ?? (answer ? 'answered' : 'skipped'),
    answer: answer ? { optionIds: answer.optionIds, otherText: answer.otherText ?? null, note: null, answeredAt: answer.at } : null,
    appliedInSnapshot: appliedInSnapshot === undefined ? 2 : appliedInSnapshot, relatedQuestionIds: [],
  };
}

export type ProposalBody = Omit<Proposal, 'id' | 'author' | 'taskId' | 'snapshotVersion' | 'designRound' | 'localId'>;

export function proposal(author: 'claude' | 'astra', snapshotVersion: number, body: ProposalBody): Proposal {
  return { id: `r1-${author}-1`, author, taskId: `t-r1-propose-${author}-a1`, snapshotVersion, designRound: 1, localId: 'p1', ...body };
}

export function candidate(id: string, author: 'claude' | 'astra'): Candidate {
  return { id, memberProposalIds: [`r1-${author}-1`], origin: author, representativeProposalId: `r1-${author}-1`, possibleDuplicateOf: [], invalidatedAssumptions: [] };
}

/** A score cell judged by both reviewers. A gap of 2 or more (disagreementThreshold) makes it disputed. */
export function dualCell(candidateId: string, criterionId: string, claude: number, astra: number, why: { claude: string; astra: string }): CellResult {
  const disputed = Math.abs(claude - astra) >= DECISION_PARAMS.disagreementThreshold;
  const mean = (claude + astra) / 2;
  return {
    candidateId, criterionId, kind: disputed ? 'disputed' : 'agreed',
    lo: disputed ? Math.min(claude, astra) : mean, hi: disputed ? Math.max(claude, astra) : mean, point: disputed ? null : mean,
    judgeScores: { claude, astra }, rationales: { claude: [why.claude], astra: [why.astra] },
    evidence: { claude: [{ kind: 'reasoning', ref: null, summary: `对照「${criterionName(criterionId)}」评分锚点 ${claude} 分` }], astra: [{ kind: 'reasoning', ref: null, summary: `对照「${criterionName(criterionId)}」评分锚点 ${astra} 分` }] },
  };
}

export const criterionName = (id: string) => CRITERIA.find(item => item.id === id)?.name ?? id;

export function constraintResult(candidateId: string, constraint: HardConstraint, claude: 'pass' | 'fail', astra: 'pass' | 'fail', why: { claude: string; astra: string }): ConstraintResult {
  const status = claude === astra ? claude : 'disputed';
  return { candidateId, constraintId: constraint.id, status, source: 'judges', judgeStatuses: { claude, astra }, rationales: { claude: [why.claude], astra: [why.astra] } };
}

/** Interval totals from the cells (weights from CRITERIA); `status` comes from the constraint results. */
export function totals(candidateId: string, origin: 'claude' | 'astra', cells: CellResult[], constraints: ConstraintResult[]): CandidateTotals {
  let lo = 0; let hi = 0; let known = 0; let disputedWeight = 0;
  for (const criterion of CRITERIA) {
    const cell = cells.find(item => item.candidateId === candidateId && item.criterionId === criterion.id);
    if (!cell) continue;
    lo += criterion.weight * cell.lo;
    hi += criterion.weight * cell.hi;
    if (cell.kind === 'disputed') disputedWeight += criterion.weight;
    else known += criterion.weight * (cell.point ?? cell.lo);
  }
  const own = constraints.filter(item => item.candidateId === candidateId);
  const failed = own.filter(item => item.status === 'fail').map(item => item.constraintId);
  const unresolved = own.filter(item => item.status === 'disputed' || item.status === 'unknown').map(item => item.constraintId);
  const round = (value: number) => Number(value.toFixed(3));
  return {
    candidateId, origin, status: failed.length ? 'eliminated' : unresolved.length ? 'conditional' : 'viable',
    lo: round(lo), hi: round(hi), knownScore: round(known), unknownWeight: 0, disputedWeight: round(disputedWeight),
    preferenceEligible: !failed.length && !unresolved.length, eliminatedBy: failed, unresolvedConstraints: unresolved,
  };
}

export function judgment(judge: 'claude' | 'astra', proposalId: string, anonymousId: string, input: Pick<Judgment, 'constraintChecks' | 'objections' | 'strengths'>): Judgment {
  return { judge, taskId: `t-r1-review-${judge}-a1`, designRound: 1, proposalId, anonymousId, scores: [], ...input };
}

// ---------------------------------------------------------------- gates and jobs

export function gate(id: GateRecord['id'], openedAt: string, resolvedAt: string | null, resolution: Record<string, unknown> | null, context: Record<string, unknown> = {}): GateRecord {
  return { id, openedAt, resolvedAt, resolution: resolution ? { gate: id, ...resolution } : null, context };
}

/** Effort hint the server derives for a G2 spec (src/orchestrator/state.ts). */
export function effortFor(workstreams: { dependsOn: string[] }[]): { effort: 'max' | 'ultra'; reason: string } {
  const independent = workstreams.filter(item => item.dependsOn.length === 0).length;
  return workstreams.length >= 2 && independent >= 2
    ? { effort: 'ultra', reason: `计划中有 ${independent} 个互不依赖的工作流，适合 Ultra（子代理并行）` }
    : { effort: 'max', reason: '单一工作流（或工作流相互依赖），使用 Max' };
}

// ---------------------------------------------------------------- bundle

/** One file of a job workspace. `zipOf` builds a real zip of the listed sibling paths when it is downloaded. */
export interface DemoFile { path: string; content?: string; zipOf?: string[] }

export interface ChecklistItem { ok: boolean; text: string; note: string }
export interface TraceItem {
  requirementId: string; requirementName: string; decision: string; featureIds: string[]; acIds: string[];
  mvpItems: { specRef: string; specAcceptanceId: string; acId: string; exec: { status: string; evidence: string; state: 'pass' | 'fail' | 'not_observed' | 'awaiting' | 'not_run' } }[];
}

/**
 * Scripted live progress of a running run: the lines it cycles through, each for one running task. A text that
 * contains {tokens} gets a growing token estimate (the format liveMetrics in the product parses).
 */
export interface LiveScript {
  /** Real-time delay range between two events in demo milliseconds (scaled by mock/clock.ts). */
  intervalMs: [number, number];
  lines: { taskId: string; kind: ProgressEntry['kind']; text: string }[];
}

/** Everything the run mock serves for one run. */
export interface RunBundle {
  run: Run;
  /** Progress history per task id, replayed on every new event stream. */
  trails: Record<string, ProgressEntry[]>;
  /** Markdown body per document version, keyed `${kind}/${version}`. */
  docs: Partial<Record<`${DocKind}/${number}`, string>>;
  prd?: { checklist: ChecklistItem[]; traceability: TraceItem[] };
  /** Workspace files per job id. */
  files: Record<string, DemoFile[]>;
  /** Tool log (tool-log.json) per build task id. */
  toolLogs?: Record<string, { seq: number; type: string; command: string | null; exitCode: number | null; output: string | null; status: string | null; paths: string[] }[]>;
  live?: LiveScript;
}

/** A ValidationJob budget block for a job with one settled writer call. */
export function settledBudget(taskId: string, startedAt: string, endedAt: string): NonNullable<ValidationJob['budget']> {
  const activeMs = spanMs(startedAt, endedAt);
  return {
    limits: { maxRounds: BUILD.maxRounds, maxWriterSessions: BUILD.maxWriterSessions, maxModelCalls: BUILD.maxModelCalls, maxActiveMinutes: BUILD.maxActiveMinutes },
    usage: { buildRounds: 1, writerSessions: 1, modelCalls: 1, activeMs }, reservedCalls: [], reservedWriterSessions: [], exhaustedReason: null,
    calls: [{ id: 'call-1', taskId, kind: 'initial', writer: true, state: 'settled', startedAt, endedAt, activeMs }],
  };
}
