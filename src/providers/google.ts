import { GoogleGenAI, type Interactions } from '@google/genai';
import { readApiKey, withRedactedErrors } from './redact.js';
import { fetchSingleAttempt, ProviderTransportError } from './retry.js';
import { cloneSessionInit, createProviderSession, type NativeSessionAdapter, type NativeTurn } from './session.js';
import type { ModelListTarget, ModelProvider, ProviderInput, ProviderSession, ProviderSessionInit, ProviderUsage } from './types.js';

type Step = Interactions.Step;
type Usage = NonNullable<Interactions.Interaction['usage']>;

function client(apiKey: string, baseUrl?: string, singleAttempt = false): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    vertexai: false,
    apiVersion: 'v1',
    httpOptions: {
      baseUrl: baseUrl ?? 'https://generativelanguage.googleapis.com', retryOptions: { attempts: 1 },
      fetch: singleAttempt ? fetchSingleAttempt : undefined,
    },
  });
}

function encode(input: ProviderInput): Step[] {
  if (input.text !== undefined) return [{ type: 'user_input', content: [{ type: 'text', text: input.text }] }];
  return input.toolResults!.map(result => ({
    type: 'function_result', call_id: result.callId, result: result.text,
    ...(result.isError === undefined ? {} : { is_error: result.isError }),
  }));
}

function providerUsage(usage: Usage): ProviderUsage {
  const input = usage.total_input_tokens;
  const cachedInput = usage.total_cached_tokens ?? 0;
  const reasoning = usage.total_thought_tokens ?? 0;
  const visibleOutput = usage.total_output_tokens;
  if (![input, cachedInput, reasoning, visibleOutput].every(value => Number.isSafeInteger(value) && value! >= 0)) {
    throw new Error('Google response is missing authoritative token usage');
  }
  return { type: 'usage', input: input!, cachedInput, output: visibleOutput! + reasoning,
    ...(usage.total_thought_tokens === undefined ? {} : { reasoning }) };
}

function textFromContent(content: Interactions.Content | undefined): string {
  return content?.type === 'text' ? content.text : '';
}

function pushText(step: Step, text: string): void {
  if (!text || step.type !== 'model_output') return;
  const contents = step.content ??= [];
  const last = contents.at(-1);
  if (last?.type === 'text') last.text += text;
  else contents.push({ type: 'text', text });
}

function applyDelta(step: Step, delta: Interactions.StepDelta['delta'], argumentsText: Map<number, string>, index: number): void {
  if (delta.type === 'text') pushText(step, delta.text);
  else if (delta.type === 'thought_summary' && delta.content && step.type === 'thought' &&
    (delta.content.type === 'text' || delta.content.type === 'image')) (step.summary ??= []).push(delta.content);
  else if (delta.type === 'thought_signature' && step.type === 'thought') step.signature = delta.signature;
  else if (delta.type === 'arguments_delta' && step.type === 'function_call') {
    argumentsText.set(index, (argumentsText.get(index) ?? '') + (delta.arguments ?? ''));
  }
}

function finishStep(step: Step, argumentsText: Map<number, string>, index: number): Step {
  const text = argumentsText.get(index);
  if (text !== undefined && step.type === 'function_call') {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Invalid Google function arguments');
    step.arguments = parsed as Record<string, unknown>;
  }
  return step;
}

function normalizeError(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || 'status' in error) return error;
  if ('statusCode' in error && typeof error.statusCode === 'number') {
    return Object.assign(new Error(error instanceof Error ? error.message : 'Google provider request failed'), {
      status: error.statusCode,
      ...('headers' in error ? { headers: error.headers } : {}),
    });
  }
  return error;
}

function mapError(error: unknown): 'refusal' | 'context_overflow' | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
  const text = `${code} ${error.message}`.replace(/[_-]/g, ' ');
  if (/context (?:window|length|overflow)|token limit|prompt.*too (?:large|long)|resource exhausted.*token/i.test(text)) return 'context_overflow';
  if (/safety|content filter|prohibited content|policy violation|refusal/i.test(text)) return 'refusal';
  return undefined;
}

function interactionError(details: Interactions.ErrorEvent['error']): Error {
  const code = details?.code;
  const error = Object.assign(new Error(details?.message ?? 'Google interaction failed'), { code });
  if (mapError(error)) return error;
  const type = code?.split(/[/#:]/).filter(Boolean).at(-1)?.toLowerCase().replace(/-/g, '_');
  if (type && /^\d{3}$/.test(type)) return Object.assign(error, { status: Number(type) });
  if (type && ['rate_limit_exceeded', 'rate_limit_error', 'resource_exhausted', 'too_many_requests'].includes(type)) {
    return Object.assign(error, { status: 429 });
  }
  if (type && ['internal', 'internal_error', 'server_error', 'unavailable', 'service_unavailable', 'deadline_exceeded'].includes(type)) {
    return Object.assign(error, { status: 503 });
  }
  return error;
}

function terminalFailure(status: string, steps: readonly Step[]): Error | undefined {
  if (status !== 'failed' && status !== 'cancelled' && status !== 'budget_exceeded') return undefined;
  const details = steps
    .filter((step): step is Interactions.ModelOutputStep => step.type === 'model_output' && step.error !== undefined)
    .map(step => JSON.stringify(step.error))
    .join(' ');
  return new Error(`Google interaction ended with status ${status}${details ? `: ${details}` : ''}`);
}

function providerTools(init: ProviderSessionInit): Interactions.Function[] {
  return init.tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema }));
}

function adapter(init: ProviderSessionInit, apiKey: string): NativeSessionAdapter<Step> {
  const ai = client(apiKey, init.model.baseUrl, init.singleAttempt);
  return {
    apiKey,
    encode,
    mapError,
    async request(history, signal): Promise<NativeTurn<Step>> {
      const events: NativeTurn<Step>['events'] = [];
      const currentSteps = new Map<number, Step>();
      const argumentsText = new Map<number, string>();
      const stoppedIndexes = new Set<number>();
      let completedSteps: Step[] | undefined;
      let usage: ProviderUsage | undefined;
      let finalStatus: string | undefined;
      let responseModel: string | undefined;
      try {
        const stream = await ai.interactions.create({
          model: init.model.id,
          input: [...history],
          system_instruction: init.system,
          tools: providerTools(init),
          generation_config: {
            max_output_tokens: init.maxOutputTokens,
            thinking_level: init.effort,
            thinking_summaries: 'auto',
          },
          store: false,
          stream: true,
          automatic_continuation: false,
        }, { signal, maxRetries: 0 });

        for await (const event of stream) {
          signal.throwIfAborted();
          if (event.event_type === 'error') throw interactionError(event.error);
          if (event.event_type === 'step.start') currentSteps.set(event.index, structuredClone(event.step));
          if (event.event_type === 'step.delta') {
            const step = currentSteps.get(event.index);
            if (!step) throw new ProviderTransportError('Google stream delta arrived before step start');
            applyDelta(step, event.delta, argumentsText, event.index);
            if (event.delta.type === 'text' && event.delta.text) events.push({ type: 'text', delta: event.delta.text });
            if (event.delta.type === 'thought_summary') {
              const text = textFromContent(event.delta.content);
              if (text) events.push({ type: 'reasoning_summary', delta: text });
            }
          }
          if (event.event_type === 'step.stop') {
            const step = currentSteps.get(event.index);
            if (!step) throw new ProviderTransportError('Google stream stopped an unknown step');
            finishStep(step, argumentsText, event.index);
            stoppedIndexes.add(event.index);
          }
          if (event.event_type === 'interaction.completed') {
            responseModel = event.interaction.model;
            completedSteps = event.interaction.steps ?? [...currentSteps.entries()]
              .filter(([index]) => stoppedIndexes.has(index))
              .sort(([left], [right]) => left - right)
              .map(([index, step]) => finishStep(step, argumentsText, index));
            if (event.interaction.usage) usage = providerUsage(event.interaction.usage);
            finalStatus = event.interaction.status;
          }
        }
      } catch (error) {
        throw normalizeError(error);
      }

      if (!finalStatus || !completedSteps) throw new ProviderTransportError('Google response stream ended before completion');
      const failure = terminalFailure(finalStatus, completedSteps);
      if (failure) {
        const reason = mapError(failure);
        if (!reason) throw failure;
        return { historyItems: completedSteps, events, toolCalls: [], usage, reason };
      }
      if (!usage) throw new Error('Google response is missing authoritative token usage');
      const toolCalls = completedSteps
        .filter((step): step is Interactions.FunctionCallStep => step.type === 'function_call')
        .map(step => ({ type: 'tool_call' as const, callId: step.id, name: step.name, args: step.arguments }));
      const reason = finalStatus === 'requires_action' ? 'tool_calls' :
        finalStatus === 'incomplete' || finalStatus === 'requires_continuation' ? 'max_output' : 'stop';
      if (reason === 'stop' && (finalStatus !== 'completed' || toolCalls.length)) throw new Error('Google interaction returned inconsistent terminal status');
      return {
        historyItems: completedSteps,
        events,
        toolCalls: reason === 'tool_calls' ? toolCalls : [],
        usage,
        metadata: { type: 'response_metadata', ...(responseModel ? { modelId: responseModel } : {}) },
        reason,
      };
    },
  };
}

/** Google Gemini Interactions v1 provider. */
export class GoogleProvider implements ModelProvider {
  readonly protocol = 'google-genai' as const;

  open(init: ProviderSessionInit): ProviderSession {
    init = cloneSessionInit(init);
    if (init.providerOptions && Object.keys(init.providerOptions).length > 0) throw new Error('Unsupported Google provider options');
    const apiKey = readApiKey(init.model);
    return createProviderSession(init, adapter(init, apiKey));
  }

  async listModels(target: ModelListTarget, signal?: AbortSignal): Promise<string[]> {
    const apiKey = readApiKey(target);
    return withRedactedErrors(apiKey, async () => {
      const page = await client(apiKey, target.baseUrl).models.list({ config: { abortSignal: signal, pageSize: 1000 } });
      const ids: string[] = [];
      for await (const model of page) {
        signal?.throwIfAborted();
        if (model.name) ids.push(model.name.replace(/^models\//, ''));
      }
      return ids;
    });
  }
}
