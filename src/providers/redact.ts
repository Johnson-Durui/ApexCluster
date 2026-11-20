import { providerStatus, retryAfterMs } from './retry.js';
import type { ModelListTarget } from './types.js';

/** Fetch a provider key from the named environment variable. */
export function readApiKey(target: Pick<ModelListTarget, 'apiKeyEnv'>): string {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(target.apiKeyEnv)) throw new Error('Invalid API key environment variable name');
  const key = process.env[target.apiKeyEnv]?.trim();
  if (!key) throw new Error(`Missing ${target.apiKeyEnv}`);
  return key;
}

function redact(text: string, apiKey: string): string {
  if (!apiKey) return text;
  for (const value of new Set([apiKey, encodeURIComponent(apiKey), JSON.stringify(apiKey).slice(1, -1)])) {
    if (value) text = text.replaceAll(value, '[REDACTED]');
  }
  return text;
}

/** Refuse to emit or replay an exact credential in serialized provider material. */
export function assertNoKey(value: unknown, apiKey: string): void {
  if (!apiKey) return;
  const text = JSON.stringify(value) ?? '';
  if (redact(text, apiKey) !== text) throw new Error('Provider request or response contained a credential');
}

/** Only expose sanitized error text and non-secret numeric retry metadata. */
export function safeProviderError(error: unknown, apiKey: string, signal?: AbortSignal): Error {
  if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
    return new DOMException('Provider request was cancelled', 'AbortError');
  }
  const message = error instanceof Error ? error.message : 'Provider request failed';
  const safe = new Error(redact(message, apiKey).slice(0, 2000));
  const status = providerStatus(error);
  const retryAfter = retryAfterMs(error);
  return Object.assign(safe, status === undefined ? {} : { status }, retryAfter === undefined ? {} : { retryAfterMs: retryAfter });
}

/** Wrap SDK listing errors before they can reach CLI or persistence. */
export async function withRedactedErrors<T>(apiKey: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw safeProviderError(error, apiKey);
  }
}
