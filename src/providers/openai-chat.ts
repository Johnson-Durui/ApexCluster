import OpenAI from 'openai';
import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions/completions';
import type { CompletionUsage } from 'openai/resources/completions';
import { readApiKey, withRedactedErrors } from './redact.js';
import { fetchSingleAttempt, ProviderTransportError } from './retry.js';
import { cloneSessionInit, createProviderSession, type NativeTurn } from './session.js';
import type { ModelListTarget, ModelProvider, ProviderInput, ProviderSession, ProviderSessionInit } from './types.js';

function encode(input: ProviderInput): ChatCompletionMessageParam[] {
  if (input.text !== undefined) return [{ role: 'user', content: input.text }];
  return (input.toolResults ?? []).map(result => ({ role: 'tool', tool_call_id: result.callId, content: result.text }));
}

function normalizedUsage(value: CompletionUsage | undefined) {
  if (!value) return undefined;
  return {
    type: 'usage' as const,
    input: value.prompt_tokens,
    cachedInput: value.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWrite: value.prompt_tokens_details?.cache_write_tokens ?? 0,
    output: value.completion_tokens,
    ...(value.completion_tokens_details?.reasoning_tokens === undefined ? {} : { reasoning: value.completion_tokens_details.reasoning_tokens }),
  };
}

function errorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const direct = 'code' in error && typeof error.code === 'string' ? error.code : '';
  const nested = 'error' in error && typeof error.error === 'object' && error.error !== null &&
    'code' in error.error && typeof error.error.code === 'string' ? error.error.code : '';
  return direct || nested;
}

function mapSafetyError(error: unknown) {
  const code = errorCode(error).toLowerCase();
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (/context|token.*limit|too.*long/.test(`${code} ${message}`)) return 'context_overflow' as const;
  if (/safety|content_filter|moderation|refusal|policy|misalignment|bio/.test(`${code} ${message}`)) {
    return 'refusal' as const;
  }
  return undefined;
}

function clientFor(apiKey: string, target: Pick<ModelListTarget, 'baseUrl'>, singleAttempt = false): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL: target.baseUrl ?? 'https://api.openai.com/v1',
    organization: null,
    project: null,
    maxRetries: 0,
    fetch: singleAttempt ? fetchSingleAttempt : undefined,
    logLevel: 'off',
  });
}

/** Generic OpenAI-compatible Chat Completions adapter for community models. */
export class OpenAIChatProvider implements ModelProvider {
  readonly protocol = 'openai-chat' as const;

  open(init: ProviderSessionInit): ProviderSession {
    init = cloneSessionInit(init);
    if (init.providerOptions && Object.keys(init.providerOptions).length) {
      throw new Error('Unsupported OpenAI Chat provider option');
    }
    const apiKey = readApiKey(init.model);
    const client = clientFor(apiKey, init.model, init.singleAttempt);
    const tools = init.tools.map(tool => ({
      type: 'function' as const,
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    }));
    return createProviderSession(init, {
      apiKey,
      encode,
      mapError: mapSafetyError,
      request: async (history, signal): Promise<NativeTurn<ChatCompletionMessageParam>> => {
        const body: ChatCompletionCreateParamsStreaming = {
          model: init.model.id,
          messages: [{ role: 'developer', content: init.system }, ...history],
          max_completion_tokens: init.maxOutputTokens,
          reasoning_effort: init.effort as ChatCompletionCreateParamsStreaming['reasoning_effort'],
          ...(tools.length ? { tools, parallel_tool_calls: true } : {}),
          prompt_cache_key: init.cacheKey,
          store: false,
          stream: true,
          stream_options: { include_usage: true },
        };
        const stream = await client.chat.completions.create(body, { signal, maxRetries: 0 });
        const content: string[] = [];
        const reasoning: string[] = [];
        const events: Array<{ type: 'text' | 'reasoning_summary'; delta: string }> = [];
        const refusal: string[] = [];
        let refusalSeen = false;
        const partial = new Map<number, { id: string; name: string; arguments: string }>();
        let usage: CompletionUsage | undefined;
        let finish: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call' | null = null;
        let responseModel: string | undefined;
        for await (const chunk of stream) {
          if (responseModel && responseModel !== chunk.model) throw new Error('Provider changed the response model within one stream');
          responseModel = chunk.model;
          usage = chunk.usage ?? usage;
          for (const choice of chunk.choices) {
            if (choice.index !== 0) throw new Error('Provider returned multiple chat choices');
            finish = choice.finish_reason ?? finish;
            if (choice.delta.content) {
              content.push(choice.delta.content);
              events.push({ type: 'text', delta: choice.delta.content });
            }
            if ('refusal' in choice.delta) {
              refusalSeen = true;
              if (choice.delta.refusal) refusal.push(choice.delta.refusal);
            }
            const rawDelta = choice.delta as typeof choice.delta & { reasoning_content?: string };
            if (rawDelta.reasoning_content) {
              reasoning.push(rawDelta.reasoning_content);
              events.push({ type: 'reasoning_summary', delta: rawDelta.reasoning_content });
            }
            for (const call of choice.delta.tool_calls ?? []) {
              if (call.type && call.type !== 'function') throw new Error('Provider returned unsupported custom tool call');
              const state = partial.get(call.index) ?? { id: '', name: '', arguments: '' };
              state.id += call.id ?? '';
              state.name += call.function?.name ?? '';
              state.arguments += call.function?.arguments ?? '';
              partial.set(call.index, state);
            }
          }
        }
        if (!finish) throw new ProviderTransportError('Chat completion stream closed before completion');
        if (!usage) throw new Error('Chat completion response is missing authoritative token usage');
        const calls: ChatCompletionMessageFunctionToolCall[] = [...partial.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, call]) => ({ type: 'function', id: call.id, function: { name: call.name, arguments: call.arguments } }));
        const assistant: ChatCompletionMessageParam & { reasoning_content?: string } = {
          role: 'assistant',
          content: content.join('') || null,
          ...(refusalSeen ? { refusal: refusal.join('') || null } : {}),
          ...(reasoning.length ? { reasoning_content: reasoning.join('') } : {}),
          ...(calls.length ? { tool_calls: calls } : {}),
        };
        const reason = refusal.length || finish === 'content_filter' ? 'refusal' :
          finish === 'length' ? 'max_output' : finish === 'tool_calls' ? 'tool_calls' : 'stop';
        if (finish === 'function_call' || (reason === 'stop' && calls.length)) throw new Error('Chat completion returned inconsistent tool status');
        return {
          historyItems: [assistant],
          events,
          toolCalls: reason === 'tool_calls' ? calls.map(call => ({
            type: 'tool_call',
            callId: call.id,
            name: call.function.name,
            args: JSON.parse(call.function.arguments) as unknown,
          })) : [],
          usage: normalizedUsage(usage),
          metadata: { type: 'response_metadata', ...(responseModel ? { modelId: responseModel } : {}) },
          reason,
        };
      },
    });
  }

  async listModels(target: ModelListTarget, signal?: AbortSignal): Promise<string[]> {
    const apiKey = readApiKey(target);
    return withRedactedErrors(apiKey, async () => {
      const models: string[] = [];
      for await (const model of clientFor(apiKey, target).models.list({ signal, maxRetries: 0 })) models.push(model.id);
      return models;
    });
  }
}
