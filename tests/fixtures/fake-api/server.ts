import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  path: string;
  method: string;
  body: Record<string, unknown>;
}

/** Fake API only binds loopback, records JSON bodies and discards all request headers. */
export async function fakeApi(handle: (request: RecordedRequest, response: ServerResponse) => void | Promise<void>) {
  const attemptedMethods: string[] = [];
  const requests: RecordedRequest[] = [];
  const failures: unknown[] = [];
  const server = createServer(async (request, response) => {
    attemptedMethods.push(request.method ?? '');
    try {
      request.setEncoding('utf8');
      let raw = '';
      for await (const part of request) raw += part.toString();
      const recorded = {
        path: request.url ?? '',
        method: request.method ?? '',
        body: raw ? JSON.parse(raw) : {},
      };
      requests.push(recorded);
      await handle(recorded, response);
    } catch (error) {
      failures.push(error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    attemptedMethods,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (failures.length) throw failures[0];
    },
  };
}

export function sse(value: unknown, event?: string): string {
  return `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(value)}\n\n`;
}

export function stream(response: ServerResponse, frames: readonly string[]): void {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
  for (const frame of frames) response.write(frame);
  response.end();
}

export function json(response: ServerResponse, status: number, data: unknown, headers?: Record<string, string>): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(data));
}
