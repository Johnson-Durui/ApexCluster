import type { ToolDefinition } from '../chat/types.js';

/** Wire format. Several vendors can share the Responses format. */
export type WireProtocol = 'anthropic-messages' | 'openai-responses' | 'google-genai' | 'openai-chat';

/** Pinned provider identity, capacity and explicitly supported reasoning levels. */
export interface ModelSpec {
  id: string;
  provider: string;
  family: string;
  protocol: WireProtocol;
  baseUrl?: string;
  apiKeyEnv: string;
  contextWindow: number;
  maxInputTokens?: number;
  maxOutputTokens: number;
  efforts: string[];
  pricing?: {
    asOf: string;
    inputPerMTok: number;
    cachedInputPerMTok?: number;
    cacheWritePerMTok?: number;
    outputPerMTok: number;
    longContext?: { aboveInputTokens: number; inputMultiplier: number; outputMultiplier: number };
  };
}

export type StopReason = 'stop' | 'tool_calls' | 'max_output' | 'refusal' | 'context_overflow';

/** Input includes cached tokens, and output includes reasoning tokens. */
export type ProviderUsage = Extract<ProviderEvent, { type: 'usage' }>;
export type ProviderResponseMetadata = Extract<ProviderEvent, { type: 'response_metadata' }>;

export type ProviderEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning_summary'; delta: string }
  /** Native response echo only. Omitted fields were not returned by the provider. */
  | { type: 'response_metadata'; modelId?: string; effort?: string }
  | { type: 'tool_call'; callId: string; name: string; args: unknown }
  | { type: 'usage'; input: number; cachedInput: number; cacheWrite?: number; output: number; reasoning?: number }
  | { type: 'end'; reason: StopReason };

export interface ToolResultInput {
  callId: string;
  text: string;
  isError?: boolean;
}

export interface ProviderInput {
  text?: string;
  toolResults?: ToolResultInput[];
}

/** Request-attempt lifecycle hooks used by model-level concurrency control. */
export interface ProviderRequestHooks {
  beforeAttempt?: (signal: AbortSignal) => Promise<() => void>;
  onRateLimit?: (retryAfterMs?: number) => void;
  onSuccess?: () => void;
}

export interface ProviderSessionInit {
  model: ModelSpec;
  effort: string;
  system: string;
  tools: ToolDefinition[];
  maxOutputTokens: number;
  cacheKey: string;
  /** Allow only one inference transport attempt per send, including redirects. */
  singleAttempt?: boolean;
  providerOptions?: Record<string, unknown>;
  requestHooks?: ProviderRequestHooks;
}

export type ModelListTarget = Pick<ModelSpec, 'provider' | 'baseUrl' | 'apiKeyEnv'>;

/** One stateless request sequence with append-only, provider-native conversation history. */
export interface ProviderSession {
  send(input: ProviderInput, signal: AbortSignal): AsyncIterable<ProviderEvent>;
  /** Latest completed reply's input (including cache reads/writes) and output. */
  occupancy(): { input: number; output: number };
}

/** Opens one model window and lists model IDs visible to configured credentials. */
export interface ModelProvider {
  readonly protocol: WireProtocol;
  open(init: ProviderSessionInit): ProviderSession;
  listModels(target: ModelListTarget, signal?: AbortSignal): Promise<string[]>;
}
