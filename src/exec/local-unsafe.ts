import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { BoundedOutputCapture } from './output-limit.js';
import { resolveExec } from './policy.js';
import type { ExecBackend, ExecContext, ExecResult, ExecSpec } from './types.js';

/** Explicit local opt-in. This backend has neither process isolation nor network isolation. */
export class LocalUnsafeExecBackend implements ExecBackend {
  readonly id = 'local-unsafe' as const;

  async probe() {
    return { ok: true, reason: '本机执行无沙箱，命令可访问宿主和网络' };
  }

  async run(spec: ExecSpec, context: ExecContext): Promise<ExecResult> {
    context.signal.throwIfAborted();
    const resolved = resolveExec(spec, context);
    const cwd = realpathSync(path.resolve(resolved.copyDir, resolved.spec.cwd));
    const relative = path.relative(resolved.copyDir, cwd);
    if (path.isAbsolute(relative) || relative.split(path.sep)[0] === '..') throw new Error('命令目录必须位于任务副本');
    const hostKeys = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'PATHEXT', 'TEMP', 'TMP'];
    const env = { ...Object.fromEntries(hostKeys.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]])), ...spec.env };
    const stdoutRef = path.join(resolved.outputDir, 'stdout.txt');
    const stderrRef = path.join(resolved.outputDir, 'stderr.txt');
    const started = Date.now();
    let child: ReturnType<typeof spawn> | undefined;
    let terminationTriggered = false;
    const terminate = () => {
      if (!child || terminationTriggered) return;
      terminationTriggered = true;
      child.kill();
    };
    const capture = new BoundedOutputCapture(stdoutRef, stderrRef, terminate);
    try {
      const spawned = spawn(spec.argv[0]!, spec.argv.slice(1), {
        cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      child = spawned;
      if (capture.failed) terminate();
      capture.attach(spawned.stdout!, spawned.stderr!);
      let cancelled = false;
      let timedOut = false;
      const stop = () => { cancelled = true; spawned.kill(); };
      const timer = setTimeout(() => { timedOut = true; spawned.kill(); }, spec.timeoutMs);
      context.signal.addEventListener('abort', stop, { once: true });
      if (context.signal.aborted) stop();
      try {
        const exitCode = await new Promise<number | null>((resolve, reject) => {
          spawned.once('error', reject);
          spawned.once('close', resolve);
        });
        return { exitCode, cancelled, timedOut, exitConfirmed: !cancelled && !timedOut && !capture.limited,
          durationMs: Date.now() - started, stdoutRef, stderrRef, network: 'full',
          ...(capture.limited ? { outputLimited: true as const } : {}) };
      } finally {
        clearTimeout(timer);
        context.signal.removeEventListener('abort', stop);
      }
    } finally {
      try { await capture.close(); }
      catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { exitConfirmed: false }); }
    }
  }
}
