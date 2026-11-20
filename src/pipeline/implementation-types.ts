import type { AgentTask, ChatEvent, ChatRecord } from '../chat/types.js';
import type { IntegrationResult, WorkspaceChanges } from '../chat/workspace.js';
import type { WorkspaceToolIdentity } from '../chat/gateway.js';
import type { ExecWorkspace } from '../exec/types.js';

export type MilestoneOwner = 'sol' | 'opus';

export interface MilestoneCheck {
  id: string;
  acceptanceIds: string[];
  argv: string[];
  cwd: string;
  timeoutMs: number;
}

export interface MilestoneDefinition {
  id: string;
  title: string;
  owner: MilestoneOwner;
  acceptanceIds: string[];
  dependsOn: string[];
  paths: string[];
  checks: MilestoneCheck[];
}

export interface ImplementationPlan {
  version: 1;
  contractHash: string;
  milestones: MilestoneDefinition[];
}

export interface MilestoneCandidate {
  authorTaskId: string;
  workspaceId: string;
  workspaceVersion: number;
  baselineSnapshotId: string;
  snapshotId: string;
  fingerprint: string;
  diffHash: string;
  changes: WorkspaceChanges;
}

export interface MilestoneProof {
  checkId: string;
  ref: string;
  hash: string;
  snapshotId: string;
  fingerprint: string;
  ok: boolean;
}

export interface ReviewDefect {
  id: string;
  description: string;
  acceptanceIds: string[];
}

export interface PipelineReview {
  subjectHash: string;
  reviewerTaskId: string;
  reviewer: MilestoneOwner;
  reviewerModel: string;
  reviewerFamily: string;
  author: MilestoneOwner;
  authorModel: string;
  authorFamily: string;
  outcome: 'passed' | 'failed';
  defects: ReviewDefect[];
  checks: MilestoneProof[];
}

export interface PipelinePlanProposal {
  plan: ImplementationPlan;
  ref: string;
  hash: string;
  reviewTaskId: string;
  authorTaskId?: string;
  refinesMilestone?: string;
  review?: PipelineReview;
}

export interface MilestoneAttempt {
  number: number;
  authorTaskId: string;
  candidate?: MilestoneCandidate;
  reviewerTaskId?: string;
  review?: PipelineReview;
  integration?: IntegrationResult;
  integrationCommit?: string;
  checks?: MilestoneProof[];
  verificationInvocationId?: string;
  interruptedChecks?: MilestoneProof[][];
  reason?: string;
  commit?: string;
  drift?: { issues: string[]; taskId?: string; verdict?: 'aligned' | 'suspect' };
}

export interface MilestoneProgress {
  id: string;
  status: 'ready' | 'authoring' | 'reviewing' | 'integrating' | 'verifying' | 'complete' | 'blocked';
  attempts: MilestoneAttempt[];
  suspectStreak?: number;
}

export interface ImplementationState {
  version: 1;
  round: number;
  rootTaskId: string;
  solTaskId?: string;
  proposals: PipelinePlanProposal[];
  prepared?: true;
  stateFileHash?: string;
  decisionsFileHash?: string;
  handoffFileHash?: string;
  baselineCommit?: string;
  planHash?: string;
  milestones: MilestoneProgress[];
  acceptance?: { taskId: string; checks: MilestoneProof[]; manualIds: string[] };
  trace?: { ref: string; hash: string; artifactId: string };
  /** Durable write-ahead intent for program-owned workspace mirrors and their exact chat event. */
  mirrorIntent?: PipelineMirrorIntent;
  error?: string;
}

export type PipelineMirrorEventInput = Omit<ChatEvent, 'seq' | 'chatId' | 'at'>;

export interface PipelineMirrorIntentFile extends ManagedPipelineFile {
  desiredHash: string;
}

export interface PipelineMirrorIntent {
  version: 1;
  id: string;
  taskId: string;
  files: PipelineMirrorIntentFile[];
  event?: PipelineMirrorEventInput;
  receiptHash: string;
}

export type PipelineTaskBinding =
  | { kind: 'implementation-lead' | 'implementation-sol' }
  | { kind: 'plan-review'; subjectHash: string; subjectRef: string }
  | { kind: 'milestone-author'; milestoneId: string; attempt: number; paths: string[]; baselineSnapshotId?: string; editSnapshotId?: string;
      exitSnapshot?: { invocationId: string; snapshotId: string; fingerprint: string }; started?: true }
  | { kind: 'milestone-review'; milestoneId: string; attempt: number; subjectHash: string; subjectRef: string; snapshotId: string }
  | { kind: 'alignment'; milestoneId: string; attempt: number }
  | { kind: 'product-review' };

export interface ManagedPipelineFile {
  path: string;
  text: string;
  /** Replace only an exact program-owned prior revision. */
  expectedHash?: string;
}

/** Trusted workspace hooks called by the workflow, never exposed to model-supplied paths. */
export interface PipelineWorkspaceHost {
  writePipelineFiles(chat: ChatRecord, task: AgentTask, files: readonly ManagedPipelineFile[]): void;
  prepareMilestoneAuthor(identity: WorkspaceToolIdentity): void;
  freezeMilestoneCandidate(chat: ChatRecord, task: AgentTask): MilestoneCandidate;
  inspectMilestonePaths(chat: ChatRecord, task: AgentTask): WorkspaceChanges;
  integrateMilestone(chat: ChatRecord, task: AgentTask, candidate: MilestoneCandidate, paths: readonly string[]): IntegrationResult;
  prepareVerification(chat: ChatRecord, task: AgentTask): ExecWorkspace;
  commitMilestone(chat: ChatRecord, task: AgentTask, input: { snapshotId: string; paths: readonly string[]; message: string }): string;
}
