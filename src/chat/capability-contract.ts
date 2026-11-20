import type { AgentTask, ChatRecord, Invocation, ToolDefinition, ToolReply } from './types.js';

/** Providers execute one bounded tool request. Runtime alone owns plans, events and completion. */
export interface CapabilityCall {
  chat: ChatRecord;
  task: AgentTask;
  invocation: Invocation;
  toolCallId: string;
  signal: AbortSignal;
}
export interface ProducedFile { name: string; bytes: Uint8Array; mime?: string; inputHashes?: string[] }
export interface CapabilityReply extends ToolReply { files?: ProducedFile[] }
export interface CapabilityStatus {
  id: string; name: string;
  state: 'disabled' | 'unconfigured' | 'unavailable' | 'unhealthy' | 'drifted' | 'ready' | 'degraded';
  reason?: string; tools: string[]; fingerprint?: string;
}
export interface ChatCapabilityHost {
  /** A snapshot is captured before invocation; settings may only change while idle. */
  definitions(task: AgentTask): ToolDefinition[];
  call(name: string, input: unknown, context: CapabilityCall): Promise<CapabilityReply>;
  status(): Promise<CapabilityStatus[]>;
  settings?(): unknown;
  configure?(input: unknown): Promise<unknown>;
  close?(): Promise<void>;
}
