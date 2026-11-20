import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlock,
  ContentBlockParam,
  Message,
  MessageParam,
  StopReason as AnthropicStopReason,
  Tool,
} from '@anthropic-ai/sdk/resources/messages/messages';
import { readApiKey, withRedactedErrors } from './redact.js';
import { fetchSingleAttempt, ProviderTransportError } from './retry.js';
import { cloneSessionInit, createProviderSession, type NativeTurn } from './session.js';
import type {
  ModelListTarget,
  ModelProvider,
  ProviderInput,
  ProviderSession,
  ProviderSessionInit,
  StopReason,
} from './types.js';

type NativeMessage = MessageParam;

const supportedBlocks = new Set(['text', 'thinking', 'redacted_thinking', 'tool_use']);

function client(apiKey: string, baseURL?: string, singleAttempt = false): Anthropic {
  return new Anthropic({
    apiKey, baseURL: baseURL ?? 'https://api.anthropic.com', maxRetries: 0, logLevel: 'off',
    fetch: singleAttempt ? fetchSingleAttempt : undefined,
  });
}

function encodeInput(input: ProviderInput): NativeMessage[] {
  if (input.text !== undefined) return [{ role: 'user', content: input.text }];
  return [{
    role: 'user',
    content: input.toolResults!.map(result => ({
      type: 'tool_result' as const,
      tool_use_id: result.callId,
      content: result.text,
      ...(result.isError === undefined ? {} : { is_error: result.isError }),
    })),
  }];
}

function tools(init: ProviderSessionInit): Tool[] {
  return init.tools.map(tool => {
    if (tool.inputSchema.type !== 'object') throw new Error(`Anthropic tool schema must be an object: ${tool.name}`);
    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Tool.InputSchema,
    };
  });
}

function historyContent(message: Message): ContentBlockParam[] {
  for (const block of message.content) {
    if (!supportedBlocks.has(block.type)) throw new Error(`Unsupported Anthropic content block: ${block.type}`);
  }
  return structuredClone(message.content) as ContentBlockParam[];
}

function stopReason(reason: AnthropicStopReason | null): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'pause_turn':
      throw new Error('Anthropic paused the turn before completion');
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'max_output';
    case 'refusal':
      return 'refusal';
    case 'model_context_window_exceeded':
      return 'context_overflow';
    default:
      throw new Error('Anthropic response ended without a stop reason');
  }
}

function safetyError(error: unknown): 'context_overflow' | 'refusal' | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as { type?: unknown; message?: unknown; error?: { type?: unknown } };
  const type = typeof value.type === 'string' ? value.type : value.error?.type;
  const message = typeof value.message === 'string' ? value.message : '';
  if (type === 'request_too_large' || /context window|too many tokens|request too large/i.test(message)) return 'context_overflow';
  if (type === 'refusal' || /blocked by (?:a )?safety|content[_ ]filter|policy violation/i.test(message)) return 'refusal';
  return undefined;
}

async function request(
  sdk: Anthropic,
  init: ProviderSessionInit,
  history: readonly NativeMessage[],
  signal: AbortSignal,
): Promise<NativeTurn<NativeMessage>> {
  const events: NativeTurn<NativeMessage>['events'] = [];
  let responseModel: string | undefined;
  let stopped = false;
  const stream = sdk.messages.stream({
      model: init.model.id,
      max_tokens: init.maxOutputTokens,
      messages: [...history],
      system: init.system,
      tools: tools(init),
      thinking: { type: 'adaptive' },
      output_config: { effort: init.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' },
      cache_control: { type: 'ephemeral' },
  }, { signal, maxRetries: 0 });

  try {
    for await (const event of stream) {
      if (event.type === 'message_start') responseModel = event.message.model;
      if (event.type === 'message_stop') stopped = true;
      if (event.type !== 'content_block_delta') continue;
      if (event.delta.type === 'text_delta') events.push({ type: 'text', delta: event.delta.text });
      if (event.delta.type === 'thinking_delta') {
        events.push({ type: 'reasoning_summary', delta: event.delta.thinking });
      }
    }
    if (!stopped) throw new ProviderTransportError('Anthropic stream ended before message_stop');
    const message = await stream.finalMessage();
    const cacheRead = message.usage.cache_read_input_tokens ?? 0;
    const cacheWrite = message.usage.cache_creation_input_tokens ?? 0;
    const input = message.usage.input_tokens + cacheRead + cacheWrite;
    const tools = message.content.filter((block): block is Extract<ContentBlock, { type: 'tool_use' }> =>
      block.type === 'tool_use');
  const reason = stopReason(message.stop_reason);
  if (reason === 'stop' && tools.length > 0) throw new Error('Anthropic response returned inconsistent tool status');
    return {
      historyItems: [{ role: 'assistant', content: historyContent(message) }],
      events,
    toolCalls: reason === 'tool_calls' ? tools.map(block => ({
        type: 'tool_call',
        callId: block.id,
        name: block.name,
        args: block.input,
    })) : [],
      usage: {
        type: 'usage',
        input,
        cachedInput: cacheRead,
        cacheWrite,
        output: message.usage.output_tokens,
        ...(message.usage.output_tokens_details == null
          ? {}
          : { reasoning: message.usage.output_tokens_details.thinking_tokens }),
      },
    metadata: { type: 'response_metadata', ...(responseModel ? { modelId: responseModel } : {}) },
    reason,
    };
  } catch (error) {
    if (error instanceof Error && error.message === 'request ended without sending any chunks') {
      throw new ProviderTransportError('Anthropic stream ended before a complete message', { cause: error });
    }
    throw error;
  }
}

/** Anthropic Messages adapter with exact same-window content-block replay. */
export class AnthropicProvider implements ModelProvider {
  readonly protocol = 'anthropic-messages' as const;

  open(init: ProviderSessionInit): ProviderSession {
    init = cloneSessionInit(init);
    if (init.providerOptions && Object.keys(init.providerOptions).length !== 0) {
      throw new Error('Unsupported Anthropic provider options');
    }
    const apiKey = readApiKey(init.model);
    const sdk = client(apiKey, init.model.baseUrl, init.singleAttempt);
    return createProviderSession(init, {
      apiKey,
      encode: encodeInput,
      request: (history, signal) => request(sdk, init, history, signal),
      mapError: safetyError,
    });
  }

  async listModels(target: ModelListTarget, signal?: AbortSignal): Promise<string[]> {
    const apiKey = readApiKey(target);
    const sdk = client(apiKey, target.baseUrl);
    try {
      return await withRedactedErrors(apiKey, async () => {
        signal?.throwIfAborted();
        const ids: string[] = [];
        const page = sdk.models.list({}, { signal, maxRetries: 0 });
        for await (const model of page) ids.push(model.id);
        return ids;
      });
    } catch (error) {
      if (signal?.aborted) throw new DOMException('Provider request was cancelled', 'AbortError');
      throw error;
    }
  }
}
