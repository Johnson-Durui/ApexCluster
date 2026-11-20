/** 新聊天与旧 Run 流程分离；逻辑任务跨模型调用段继续存在。 */
import type { ProjectExport } from '../artifacts/project-output.js';
import type { ModelSpec, ProviderRequestHooks, ProviderUsage } from '../providers/types.js';
import type { ApiBudget } from './api-run-settings.js';
import type { FanoutGroup } from './fanout.js';
import type { TaskExecJob } from '../exec/types.js';
import type { PipelineState } from '../pipeline/state.js';
import type { FrozenApiRoster, PhaseId } from './roster.js';
export type CliChatRole = 'claude' | 'astra' | 'sol' | 'grok';
/** An API seat ID or one of the four established CLI roles. */
export type ChatRole = string;
export type RotationReason = 'soft' | 'hard' | 'yield' | 'wait' | 'time' | 'actions' | 'crash';
export type TaskStatus = 'queued' | 'running' | 'waiting_user' | 'waiting_children' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type InvocationStatus = 'running' | 'exited' | 'exit_unknown';
export type DriverFailurePhase = 'pre_dispatch' | 'post_dispatch';
/** Exact host observation of a completed tool call, staged until the next API response. */
export interface ToolReceiptDelivery {
  id: string;
  name: string;
  ref: string;
  hash: string;
  bytes: number;
  terminal?: true;
  delivered?: true;
}
/** One immutable whole-note version. Only the latest version is shown to the model by default. */
export interface TaskNoteVersion {
  version: number;
  invocationId: string;
  ref: string;
  hash: string;
  bytes: number;
}
export interface ChatMessage {
  id: string; seq: number; role: 'user' | 'assistant' | 'system'; text: string;
  auto?: true;
  pipelineGate?: { id: 'A' | 'B'; revision: number; decision: 'confirm' | 'revise' | 'cancel' };
  createdAt: string; turnId?: string; taskId?: string; clientMessageId?: string;
  attachmentIds?: string[];
  /** Durable send intent: recovery may enqueue only if no invocation ever started. */
  accepted?: true;
}
export interface ChatAttachment {
  id: string; name: string; bytes: number; hash: string; mime: string; createdAt: string;
  source: 'upload' | 'generated'; taskId?: string; invocationId?: string;
  clientUploadId?: string; messageIds?: string[]; inputHashes?: string[];
  projectExport?: ProjectExport;
}
export interface PlanStep {
  id: string; taskId: string; text: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  dependsOn: string[]; linkedTaskIds: string[]; evidenceRefs: string[]; updatedAt: string;
  verification?: { kind: 'artifact' | 'tool' | 'task'; name?: string; toolName?: string };
}
export interface ResultReadPage {
  ref: string; hash: string; offset: number; next: number | null;
  workspaceId: string | null; workspaceVersion: number | null; sourceRevision: number | null; baselineAuthority: string;
  coverageIndex: number; firstInvocationId: string; firstToolCallId: string;
  /** Trusted compact metadata extracted only from a fully delivered, registered runner receipt. */
  runnerEvidence?: RunnerEvidenceMetadata;
}
export interface RunnerEvidenceMetadata {
  ok: boolean; platform: 'windows' | 'linux'; sourceSnapshotId: string; sourceFingerprint: string;
  testSnapshotId?: string; exitCode: number | null; timedOut: boolean; cancelled: boolean;
  spawnError: string | null; processExitConfirmed: true; bodyFirstInvocationId: string; bodyFirstToolCallId: string;
}
export interface ChatStream {
  invocationId: string; taskId: string; role: ChatRole; text: string;
  status: InvocationStatus;
}
export interface ChatTurn { id: string; rootTaskId: string; status: TaskStatus; createdAt: string; completedAt?: string }
export type ExecutionReviewOutcome = 'passed' | 'failed' | 'insufficient';
export interface ExecutionReviewAttempt {
  taskId: string; contractHash: string; evidenceHash: string; viewRef: string; viewHash: string; createdAt: string;
  /** Attached once by the host; old attempts and their bindings are never replaced. */
  review?: { outcome: ExecutionReviewOutcome; stepVerdicts: { stepId: string; outcome: ExecutionReviewOutcome }[];
    reportArtifactId: string; reportHash: string; submittedAt: string };
}
export interface AgentTask {
  id: string; turnId: string; parentTaskId?: string; role: ChatRole; goal: string;
  phase?: PhaseId;
  groupId?: string;
  clusterId?: string;
  clusterReadTaskIds?: string[];
  pipelineWork?: import('../pipeline/implementation-types.js').PipelineTaskBinding;
  /** Provider family used to freeze a provider-dependent pool binding. */
  poolProvider?: string;
  reductionLevel?: number;
  interruptionSafe?: true;
  notes?: TaskNoteVersion[];
  errorCode?: string;
  status: TaskStatus; createdAt: string; updatedAt: string; segment: number;
  result?: string; resultRef?: string; resultHash?: string; error?: string; disposition?: 'adopted' | 'rejected' | 'reference';
  invocationIds: string[]; noProgressSegments: number; checkpointId?: string;
  workspaceId?: string; workspaceVersion?: number; mode: 'read' | 'edit' | 'verify';
  evidenceHashes?: string[];
  /** Deduplicated evidence pages read across segments; not objective completion evidence or prompt material. */
  evidenceReadCoverage?: string[];
  /** Full task-local delivery ledger; only a compact tail is exposed to model context. */
  resultReadPages?: ResultReadPage[];
  sourceCoverage?: Record<string, number[]>;
  sourceCoverageHashes?: Record<string, string>;
  /** Host-latched when fixed original text would exceed the actual material budget. */
  sourcePagingRequired?: true;
  /** New production roots only. Missing means legacy; recovery must never add it. */
  executionPolicyVersion?: 1;
  executionReviewRequired?: true;
  executionReviewAttempts?: ExecutionReviewAttempt[];
  /** Only set by root Claude's explicit execution_review delegation. */
  executionReviewOfTaskId?: string;
  profileId?: 'general' | 'document' | 'spreadsheet' | 'presentation' | 'research' | 'image';
}
export interface Invocation {
  id: string; taskId: string; segment: number; status: InvocationStatus;
  startedAt: string; endedAt?: string; toolCount: number; promptVersion: string;
  inputEstimate: number; contextWindow: number | null; contextUsed: number | null;
  contextHard?: number;
  exitConfirmed?: boolean; finishReason?: string;
  failureMessage?: string; failurePhase?: DriverFailurePhase;
  streamRef?: string;
  capabilitySnapshot?: string;
  capabilitySnapshotRef?: string;
  model?: string;
  effort?: string;
  peakUsed?: number;
  rotationReason?: RotationReason;
  handoffRef?: string;
  handoffHash?: string;
  handoffStateRef?: string;
  handoffStateHash?: string;
  toolReceiptDeliveries?: ToolReceiptDelivery[];
  usage?: Omit<ProviderUsage, 'type'>;
  budgetReservation?: { tokens: number; usd: number | null; started?: true };
}
export interface WaitTicket {
  id: string; taskId: string; invocationId: string; type: 'user' | 'children' | 'tool';
  question?: string; options?: string[]; childIds?: string[]; groupId?: string; status: 'pending' | 'resolved' | 'cancelled';
  clusterId?: string;
  budget?: { requestedTokens: number; requestedUsd: number | null };
  createdAt: string; resolvedAt?: string; answer?: string;
  /** User answers reference their original message; older tickets may lack this link. */
  answerMessageId?: string;
  externalId?: string; resultRef?: string;
  processStatus?: 'registered' | 'running' | 'exited' | 'exit_unknown' | 'not_started';
}
export interface ChatArtifact {
  id: string; taskId: string; name: string; relativePath: string; hash: string; bytes: number;
  kind: 'file' | 'diff' | 'test' | 'report'; createdAt: string;
  provenance?: 'model' | 'workspace' | 'runner';
  fileId?: string; mime?: string; inputHashes?: string[]; invocationId?: string;
  binding?: { beforeSnapshotId: string; afterSnapshotId: string };
  projectExport?: ProjectExport;
}
export interface ProgramDiffArtifact {
  name: string; text: string; kind: 'diff';
  binding: { beforeSnapshotId: string; afterSnapshotId: string };
}
export interface Checkpoint {
  id: string; taskId: string; invocationId: string; createdAt: string;
  goal: string; constraintMessageIds: string[]; taskStates: { id: string; status: TaskStatus }[];
  pendingTicketIds: string[]; artifactIds: string[]; next: string; note?: string;
  done?: string[];
  unverified?: string[];
  risks?: string[];
}
export interface ChatRecord {
  version: 1; id: string; title: string; createdAt: string; updatedAt: string;
  /** For API chats only. Older CLI chat records have no roster snapshot. */
  apiRoster?: FrozenApiRoster;
  fanoutGroups?: FanoutGroup[];
  apiBudget?: ApiBudget;
  apiUsage?: { tokens: number; usd: number; unpriced: number };
  apiUnresolvedUsage?: { tokens: number; usd: number; unpriced: number };
  execJobs?: TaskExecJob[];
  pipeline?: PipelineState;
  workspaceId?: string; seq: number; messageSeq: number;
  turns: ChatTurn[]; tasks: AgentTask[]; invocations: Invocation[];
  tickets: WaitTicket[]; artifacts: ChatArtifact[]; checkpoints: Checkpoint[];
  /** 完整用户原文放在消息存储；这里只保留来源，不让模型摘要覆盖。 */
  constraintMessageIds: string[]; blockedReason?: string;
  attachments?: ChatAttachment[];
  todos?: PlanStep[]; planRevision?: number;
  /** Monotonic authoritative source epoch per turn; survives WorkspaceGateway reconstruction. */
  sourceRevisions?: Record<string, number>;
  acceptedMessageIds?: string[];
  unsafeProcesses?: { id: string; kind: 'runner' | 'capability'; taskId: string; reason: string }[];
  toolResults?: { taskId: string; invocationId: string; ref: string; hash: string; bytes: number; name?: string; toolNumber?: number; provenance?: 'tool' | 'workspace' | 'runner' }[];
}
export interface ChatEvent {
  seq: number; chatId: string; type: string; at: string;
  taskId?: string; parentTaskId?: string; invocationId?: string; turnId?: string;
  data: unknown;
}
export interface ToolDefinition { name: string; description: string; inputSchema: Record<string, unknown> }
export interface ToolReply { text: string; data?: unknown; stop?: 'wait' | 'rotate' | 'completed'; ticketId?: string; processExitConfirmed?: boolean; receiptId?: string }
export interface DriverInput {
  chatId: string; task: AgentTask; invocation: Invocation; directory: string;
  systemPrompt: string; prompt: string; tools: ToolDefinition[]; signal: AbortSignal;
  onText: (delta: string) => void;
  /** 已验证的窗口占用，非累计用量。 */
  onContext?: (usage: { window: number; used: number }) => void;
  /** 提交与供应商确认交付绑定的宿主状态。 */
  onReceiptsDelivered?: (ids: readonly string[]) => void;
  requestHooks?: ProviderRequestHooks;
  reserveApiRequest?: (model: ModelSpec, inputTokens: number, outputTokens: number) => boolean;
  startApiRequest?: () => void;
  settleApiRequest?: (model: ModelSpec, usage?: Omit<ProviderUsage, 'type'>) => void;
  callTool: (name: string, args: unknown) => Promise<ToolReply>;
}
export interface DriverResult {
  text: string; exitConfirmed: boolean; contextWindow?: number | null; contextUsed?: number | null;
  finishReason?: string;
}
export interface DriverCapability {
  role: ChatRole; available: boolean; reason?: string; version?: string;
  fingerprint?: string; isolationVerified: boolean;
  contextWindow?: number;
  contextHard?: number;
  model?: string;
  effort?: string;
  provider?: string;
  isolationBasis?: 'api-no-local-process';
}
export interface ChatDriver {
  capability: DriverCapability;
  invoke(input: DriverInput): Promise<DriverResult>;
}
export const CHAT_LIMITS = Object.freeze({
  grokConcurrency: 8, agentConcurrency: 3, runnerConcurrency: 2,
  batch: 32, parentOutstanding: 32, queued: 256,
  messagePage: 50, eventPage: 500, segmentEvents: 10_000, segmentBytes: 8 * 1024 * 1024,
  initialTokens: 24_000, toolText: 4_000, collectItems: 8, collectItemText: 2_000,
  collectTotalText: 8_000, toolActions: 12, invocationMs: 15 * 60_000,
  handoffMs: 5_000, noProgress: 3,
});
export const terminalTask = (s: TaskStatus): boolean => ['completed', 'failed', 'cancelled', 'interrupted'].includes(s);
