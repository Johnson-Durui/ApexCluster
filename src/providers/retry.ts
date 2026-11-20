import { setTimeout as delay } from 'node:timers/promises';
import type { ProviderRequestHooks } from './types.js';

/** The response stream closed before a full reply could be decoded. */
export class ProviderTransportError extends Error {}

/** A streamed request body prevents fetch from replaying a POST after HTTP 421. */
export const fetchSingleAttempt: typeof fetch = async (input, options) => {
  const request = new Request(input, options);
  if (!request.body) return fetch(request, { ...options, redirect: 'error' });
  const bytes = new Uint8Array(await request.arrayBuffer());
  const headers = new Headers(request.headers);
  headers.set('content-length', String(bytes.byteLength));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const init = { ...options, headers, body, duplex: 'half' as const, redirect: 'error' as const };
  return fetch(request, init);
};

/** Extracts HTTP status without depending on any one SDK's error class. */
export function providerStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = 'status' in error ? error.status : undefined;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

/** Reads Retry-After in seconds or HTTP date format. */
export function retryAfterMs(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('headers' in error)) return undefined;
  const headers = error.headers;
  const value = headers instanceof Headers ? headers.get('retry-after') :
    typeof headers === 'object' && headers !== null && 'retry-after' in headers ? headers['retry-after'] : undefined;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const ms = /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}

const networkCodes = new Set([
  'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
  'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);

function isTransient(error: unknown): boolean {
  const status = providerStatus(error);
  if (status !== undefined) return status === 429 || status >= 500;
  if (error instanceof ProviderTransportError) return true;
  let cause: unknown = error;
  for (let depth = 0; depth < 5 && typeof cause === 'object' && cause !== null; depth++) {
    if ('code' in cause && typeof cause.code === 'string' && networkCodes.has(cause.code)) return true;
    if (cause instanceof TypeError && /^(fetch failed|terminated|networkerror|network request failed)$/i.test(cause.message)) return true;
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  return false;
}

/** Retry one model request, acquiring and releasing its concurrency slot per attempt. */
export async function retryRequest<T>(signal: AbortSignal, operation: () => Promise<T>, hooks?: ProviderRequestHooks, singleAttempt = false): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const release = await hooks?.beforeAttempt?.(signal);
    let retryError: unknown;
    try {
      const value = await operation();
      hooks?.onSuccess?.();
      return value;
    } catch (error) {
      if (providerStatus(error) === 429) hooks?.onRateLimit?.(retryAfterMs(error));
      signal.throwIfAborted();
      if (singleAttempt || attempt === 6 || !isTransient(error)) throw error;
      retryError = error;
    } finally {
      release?.();
    }
    const backoff = 250 * 2 ** attempt * (0.75 + Math.random() / 2);
    const pause = Math.max(backoff, retryAfterMs(retryError) ?? 0);
    await delay(Math.min(pause, 2_147_483_647), undefined, { signal });
  }
}
