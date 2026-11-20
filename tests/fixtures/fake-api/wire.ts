import type { WireProtocol } from '../../../src/providers/types.js';
import { sse } from './server.js';

const replyText = 'Hello, world';
const textDeltas = ['Hello, ', 'world'];
const tools = ['call-A', 'call-B'];
const toolArgs = (index: number) => ({ index });
type Reply = { frames: string[]; replay: unknown[] };

function anthropic(model: string, toolCount: number, refusal: boolean): Reply {
  const usage = { input_tokens: 100, output_tokens: 40, cache_creation_input_tokens: 7, cache_read_input_tokens: 13 };
  const thinking = { type: 'thinking', thinking: 'check the plan', signature: 'signature-A' };
  const redacted = { type: 'redacted_thinking', data: 'opaque-A' };
  const message = { type: 'text', text: replyText };
  const calls = tools.slice(0, toolCount).map((id, index) => ({ type: 'tool_use', id, name: 'echo', input: toolArgs(index) }));
  const event = (type: string, data: object = {}) => sse({ type, ...data }, type);
  const start = (index: number, content_block: object) => event('content_block_start', { index, content_block });
  const delta = (index: number, data: object) => event('content_block_delta', { index, delta: data });
  const stop = (index: number) => event('content_block_stop', { index });
  const frames = [
    event('message_start', {
      message: { id: 'msg_A', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage },
    }),
    start(0, { ...thinking, thinking: '', signature: '' }),
    delta(0, { type: 'thinking_delta', thinking: thinking.thinking }),
    delta(0, { type: 'signature_delta', signature: thinking.signature }),
    stop(0),
    start(1, redacted),
    stop(1),
    start(2, { ...message, text: '' }),
    ...textDeltas.map(text => delta(2, { type: 'text_delta', text })),
    stop(2),
  ];
  calls.forEach((call, index) => {
    const position = index + 3;
    frames.push(start(position, { ...call, input: {} }), delta(position, {
      type: 'input_json_delta', partial_json: JSON.stringify(call.input),
    }), stop(position));
  });
  frames.push(event('message_delta', {
    delta: { stop_reason: refusal ? 'refusal' : toolCount ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 40 },
  }), event('message_stop'));
  return { frames, replay: [thinking, redacted, message, ...calls] };
}

function responses(model: string, toolCount: number, refusal: boolean, deepseek: boolean, maxOutput: boolean): Reply {
  const reasoning = deepseek
    ? { type: 'reasoning', id: 'rs_A', content: [{ type: 'reasoning_text', text: 'check the plan' }], summary: [] }
    : { type: 'reasoning', id: 'rs_A', encrypted_content: 'encrypted-A', summary: [{ type: 'summary_text', text: 'check the plan' }] };
  const body = refusal ? { type: 'refusal', refusal: 'Cannot proceed' } : { type: 'output_text', text: replyText, annotations: [], logprobs: [] };
  const message = { type: 'message', id: 'msg_A', role: 'assistant', status: 'completed', content: [body] };
  const calls = tools.slice(0, toolCount).map((callId, index) => ({
    type: 'function_call', id: `fc_${index}`, status: maxOutput ? 'incomplete' : 'completed', call_id: callId, name: 'echo',
    arguments: maxOutput ? '{' : JSON.stringify(toolArgs(index)),
  }));
  const output = [reasoning, message, ...calls];
  const usage = { input_tokens: 120, input_tokens_details: { cached_tokens: 13 }, output_tokens: 40, output_tokens_details: { reasoning_tokens: 4 }, total_tokens: 160 };
  let position = 0;
  const event = (type: string, data: object) => sse({ type, sequence_number: position++, ...data }, type);
  const frames = [
    event('response.reasoning_summary_text.delta', { item_id: 'rs_A', output_index: 0, summary_index: 0, delta: 'check the plan' }),
    ...(refusal ? [] : textDeltas.map(delta => event('response.output_text.delta', { item_id: 'msg_A', output_index: 1, content_index: 0, delta, logprobs: [] }))),
    ...output.map((item, output_index) => event('response.output_item.done', { item, output_index })),
    event(maxOutput ? 'response.incomplete' : 'response.completed', { response: {
      id: 'resp_A', object: 'response', model, status: maxOutput ? 'incomplete' : 'completed', output, usage,
      reasoning: { effort: 'high', summary: 'auto' },
      ...(maxOutput ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    } }),
  ];
  return { frames, replay: output };
}

function google(model: string, toolCount: number, refusal: boolean, includeTerminalSteps: boolean): Reply {
  const thought = { type: 'thought', signature: 'signature-G', summary: [{ type: 'text', text: 'check the plan' }] };
  const message = refusal
    ? { type: 'model_output', error: { code: 7, message: 'Blocked by safety policy' } }
    : { type: 'model_output', content: [{ type: 'text', text: replyText }] };
  const calls = tools.slice(0, toolCount).map((id, index) => ({ type: 'function_call', id, name: 'echo', arguments: toolArgs(index) }));
  const steps = [thought, message, ...calls];
  const event = (event_type: string, data: object) => sse({ event_type, ...data }, event_type);
  const frames = [
    event('step.start', { index: 0, step: { type: 'thought' } }),
    event('step.delta', { index: 0, delta: { type: 'thought_summary', content: thought.summary[0] } }),
    event('step.delta', { index: 0, delta: { type: 'thought_signature', signature: thought.signature } }),
    event('step.stop', { index: 0 }),
    event('step.start', { index: 1, step: refusal ? message : { type: 'model_output', content: [] } }),
    ...(refusal ? [] : textDeltas.map(text => event('step.delta', { index: 1, delta: { type: 'text', text } }))),
    event('step.stop', { index: 1 }),
  ];
  calls.forEach((call, index) => frames.push(
    event('step.start', { index: index + 2, step: { ...call, arguments: {} } }),
    event('step.delta', { index: index + 2, delta: { type: 'arguments_delta', arguments: JSON.stringify(call.arguments) } }),
    event('step.stop', { index: index + 2 }),
  ));
  frames.push(event('interaction.completed', { interaction: {
    id: 'interaction_A', model, status: refusal ? 'failed' : toolCount ? 'requires_action' : 'completed',
    ...(includeTerminalSteps ? { steps } : {}),
    usage: { total_input_tokens: 120, total_cached_tokens: 13, total_output_tokens: 36, total_thought_tokens: 4, total_tokens: 160 },
  } }));
  return { frames, replay: steps };
}

function chat(model: string, toolCount: number, refusal: boolean, maxOutput: boolean): Reply {
  const calls = tools.slice(0, toolCount).map((id, index) => ({
    type: 'function', id, function: { name: 'echo', arguments: maxOutput ? '{' : JSON.stringify(toolArgs(index)) },
  }));
  const chunk = (choices: unknown[], usage?: object) => sse({
    id: 'chat_A', model, created: 100, object: 'chat.completion.chunk', choices, ...(usage ? { usage } : {}),
  });
  const choice = (delta: object, finish_reason: string | null = null) => chunk([{ index: 0, delta, finish_reason }]);
  const frames = [
    choice({ role: 'assistant', reasoning_content: 'check the plan' }),
    ...textDeltas.map(content => choice({ content })),
    ...calls.map((call, index) => choice({ tool_calls: [{ ...call, index }] })),
    choice({}, refusal ? 'content_filter' : maxOutput ? 'length' : toolCount ? 'tool_calls' : 'stop'),
    chunk([], { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160,
      prompt_tokens_details: { cached_tokens: 13 }, completion_tokens_details: { reasoning_tokens: 4 } }),
    'data: [DONE]\n\n',
  ];
  return { frames, replay: [{ role: 'assistant', reasoning_content: 'check the plan', content: replyText, ...(calls.length ? { tool_calls: calls } : {}) }] };
}

/** A successful streamed round with native output items retained for replay assertions. */
export function wireReply(protocol: WireProtocol, model: string, toolCount = 0, options: {
  refusal?: boolean; deepseek?: boolean; googleTerminalSteps?: boolean; maxOutput?: boolean;
} = {}): Reply {
  const refusal = options.refusal ?? false;
  switch (protocol) {
    case 'anthropic-messages': return anthropic(model, toolCount, refusal);
    case 'openai-responses': return responses(model, toolCount, refusal, options.deepseek ?? false, options.maxOutput ?? false);
    case 'google-genai': return google(model, toolCount, refusal, options.googleTerminalSteps ?? true);
    case 'openai-chat': return chat(model, toolCount, refusal, options.maxOutput ?? false);
  }
}
