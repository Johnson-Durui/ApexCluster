/**
 * 模型适配器契约。编排器只依赖这个接口；具体接入方式（官方 CLI / SDK / App Server / 模拟）可替换。
 */
import type { JsonSchema } from '../core/strict-json-schema.js';
import type { ChoreSource } from '../core/chores.js';
import type { TaskPhase } from '../core/schemas.js';
import type { AdapterKind, BuildRound, DocKind, Effort, ExecutionMeta, FailureKind, ModelRole, MvpSpec } from '../core/types.js';
import type { ToolLogItem } from '../core/verify-mvp.js';

/** 结构化上下文：真实适配器只用于日志；模拟适配器用它生成与本次运行一致的输出 */
export interface TaskContext {
  snapshotRef: string | null;
  constraintIds: string[];
  criterionIds: string[];
  knownQuestionIds: string[];
  /** review：匿名编号 → proposalId */
  anonymousMap: Record<string, string> | null;
  /** recheck：复核条目 */
  recheckItems:
    | { id: string; kind: 'cell' | 'constraint'; anonymousId: string; criterionId: string | null; constraintId: string | null }[]
    | null;
  /** build：已确认的 MVP 规格 */
  spec: MvpSpec | null;
  /** T12：init 生成计划；milestone 生成带里程碑结果的构建报告。未提供时沿用常规 build。 */
  buildKind?: 'init' | 'milestone';
  /** T12：当前上下文构建会话及其被授权处理的里程碑。 */
  buildSession?: { id: string; milestoneIds: string[] } | null;
  /** T12：本次 milestone 会话只执行完整规格的最终验收，不修改工作区。 */
  finalVerification?: boolean;
  /** T10：digest 只能逐字引用这些受控来源。 */
  choreSources?: ChoreSource[];
  /** T10：qgroup 必须且只能覆盖这些问题编号。 */
  choreQuestionIds?: string[];
  /** T10：digest 的工作区锚点。 */
  workspaceCommit?: string | null;
  /** T10c：WSL 文件修改仅限当前 Git 锚点下已确认缺陷涉及的文件。 */
  lightRework?: { allowedFiles: string[]; workspaceCommit: string; treeHash: string; specRef: string; round: number };
  /** 文档任务；可选以兼容旧测试和调用方。 */
  docs?: DocTaskContext | null;
  mockScenario: string | null;
  /** D8：冻结的关键项与未淘汰候选，供模拟器生成合法输出 */
  adjudication?: { itemIds: string[]; candidateIds: string[] };
  buildRound?: number;
  evaluation?: { round: BuildRound; canReproduce: boolean };
  finalReview?: { rounds: BuildRound[] };
}

export interface DocTaskContext {
  kind: DocKind;
  docRef: string;
  version: number;
  title: string;
  sourceIds: string[];
  facts: { id: string; text: string }[];
  constraintIds: string[];
  candidates: {
    id: string;
    title: string;
    stack: string[];
    modules: { id: string; name: string }[];
    flows: { from: string; to: string; label: string; kind: 'call' | 'data' | 'event' }[];
    workstreams: { id: string; title: string; dependsOn: string[] }[];
  }[];
  specs: MvpSpec[];
  previous: unknown;
  previousVersion: number | null;
  revisionNotes: string | null;
}

export interface ModelTaskSpec {
  taskId: string;
  runId: string;
  role: ModelRole;
  phase: TaskPhase;
  attempt: number;
  model: string;
  effort: Effort;
  /** 完整提示词，经 stdin 传入（不拼进命令行，避免注入与长度问题） */
  prompt: string;
  outputSchema: JsonSchema;
  /** 子进程工作目录：设计阶段是空的隔离目录；构建阶段是该作业的工作区 */
  cwd: string;
  /** 设计阶段的只读参考资料目录；存在时适配器应把文件访问限制在该目录 */
  referenceDirectory?: string;
  /** 原始日志目录（stdout/stderr/events/最终消息） */
  logDir: string;
  timeoutMs: number;
  sandbox: 'read_only' | 'workspace_write';
  /** 构建阶段：沙箱内是否允许联网（npm install 等） */
  allowNetwork: boolean;
  /** 工作目录是否是 git 仓库（Codex 默认要求在 git 仓库内运行） */
  gitRepo: boolean;
  /** 设计阶段：是否允许联网检索（WebSearch/WebFetch 或 codex --search） */
  allowWeb: boolean;
  /** 修复输出时续接的会话 */
  resumeSessionId: string | null;
  context: TaskContext;
}

export type ProgressKind = 'started' | 'tool' | 'message' | 'retry' | 'usage' | 'stderr' | 'info';

export interface AdapterProgress {
  at: string;
  kind: ProgressKind;
  text: string;
}

export interface AdapterResult {
  status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
  failure: { kind: FailureKind; message: string } | null;
  /** 最终消息原文 */
  rawText: string | null;
  /** CLI 原生结构化输出（Claude 的 structured_output）；没有则 null */
  structured: unknown;
  meta: ExecutionMeta;
  /** 已完成的工具调用（命令执行、文件修改），用于 MVP 验收核验 */
  toolLog: ToolLogItem[];
  simulated: boolean;
}

export interface ModelAdapter {
  readonly kind: AdapterKind;
  run(spec: ModelTaskSpec, onProgress: (p: AdapterProgress) => void, signal: AbortSignal): Promise<AdapterResult>;
}

/** 命令覆盖：例如 { command: "%USERPROFILE%\\.local\\bin\\claude.exe" } 或测试用 { command: process.execPath, args: ["fake-claude.mjs"] } */
export interface CommandOverride {
  command: string;
  args?: string[];
}

export function emptyMeta(adapter: AdapterKind, spec: ModelTaskSpec, startedAt: string): ExecutionMeta {
  return {
    adapter,
    cliVersion: null,
    processStarted: false,
    command: [],
    cwd: spec.cwd,
    requestedModel: spec.model,
    requestedEffort: spec.effort,
    reportedModels: [],
    reportedModelSource: null,
    modelConfirmed: false,
    reportedEffort: null,
    effortConfirmed: false,
    sessionId: null,
    exitCode: null,
    startedAt,
    endedAt: startedAt,
    durationMs: 0,
    usage: null,
    costUsd: null,
    nativeSchema: false,
    scrubbedEnv: [],
    warnings: [],
  };
}

/** 请求型号是否出现在执行端报告里（允许带日期后缀，如 claude-opus-5-5-20260922） */
export function modelReported(requested: string, reported: string[]): boolean {
  return reported.some((r) => r === requested || r.startsWith(`${requested}-`));
}

/** 会静默变化的别名不允许作为“请求型号”（Claude Code 旧版本的 opus 别名会解析到旧型号） */
export const FORBIDDEN_MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'fable', 'best', 'default', 'opusplan', 'opus[1m]', 'sonnet[1m]'];
