import OpenAI from 'openai';
import type {
  Response,
  ResponseCreateParamsStreaming,
  ResponseFunctionToolCall,
  ResponseInputItem,
} from 'openai/resources/responses/responses';
import { readApiKey, withRedactedErrors } from './redact.js';
import { fetchSingleAttempt, ProviderTransportError } from './retry.js';
import { cloneSessionInit, createProviderSession, type NativeTurn } from './session.js';
import type { ModelListTarget, ModelProvider, ProviderInput, ProviderSession, ProviderSessionInit } from './types.js';

const XAI_TIMEOUT_MS = 900_000;

/**
 * Models starting with GPT-6.2 append top-level `instructions` after `input` and bill them uncached on every request.
 * OpenAI therefore receives the stable system prompt as the leading developer message, which stays in the cached prefix.
 * Compatible endpoints keep top-level `instructions`.
 */
function systemPrefix(provider: string, system: string): ResponseInputItem[] {
  return provider === 'openai' ? [{ role: 'developer', content: system }] : [];
}

function functionOutput(input: ProviderInput): ResponseInputItem[] {
  if (input.text !== undefined) return [{ role: 'user', content: input.text }];
  return (input.toolResults ?? []).map(result => ({
    type: 'function_call_output',
    call_id: result.callId,
    output: result.text,
    status: result.isError ? 'incomplete' : 'completed',
  }));
}

function usage(response: Response) {
  if (!response.usage) return undefined;
  const inputDetails = response.usage.input_tokens_details;
  const outputDetails = response.usage.output_tokens_details;
  return {
    type: 'usage' as const,
    input: response.usage.input_tokens,
    cachedInput: inputDetails?.cached_tokens ?? 0,
    cacheWrite: inputDetails?.cache_write_tokens ?? 0,
    output: response.usage.output_tokens,
    ...(outputDetails?.reasoning_tokens === undefined ? {} : { reasoning: outputDetails.reasoning_tokens }),
  };
}

function refusalOutput(response: Response): boolean {
  return response.output.some(item => item.type === 'message' && item.content.some(part => part.type === 'refusal'));
}

function reason(response: Response, hasTools: boolean, refused: boolean) {
  if (refused || response.incomplete_details?.reason === 'content_filter') return 'refusal' as const;
  if (response.status === 'incomplete') return 'max_output' as const;
  if (response.status !== 'completed') throw new Error('Invalid terminal Responses status');
  return hasTools ? 'tool_calls' as const : 'stop' as const;
}

function decode(
  response: Response,
  events: Array<{ type: 'text' | 'reasoning_summary'; delta: string }>,
  refused: boolean,
): NativeTurn<ResponseInputItem> {
  const calls = response.output.filter((item): item is ResponseFunctionToolCall => item.type === 'function_call');
  const stop = reason(response, calls.length > 0, refused || refusalOutput(response));
  return {
    historyItems: response.output as unknown as ResponseInputItem[],
    events,
    toolCalls: stop === 'tool_calls' ? calls.map(call => {
      if (call.status !== undefined && call.status !== 'completed') throw new Error('Provider returned an unfinished tool call');
      return { type: 'tool_call' as const, callId: call.call_id, name: call.name, args: JSON.parse(call.arguments) as unknown };
    }) : [],
    usage: usage(response),
    metadata: {
      type: 'response_metadata',
      modelId: response.model,
      ...(response.reasoning?.effort == null ? {} : { effort: response.reasoning.effort }),
    },
    reason: stop,
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

function responseFailure(code: string | null | undefined, message: string): Error {
  const error = Object.assign(new Error(message), { code });
  if (code === 'rate_limit_exceeded') return Object.assign(error, { status: 429 });
  if (code === 'server_error') return Object.assign(error, { status: 500 });
  return error;
}

function clientFor(apiKey: string, target: Pick<ModelListTarget, 'baseUrl' | 'provider'>, singleAttempt = false): OpenAI {
  const baseURL = target.baseUrl ?? (target.provider === 'xai' ? 'https://api.x.ai/v1' :
    target.provider === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.openai.com/v1');
  return new OpenAI({
    apiKey,
    baseURL,
    organization: null,
    project: null,
    maxRetries: 0,
    fetch: singleAttempt ? fetchSingleAttempt : undefined,
    logLevel: 'off',
    timeout: target.provider === 'xai' ? XAI_TIMEOUT_MS : undefined,
  });
}

/** Stateless Responses adapter for OpenAI and compatible xAI/DeepSeek endpoints. */
export class OpenAIResponsesProvider implements ModelProvider {
  readonly protocol = 'openai-responses' as const;

  open(init: ProviderSessionInit): ProviderSession {
    init = cloneSessionInit(init);
    if (init.providerOptions && Object.keys(init.providerOptions).length) {
      throw new Error('Unsupported OpenAI Responses provider option');
    }
    const apiKey = readApiKey(init.model);
    const client = clientFor(apiKey, init.model, init.singleAttempt);
    const provider = init.model.provider;
    const prefix = systemPrefix(provider, init.system);
    const tools = init.tools.map(tool => ({
      type: 'function' as const,
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: false,
    }));

    return createProviderSession(init, {
      apiKey,
      encode: functionOutput,
      mapError: mapSafetyError,
      request: async (history, signal) => {
        const body: ResponseCreateParamsStreaming = {
          model: init.model.id,
          input: [...prefix, ...history],
          ...(prefix.length ? {} : { instructions: init.system }),
          max_output_tokens: init.maxOutputTokens,
          reasoning: {
            effort: init.effort as NonNullable<ResponseCreateParamsStreaming['reasoning']>['effort'],
            ...(provider === 'openai' ? { summary: 'auto' as const } : {}),
          },
          ...(tools.length ? { tools, parallel_tool_calls: true } : {}),
          stream: true,
          ...(provider === 'deepseek' ? {} : {
            store: false,
            include: ['reasoning.encrypted_content' as const],
            prompt_cache_key: init.cacheKey,
          }),
        };
        const stream = await client.responses.create(body, { signal, maxRetries: 0 });
        const events: Array<{ type: 'text' | 'reasoning_summary'; delta: string }> = [];
        let refused = false;
        let complete: Response | undefined;
        for await (const event of stream) {
          if (event.type === 'response.output_text.delta') events.push({ type: 'text', delta: event.delta });
          if (event.type === 'response.reasoning_summary_text.delta') {
            events.push({ type: 'reasoning_summary', delta: event.delta });
          }
          if (event.type === 'response.refusal.delta') refused = true;
          if (event.type === 'response.completed' || event.type === 'response.incomplete') complete = event.response;
          if (event.type === 'response.failed') {
            throw responseFailure(event.response.error?.code, event.response.error?.message ?? 'Provider response failed');
          }
          if (event.type === 'error') throw responseFailure(event.code, event.message);
        }
        if (!complete) throw new ProviderTransportError('OpenAI-compatible response stream closed before completion');
        return decode(complete, events, refused);
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
