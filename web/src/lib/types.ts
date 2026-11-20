import type { BuildOptions, Criterion, DecisionParams, Effort, ModelConfig, ModelRole, Run } from '../../../src/core/types';
export type * from '../../../src/core/types';
export type { RunMetrics, AggregateMetrics } from '../../../src/core/metrics';
export type { CreateRunInput, AnswerInput, G2Input, G3Input, G4Input, G5Input, GateInput, OverrideInput, FailureClass } from '../../../src/core/schemas';
export interface AppConfig {
  models: Record<'claude' | 'astra' | 'sol', ModelConfig> & Partial<Record<'grok', ModelConfig>>; criteria: Criterion[]; decision: DecisionParams;
  docWriter?: { role: Exclude<ModelRole, 'grok'>; effort: Effort; model?: string };
  preflight?: { enabled: boolean };
  build?: BuildOptions;
  evaluator?: { enabled: boolean; effort: Effort; timeoutMinutes: number };
  finalReview?: { enabled: boolean; effort: Effort; timeoutMinutes: number };
  contextBudget?: { enabled: boolean };
  chores?: { digest: boolean; qgroup: boolean };
  cursorCapabilities?: { available: boolean; reason: string; model: string; verifiedAt: string | null; cliVersion: string | null; capabilities: Record<string, boolean> | null };
  cursorWriteCapabilities?: { available: boolean; reason: string };
  limits: Record<string, number>; targetPlatform: string;
  referenceLimits: { maxDocuments: number; maxDocumentChars: number; maxTotalChars: number; maxFileBytes: number; maxZipBytes: null; maxArchiveEntries: number; maxArchives: number; maxExpandedBytes: number; maxEntryBytes: number };
}
/** 运行列表摘要。v0.4 新增的字段在旧服务上可能缺失，读取时必须有默认值。 */
export interface RunSummary {
  id: string; title: string; mode: Run['mode']; phase: Run['phase']; phaseStatus: Run['phaseStatus'];
  terminal: Run['terminal']; createdAt: string; updatedAt: string;
  writeDocs?: boolean; writePrd?: boolean;
  finalChoice?: Run['finalChoice'];
  gates?: { id: string; resolved: boolean; action: string | null }[];
  activeTasks?: { role: ModelRole; phase: string; status: string; startedAt: string | null }[];
}
export interface ProgressEntry { at: string; text: string; kind?: string }
export type ProgressMap = Record<string, ProgressEntry[]>;
export interface RunPanelProps {
  run: Run; busy: boolean; progress: ProgressMap;
  act: (suffix: string, body?: unknown) => Promise<boolean>;
  refresh: () => Promise<void>;
  error?: string;
}
