// Browser-side stand-in for the workbench server (README.md "Mock contract").
//
// installTransport() replaces window.fetch and window.EventSource:
// - fetch: same-origin requests whose path starts with /api/ are answered by the handlers registered with route().
//   Every other request (Vite chunks, demo files under ./demo-project/, other origins) goes to the real fetch.
// - EventSource: same-origin /api/ URLs become a MockEventSource fed by the open function registered with stream().
//   Other URLs use the real EventSource.
// Nothing here talks to a network backend. An /api/ path without a handler is logged as
// console.warn('[demo] unmocked', method, path) and answered with 404 { error: '在线演示未提供此接口' }.

export interface MockRequest { method: string; url: URL; path: string; params: Record<string, string>; query: URLSearchParams; body: unknown; headers: Headers }
export type Handler = (req: MockRequest) => Response | Promise<Response>;
export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
export interface StreamContext { url: URL; params: Record<string, string>; query: URLSearchParams; emit(event: string, data: unknown, id?: string): void; close(): void }
export type StreamOpen = (ctx: StreamContext) => (() => void) | void;

/** The answer to every write the demo does not support (status 409 through fail()). */
export const READ_ONLY = '在线演示使用预设数据，此操作不可用。';
const UNMOCKED = '在线演示未提供此接口';

interface Pattern { source: string; regex: RegExp; keys: string[]; literals: number; segments: number }
interface RouteEntry { method: Method; pattern: Pattern; handler: Handler; order: number }
interface StreamEntry { pattern: Pattern; open: StreamOpen; order: number }

const routes: RouteEntry[] = [];
const streams: StreamEntry[] = [];
let order = 0;

/**
 * Compiles '/api/chats/:id/gates/:gate'. A ':name' segment matches one path segment (decoded into params.name).
 * A final '*' segment matches the rest of the path, including slashes (decoded into params['*']).
 */
function compile(source: string): Pattern {
  if (!source.startsWith('/')) throw new Error(`[demo] route pattern must start with '/': ${source}`);
  const parts = source.split('/').slice(1);
  const keys: string[] = [];
  let literals = 0;
  const body = parts.map((part, index) => {
    if (part === '*' && index === parts.length - 1) { keys.push('*'); return '/(.*)'; }
    if (part.startsWith(':')) { keys.push(part.slice(1)); return '/([^/]+)'; }
    literals += 1;
    return '/' + part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return { source, regex: new RegExp(`^${body}$`), keys, literals, segments: parts.length };
}

function match(pattern: Pattern, path: string): Record<string, string> | null {
  const found = pattern.regex.exec(path);
  if (!found) return null;
  const params: Record<string, string> = {};
  pattern.keys.forEach((key, index) => {
    const raw = found[index + 1] ?? '';
    try { params[key] = decodeURIComponent(raw); } catch { params[key] = raw; }
  });
  return params;
}

/** More literal segments win; then more segments; then the later registration. */
function best<T extends { pattern: Pattern; order: number }>(entries: T[], path: string): { entry: T; params: Record<string, string> } | null {
  let winner: { entry: T; params: Record<string, string> } | null = null;
  for (const entry of entries) {
    const params = match(entry.pattern, path);
    if (!params) continue;
    if (!winner) { winner = { entry, params }; continue; }
    const a = entry.pattern;
    const b = winner.entry.pattern;
    const better = a.literals !== b.literals ? a.literals > b.literals : a.segments !== b.segments ? a.segments > b.segments : entry.order > winner.entry.order;
    if (better) winner = { entry, params };
  }
  return winner;
}

/** Registers a handler. Registering the same method and pattern again replaces the earlier handler. */
export function route(method: Method, pattern: string, handler: Handler): void {
  const compiled = compile(pattern);
  const existing = routes.findIndex(item => item.method === method && item.pattern.source === pattern);
  const entry: RouteEntry = { method, pattern: compiled, handler, order: ++order };
  if (existing >= 0) {
    console.warn('[demo] route replaced', method, pattern);
    routes[existing] = entry;
  } else {
    routes.push(entry);
  }
}

/**
 * Registers an EventSource feed. `open` runs once per MockEventSource, right after its `open` event. It may emit
 * at once (replay) and later (live). The function it returns runs once, when the client closes the source or when
 * ctx.close() ends it.
 */
export function stream(pattern: string, open: StreamOpen): void {
  const compiled = compile(pattern);
  const existing = streams.findIndex(item => item.pattern.source === pattern);
  const entry: StreamEntry = { pattern: compiled, open, order: ++order };
  if (existing >= 0) {
    console.warn('[demo] stream replaced', pattern);
    streams[existing] = entry;
  } else {
    streams.push(entry);
  }
}

const NO_BODY = new Set([204, 205, 304]);

/** A real Response with a JSON body and Content-Type application/json. */
export function json(data: unknown, status = 200): Response {
  if (NO_BODY.has(status)) return new Response(null, { status });
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

/**
 * An error Response with body { error: message }. Status 403 is refused (the product drops its session token and
 * retries on 403): it is logged as an error and sent as 409 instead.
 */
export function fail(status: number, message: string): Response {
  if (status === 403) {
    console.error('[demo] fail(403) is not allowed; answering 409 instead', message);
    status = 409;
  }
  return json({ error: message }, status);
}

// ---------------------------------------------------------------- fetch

type FetchInput = RequestInfo | URL;

function inputUrl(input: FetchInput): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** The URL when it is a same-origin /api/ URL, otherwise null. */
export function mockedUrl(raw: string): URL | null {
  let url: URL;
  try { url = new URL(raw, location.href); } catch { return null; }
  if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return null;
  return url;
}

function abortError(): DOMException { return new DOMException('The operation was aborted.', 'AbortError'); }

/** JSON text becomes a value; File, Blob, FormData and other non-string bodies pass through unchanged. */
function parseBody(body: unknown): unknown {
  if (typeof body !== 'string') return body ?? undefined;
  if (!body) return undefined;
  try { return JSON.parse(body) as unknown; } catch { return body; }
}

function latency(signal: AbortSignal | null | undefined): Promise<void> {
  const ms = 60 + Math.round(Math.random() * 120);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function answer(method: string, url: URL, body: unknown, headers: Headers): Promise<Response> {
  const path = url.pathname;
  const candidates = routes.filter(item => item.method === method);
  const found = best(candidates, path);
  if (!found) {
    console.warn('[demo] unmocked', method, path);
    return fail(404, UNMOCKED);
  }
  const request: MockRequest = { method, url, path, params: found.params, query: url.searchParams, body, headers };
  try {
    const response = await found.entry.handler(request);
    if (!(response instanceof Response)) throw new Error('handler did not return a Response');
    return response;
  } catch (error) {
    console.error('[demo] handler failed', method, path, error);
    return fail(500, `在线演示内部错误：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Answers one /api/ request through the registered routes, with the same latency and abort handling as the fetch
 * shim. navigation.ts uses it for <a href="/api/...">, <iframe src> and <img src>. Throws for non-/api URLs.
 */
export async function mockFetch(input: FetchInput, init?: RequestInit): Promise<Response> {
  const url = mockedUrl(inputUrl(input));
  if (!url) throw new TypeError(`[demo] mockFetch only answers same-origin /api/ URLs: ${inputUrl(input)}`);
  const request = input instanceof Request ? input : null;
  const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
  const headers = new Headers(init?.headers ?? request?.headers);
  const signal = init?.signal ?? request?.signal ?? null;
  let body: unknown = init?.body;
  if (body === undefined && request && method !== 'GET' && method !== 'HEAD') body = await request.clone().text();
  await latency(signal);
  const response = await answer(method, url, parseBody(body), headers);
  if (signal?.aborted) throw abortError();
  return response;
}

// ---------------------------------------------------------------- EventSource

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

type Listener = ((this: EventSource, event: Event) => unknown) | null;
type MessageListener = ((this: EventSource, event: MessageEvent) => unknown) | null;

/**
 * EventSource replacement for /api/ URLs. The `open` event fires asynchronously (a macrotask after construction,
 * because the product assigns onopen after `new`). Events are MessageEvents whose .data is the JSON string.
 * A URL with no registered stream stays open and never sends anything.
 */
export class MockEventSource extends EventTarget {
  static readonly CONNECTING = CONNECTING;
  static readonly OPEN = OPEN;
  static readonly CLOSED = CLOSED;
  readonly CONNECTING = CONNECTING;
  readonly OPEN = OPEN;
  readonly CLOSED = CLOSED;
  readonly url: string;
  readonly withCredentials: boolean;
  readyState: number = CONNECTING;
  onopen: Listener = null;
  onmessage: MessageListener = null;
  onerror: Listener = null;
  #cleanup: (() => void) | null = null;
  #ended = false;

  constructor(url: string | URL, init?: EventSourceInit) {
    super();
    this.url = new URL(String(url), location.href).href;
    this.withCredentials = Boolean(init?.withCredentials);
    setTimeout(() => this.#start(), 0);
  }

  #call(handler: Listener | MessageListener, event: Event): void {
    if (!handler) return;
    try {
      (handler as (this: unknown, event: Event) => unknown).call(this, event);
    } catch (error) {
      reportError(error);
    }
  }

  #start(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = OPEN;
    const opened = new Event('open');
    this.dispatchEvent(opened);
    this.#call(this.onopen, opened);
    if (this.readyState !== OPEN) return;
    const url = new URL(this.url);
    const found = best(streams, url.pathname);
    if (!found) {
      console.info('[demo] stream without a source (stays open, sends nothing)', url.pathname);
      return;
    }
    const ctx: StreamContext = {
      url,
      params: found.params,
      query: url.searchParams,
      emit: (event, data, id) => this.#emit(event, data, id),
      close: () => this.#serverClose(),
    };
    try {
      const cleanup = found.entry.open(ctx);
      if (typeof cleanup === 'function') {
        // The client may have closed the source inside a listener that open() triggered.
        if (this.#closed()) cleanup();
        else this.#cleanup = cleanup;
      }
    } catch (error) {
      console.error('[demo] stream open failed', url.pathname, error);
    }
  }

  #closed(): boolean {
    return this.readyState === CLOSED;
  }

  #emit(type: string, data: unknown, id?: string): void {
    if (this.readyState !== OPEN) return;
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    const event = new MessageEvent(type, { data: text, lastEventId: id ?? '', origin: location.origin });
    this.dispatchEvent(event);
    if (type === 'message') this.#call(this.onmessage, event);
  }

  #end(): void {
    if (this.#ended) return;
    this.#ended = true;
    const cleanup = this.#cleanup;
    this.#cleanup = null;
    if (cleanup) {
      try { cleanup(); } catch (error) { console.error('[demo] stream cleanup failed', error); }
    }
  }

  /** The server side ended the response: like a dropped connection, the client receives an `error` event. */
  #serverClose(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.#end();
    const event = new Event('error');
    this.dispatchEvent(event);
    this.#call(this.onerror, event);
  }

  close(): void {
    this.readyState = CLOSED;
    this.#end();
  }
}

let installed = false;

/** Patches window.fetch and window.EventSource. Safe to call more than once. */
export function installTransport(): void {
  if (installed) return;
  installed = true;
  const realFetch = window.fetch.bind(window);
  const RealEventSource = window.EventSource;
  window.fetch = (input: FetchInput, init?: RequestInit): Promise<Response> => {
    if (!mockedUrl(inputUrl(input))) return realFetch(input, init);
    return mockFetch(input, init);
  };
  const Shim = function EventSourceShim(this: unknown, url: string | URL, init?: EventSourceInit) {
    if (!mockedUrl(String(url)) && RealEventSource) return new RealEventSource(url, init);
    return new MockEventSource(url, init);
  } as unknown as typeof EventSource;
  Object.assign(Shim, { CONNECTING, OPEN, CLOSED });
  window.EventSource = Shim;
}
