import type { CommandSpec, RunnerResult } from './runner.js';

/** 原生Windows与WSL执行端共享的结构化接口；模型不能选择裸执行。 */
export interface CommandRunner {
  readonly capability: { platform: CommandSpec['platform'] };
  issueTicket(invocationId: string, spec: CommandSpec, allowedRoot: string, ttlMs?: number): string;
  run(ticketId: string, invocationId: string, signal?: AbortSignal): Promise<RunnerResult>;
  commandInfo?(): RunnerCommandInfo[];
}
export interface RunnerCommandInfo { platform: CommandSpec['platform']; executablePaths: string[]; network: 'none'; writableScope: 'derived-test-copy' }
export interface RunnerAvailability {
  available: boolean; platform: CommandSpec['platform']; reason?: string;
}
