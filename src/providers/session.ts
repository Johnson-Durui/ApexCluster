import { z } from 'zod';
import { assertNoKey, safeProviderError } from './redact.js';
import { providerStatus, retryRequest } from './retry.js';
import type { ProviderEvent, ProviderInput, ProviderResponseMetadata, ProviderSession, ProviderSessionInit, ProviderUsage, StopReason } from './types.js';

type DisplayEvent = Extract<ProviderEvent, { type: 'text' | 'reasoning_summary' }>;
type ToolCallEvent = Extract<ProviderEvent, { type: 'tool_call' }>;
type SafetyStop = 'refusal' | 'context_overflow';

/** A fully received response. Native output items must be supplied in their original order. */
export interface NativeTurn<Item> {
  historyItems: Item[];
  events: DisplayEvent[];
  metadata?: ProviderResponseMetadata;
  toolCalls: ToolCallEvent[];
  usage?: ProviderUsage;
  reason: StopReason;
}

/** Wire-specific encoding and decoding. Each request receives the complete native history. */
export interface NativeSessionAdapter<Item> {
  apiKey: string;
  encode(input: ProviderInput): Item[];
  request(history: readonly Item[], signal: AbortSignal): Promise<NativeTurn<Item>>;
  mapError?(error: unknown): SafetyStop | undefined;
}

export function cloneSessionInit(init: ProviderSessionInit): ProviderSessionInit {
  const { requestHooks, ...serializable } = init;
  return { ...structuredClone(serializable), ...(requestHooks ? { requestHooks } : {}) };
}

const toolResult = z.object({ callId: z.string().min(1), text: z.string(), isError: z.boolean().optional() }).strict();
const inputSchema = z.union([
  z.object({ text: z.string().min(1) }).strict(),
  z.object({ toolResults: z.array(toolResult).min(1) }).strict(),
]);
const tokenCount = z.number().int().nonnegative();
const usageSchema = z.object({
  type: z.literal('usage'),
  input: tokenCount,
  cachedInput: tokenCount,
  cacheWrite: tokenCount.optional(),
  output: tokenCount,
  reasoning: tokenCount.optional(),
}).strict().refine(value => value.cachedInput + (value.cacheWrite ?? 0) <= value.input &&
  (value.reasoning ?? 0) <= value.output);
const toolCall = z.object({
  type: z.literal('tool_call'),
  callId: z.string().min(1),
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
}).strict();
const displayEvent = z.object({ type: z.enum(['text', 'reasoning_summary']), delta: z.string() }).strict();
const responseMetadata = z.object({ type: z.literal('response_metadata'), modelId: z.string().min(1).optional(), effort: z.string().min(1).optional() }).strict();

/** Reject an unsupported model effort or output reservation before issuing a request. */
export function validateSessionInit(init: ProviderSessionInit): void {
  if (!init.model.efforts.includes(init.effort)) throw new Error('Model does not support the configured effort');
  if (!Number.isSafeInteger(init.maxOutputTokens) || init.maxOutputTokens < 1 ||
    init.maxOutputTokens > init.model.maxOutputTokens) throw new Error('Invalid model output token reservation');
  if (new Set(init.tools.map(tool => tool.name)).size !== init.tools.length) throw new Error('Duplicate provider tool name');
}

/** Same-window accounting and atomic publication of a fully received response. */
export function createProviderSession<Item>(init: ProviderSessionInit, adapter: NativeSessionAdapter<Item>): ProviderSession {
  validateSessionInit(init);
  const { apiKey } = adapter;
  assertNoKey({ model: init.model, system: init.system, tools: init.tools, cacheKey: init.cacheKey }, apiKey);
  let history: Item[] = [];
  const names = new Set(init.tools.map(tool => tool.name));
  let used = { input: 0, output: 0 };
  let pending: string[] = [];
  let running = false;
  let closed = false;

  return {
    occupancy: () => ({ ...used }),
    async *send(input, signal) {
      if (running || closed) throw new Error('Provider session is busy or closed');
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) throw new Error('Invalid provider input');
      const receipts = 'toolResults' in parsed.data ? parsed.data.toolResults : [];
      if (receipts.length !== pending.length || new Set(receipts.map(result => result.callId)).size !== pending.length ||
        receipts.some(result => !pending.includes(result.callId))) throw new Error('Tool receipts must match the previous response');

      running = true;
      try {
        signal.throwIfAborted();
        const items = adapter.encode(parsed.data);
        assertNoKey(items, apiKey);
        const requestHistory = [...history, ...items];
        const turn = await retryRequest(signal, async (): Promise<NativeTurn<Item>> => {
          try {
            return await adapter.request(requestHistory, signal);
          } catch (error) {
            const status = providerStatus(error);
            if (signal.aborted || status === 429 || (status !== undefined && status >= 500)) throw error;
            const reason = adapter.mapError?.(error);
            if (!reason) throw error;
            return { reason, historyItems: [], events: [], toolCalls: [] };
          }
        }, init.requestHooks, init.singleAttempt);
        signal.throwIfAborted();
        assertNoKey(turn, apiKey);
        const usage = turn.usage === undefined ? undefined : usageSchema.parse(turn.usage);
        if (!usage && turn.reason !== 'refusal' && turn.reason !== 'context_overflow') throw new Error('Missing authoritative token usage');
        z.array(displayEvent).parse(turn.events);
        const metadata = turn.metadata === undefined ? undefined : responseMetadata.parse(turn.metadata);
        z.array(toolCall).parse(turn.toolCalls);
        assertNoKey(['text', 'reasoning_summary'].map(type =>
          turn.events.filter(event => event.type === type).map(event => event.delta).join('')), apiKey);
        const calls = turn.toolCalls;
        const ids = calls.map(call => call.callId);
        if ((turn.reason === 'tool_calls') !== (calls.length > 0) || new Set(ids).size !== ids.length ||
          calls.some(call => !names.has(call.name))) throw new Error('Invalid provider tool call set');

        history = requestHistory.concat(turn.historyItems);
        pending = ids;
        closed = turn.reason === 'refusal' || turn.reason === 'context_overflow';
        if (usage) used = { input: usage.input, output: usage.output };
        const emitted: ProviderEvent[] = [...turn.events, ...(metadata ? [metadata] : []), ...(usage ? [usage] : []), ...calls, { type: 'end', reason: turn.reason }];
        for (const event of emitted) {
          signal.throwIfAborted();
          yield event;
        }
      } catch (error) {
        closed = true;
        throw safeProviderError(error, apiKey, signal);
      } finally {
        running = false;
      }
    },
  };
}
