import { randomUUID } from 'node:crypto';
import type { CommandSpec, RunnerResult } from './runner.js';
import type { CommandRunner, RunnerCommandInfo } from './runner-contract.js';

type Platform = CommandSpec['platform'];
interface RoutedTicket { invocationId: string; backend: CommandRunner; ticket: string; used: boolean }
/** 两个平台共享两个执行槽，不能因同时启用两个后端变成四路裸并发。 */
export class RunnerRouter implements CommandRunner {
  readonly capability: { platform: Platform };
  private readonly tickets = new Map<string, RoutedTicket>();
  private running = 0;
  private readonly waiting: { resolve: () => void; reject: (error: Error) => void; signal?: AbortSignal; abort: () => void }[] = [];
  constructor(readonly backends: Partial<Record<Platform, CommandRunner>>, preferred?: Platform, readonly concurrency = 2) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) throw new Error('测试并发只能为1或2');
    const platform = preferred && backends[preferred] ? preferred : backends.windows ? 'windows' : backends.linux ? 'linux' : null;
    if (!platform) throw new Error('没有可用的已验证测试执行端');
    this.capability = { platform };
  }
  issueTicket(invocationId: string, spec: CommandSpec, allowedRoot: string, ttlMs?: number): string {
    const backend = this.backends[spec.platform];
    if (!backend) throw new Error(`${spec.platform === 'windows' ? 'Windows' : 'Linux/WSL'} 测试隔离能力不可用`);
    const ticket = backend.issueTicket(invocationId, spec, allowedRoot, ttlMs); const id = `router-${randomUUID()}`;
    this.tickets.set(id, { invocationId, backend, ticket, used: false }); return id;
  }
  async run(ticketId: string, invocationId: string, signal?: AbortSignal): Promise<RunnerResult> {
    const ticket = this.tickets.get(ticketId);
    if (!ticket || ticket.used || ticket.invocationId !== invocationId) throw new Error('测试票据无效、已消费或调用身份不匹配');
    ticket.used = true;
    await this.acquire(signal);
    try { return await ticket.backend.run(ticket.ticket, invocationId, signal); }
    finally { this.running--; this.drain(); }
  }
  commandInfo(): RunnerCommandInfo[] { return Object.values(this.backends).flatMap(backend => backend?.commandInfo?.() ?? []); }
  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('测试已取消'));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, abort: () => { const index = this.waiting.indexOf(waiter); if (index >= 0) this.waiting.splice(index, 1); reject(new Error('测试已取消')); } };
      this.waiting.push(waiter); signal?.addEventListener('abort', waiter.abort, { once: true }); this.drain();
    });
  }
  private drain() {
    while (this.running < this.concurrency && this.waiting.length) {
      const next = this.waiting.shift()!; next.signal?.removeEventListener('abort', next.abort);
      if (next.signal?.aborted) { next.reject(new Error('测试已取消')); continue; }
      this.running++; next.resolve();
    }
  }
}
