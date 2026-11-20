/**
 * 本机服务的安全边界：
 * - 只监听 127.0.0.1；
 * - 校验 Host（防 DNS 重绑定）；
 * - 有 Origin 时必须是本服务自身（或开发模式下的 Vite 地址）；
 * - 所有修改类请求必须携带启动时生成的随机令牌（x-workbench-token），跨站页面读不到它；
 * - 不设置任何 CORS 头。
 */
import type { IncomingMessage } from 'node:http';

export function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

export function allowedOrigins(port: number, devOrigins: string[]): string[] {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...devOrigins];
}

export interface SecurityCheck {
  ok: boolean;
  status: number;
  reason: string;
}

export function checkRequest(req: IncomingMessage, opts: { port: number; devOrigins: string[]; token: string; extraHosts?: string[]; binaryBody?: boolean }): SecurityCheck {
  const host = (req.headers.host ?? '').toLowerCase();
  const hosts = [...allowedHosts(opts.port), ...(opts.extraHosts ?? [])];
  if (!hosts.includes(host)) return { ok: false, status: 403, reason: `拒绝的 Host：${host || '(空)'}` };
  const origin = req.headers.origin;
  if (origin && !allowedOrigins(opts.port, opts.devOrigins).includes(origin)) return { ok: false, status: 403, reason: `拒绝的来源：${origin}` };
  const method = (req.method ?? 'GET').toUpperCase();
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  if (mutating) {
    const t = req.headers['x-workbench-token'];
    if (typeof t !== 'string' || t.length !== opts.token.length || !timingSafeEqualStr(t, opts.token)) {
      return { ok: false, status: 403, reason: '缺少或错误的 x-workbench-token' };
    }
    const ct = String(req.headers['content-type'] ?? '').split(';', 1)[0]!.trim().toLowerCase();
    const expected = opts.binaryBody ? 'application/octet-stream' : 'application/json';
    if (ct !== expected) return { ok: false, status: 415, reason: `请求体必须是 ${expected}` };
  }
  return { ok: true, status: 200, reason: '' };
}

function timingSafeEqualStr(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export const HTML_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'none'";
