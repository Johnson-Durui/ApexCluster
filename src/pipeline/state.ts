import { z } from 'zod/v4';
import type { ClusterState } from './cluster.js';
import type { ImplementationState } from './implementation-types.js';

const gateMode = z.enum(['user', 'auto']);
const gatesSchema = z.object({
  clarify: gateMode.default('user'),
  architecture: gateMode.default('user'),
  delivery: gateMode.default('user'),
}).strict();
const qualitySchema = z.object({
  crossReview: z.boolean().default(true),
  maxReworkRounds: z.number().int().min(1).max(10).default(2),
  clusterCrossRounds: z.union([z.literal(1), z.literal(2)]).default(1),
}).strict();

export const pipelineCreateSchema = z.object({
  preset: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/).default('flagship'),
  auto: z.boolean().default(false),
}).strict();

const gateAction = z.object({
  decision: z.enum(['confirm', 'revise', 'cancel']),
  feedback: z.string().trim().min(1).max(100_000).optional(),
}).strict().refine(value => value.decision !== 'revise' || value.feedback !== undefined, '请填写要修订的要求');
export const pipelineGateActionSchema = gateAction;

export type PipelineStage = 'architecture' | 'gate-a' | 'implementation' | 'acceptance' | 'gate-b' | 'completed' | 'cancelled';
export type PipelineGateId = 'A' | 'B';
export type PipelineGates = z.infer<typeof gatesSchema>;
export type PipelineQuality = z.infer<typeof qualitySchema>;

export interface PipelineContractLink {
  ref: string;
  hash: string;
  contractSha256: string;
  artifactId: string;
  revision: number;
}

export interface GateDecision {
  gateId: PipelineGateId;
  decision: z.infer<typeof gateAction>['decision'];
  messageId: string;
  automatic: boolean;
  revision: number;
}

/** Frozen run configuration and explicit workflow state for pipeline chats. */
export interface PipelineState {
  version: 1;
  preset: string;
  gates: PipelineGates;
  quality: PipelineQuality;
  stage: PipelineStage;
  revision: number;
  revisionStartedAt?: string;
  architectureTaskId?: string;
  implementationTaskId?: string;
  contract?: PipelineContractLink;
  priorContracts: PipelineContractLink[];
  /** A Demo-only repair keeps the requirements and acceptance of this frozen revision. */
  demoRepairFrom?: number;
  gateDecisions: GateDecision[];
  clusters: ClusterState[];
  /** A reviewed full cluster can be carried forward to synthesis on a Gate A revision. */
  carriedClusterId?: string;
  implementation?: ImplementationState;
  priorImplementations?: ImplementationState[];
}

export interface PipelineSettings {
  gates: PipelineGates;
  quality: PipelineQuality;
}

export function parsePipelineSettings(value: { gates?: unknown; quality?: unknown } = {}): PipelineSettings {
  return { gates: gatesSchema.parse(value.gates ?? {}), quality: qualitySchema.parse(value.quality ?? {}) };
}

export function newPipelineState(raw: unknown, settings = parsePipelineSettings()): PipelineState {
  const { preset, auto } = pipelineCreateSchema.parse(raw);
  return {
    version: 1, preset, stage: 'architecture', revision: 1, priorContracts: [], gateDecisions: [], clusters: [],
    gates: auto ? { clarify: 'auto', architecture: 'auto', delivery: 'auto' } : { ...settings.gates },
    quality: { ...settings.quality },
  };
}

export function pendingPipelineGate(state: PipelineState): PipelineGateId | undefined {
  if (state.stage === 'gate-a') return 'A';
  if (state.stage === 'gate-b') return 'B';
  return undefined;
}
