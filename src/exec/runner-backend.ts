import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CommandRunner } from '../chat/runner-contract.js';
import type { ExecBackend, ExecContext, ExecResult, ExecSpec } from './types.js';

/** Adapt an existing locally proven sandbox. Its command and network boundaries stay in force. */
export class RunnerExecBackend implements ExecBackend {
  constructor(readonly id: 'wsl-bwrap' | 'windows-mxc', private readonly runner?: CommandRunner) {}

  async probe() {
    const platform = this.id === 'wsl-bwrap' ? 'linux' : 'windows';
    const available = this.runner?.commandInfo?.().some(item => item.platform === platform && item.executablePaths.length > 0);
    return available ? { ok: true } : { ok: false, reason: `${this.id} 缺少匹配的本机隔离证明或命令白名单` };
  }

  async run(spec: ExecSpec, context: ExecContext): Promise<ExecResult> {
    const platform = this.id === 'wsl-bwrap' ? 'linux' : 'windows';
    const command = this.runner?.commandInfo?.().find(item => item.platform === platform);
    const executable = command?.executablePaths.find(candidate => {
      if (platform === 'windows') {
        const value = spec.argv[0]!.toLowerCase();
        return candidate.toLowerCase() === value || path.win32.parse(candidate).name.toLowerCase() === value;
      }
      return candidate === spec.argv[0] || path.posix.basename(candidate) === spec.argv[0];
    });
    if (!this.runner || !executable) throw new Error('命令没有当前隔离执行端的证明');
    const cwd = path.resolve(context.copyDir, spec.cwd);
    const relative = path.relative(context.copyDir, cwd);
    if (path.isAbsolute(relative) || relative.split(path.sep)[0] === '..') throw new Error('命令目录必须位于任务副本');
    const identity = randomUUID();
    const ticket = this.runner.issueTicket(identity, {
      executable, cwd, args: spec.argv.slice(1), env: spec.env, timeoutMs: spec.timeoutMs, network: 'none', platform,
    }, context.copyDir);
    const result = await this.runner.run(ticket, identity, context.signal);
    const stdoutRef = path.join(context.outputDir, 'stdout.txt');
    const stderrRef = path.join(context.outputDir, 'stderr.txt');
    writeFileSync(stdoutRef, result.stdoutTail, 'utf8');
    writeFileSync(stderrRef, [result.stderrTail, result.spawnError].filter(Boolean).join('\n'), 'utf8');
    return { exitCode: result.exitCode, timedOut: result.timedOut, cancelled: result.cancelled,
      exitConfirmed: !result.terminationWarning, durationMs: result.durationMs, stdoutRef, stderrRef, network: 'none' };
  }
}
