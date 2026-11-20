import { AnthropicProvider } from './anthropic.js';
import { GoogleProvider } from './google.js';
import { OpenAIChatProvider } from './openai-chat.js';
import { OpenAIResponsesProvider } from './openai-responses.js';
import type { ModelProvider, WireProtocol } from './types.js';

const providers: Record<WireProtocol, ModelProvider> = {
  'anthropic-messages': new AnthropicProvider(),
  'google-genai': new GoogleProvider(),
  'openai-chat': new OpenAIChatProvider(),
  'openai-responses': new OpenAIResponsesProvider(),
};

/** Resolve a protocol adapter without changing the configured vendor or model. */
export function modelProviderFor(protocol: WireProtocol): ModelProvider {
  return providers[protocol];
}
