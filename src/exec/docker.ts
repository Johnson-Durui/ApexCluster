import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BoundedOutputCapture } from './output-limit.js';
import type { ExecBackend, ExecContext, ExecResult, ExecSpec } from './types.js';
import { assertDockerResource, assertImmutableImage, installNetworkAllowed, resolveExec, type ExecPolicyOptions } from './policy.js';

export interface DockerCommand {
  file: string;
  prefixArgs?: readonly string[];
}

export interface DockerBackendOptions extends ExecPolicyOptions {
  image: string;
  packageCacheVolume: string;
  dockerCommand?: DockerCommand;
  installNetwork?: boolean;
  memory?: string;
  cpus?: number;
  pidsLimit?: number;
  user?: string;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

function commandResult(command: DockerCommand, args: readonly string[], timeoutMs = 20_000): Promise<CommandResult> {
  return new Promise(resolve => {
    const child = spawn(command.file, [...(command.prefixArgs ?? []), ...args], {
      windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: dockerCliEnv(),
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    child.stdout.on('data', chunk => { if (stdout.length < 1_000_000) stdout += String(chunk); });
    child.stderr.on('data', chunk => { if (stderr.length < 1_000_000) stderr += String(chunk); });
    child.once('error', error => finish({ code: null, stdout, stderr, error }));
    child.once('close', code => finish({ code, stdout, stderr }));
    timer = setTimeout(() => {
      child.kill();
      finish({ code: null, stdout, stderr, error: new Error('Docker CLI 命令超时') });
    }, timeoutMs);
  });
}

function dockerCliEnv(): NodeJS.ProcessEnv {
  const keys = ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP'];
  return Object.fromEntries(keys.map(key => [key, process.env[key]]));
}

function boundedReason(result: CommandResult): string {
  return (result.error?.message || result.stderr || result.stdout || 'Docker CLI 不可用')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 500);
}

/** Builds a command without a host shell. The only host mount is the authorized task copy. */
export function dockerRunArgs(options: DockerBackendOptions, spec: ExecSpec, copyDir: string, containerCwd: string, containerName: string): string[] {
  const network = installNetworkAllowed(spec, options.installNetwork === true, options.installCommands) ? 'bridge' : 'none';
  const memory = options.memory ?? '1g';
  const args = [
    'container', 'run', '--rm', '--pull', 'never', '--name', containerName,
    '--label', 'com.dual-model-workbench.owner=exec-v1',
    '--label', 'com.dual-model-workbench.run=' + containerName,
    '--network', network, '--read-only', '--init',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=268435456',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
    '--memory', memory, '--memory-swap', memory,
    '--cpus', String(options.cpus ?? 2), '--pids-limit', String(options.pidsLimit ?? 256),
    '--user', options.user ?? '10001:10001', '--workdir', containerCwd,
    '--mount', 'type=bind,src=' + copyDir + ',dst=/workspace',
    '--mount', 'type=volume,src=' + options.packageCacheVolume + ',dst=/cache',
    '--env', 'HOME=/tmp/home', '--env', 'NPM_CONFIG_CACHE=/cache/npm', '--env', 'PIP_CACHE_DIR=/cache/pip',
    '--env', 'CARGO_HOME=/cache/cargo', '--env', 'GOMODCACHE=/cache/go',
  ];
  for (const [name, value] of Object.entries(spec.env ?? {})) args.push('--env', name + '=' + value);
  args.push(options.image, ...spec.argv);
  return args;
}

export class DockerBackend implements ExecBackend {
  readonly id = 'docker' as const;
  private readonly options: DockerBackendOptions;
  private readonly command: DockerCommand;

  constructor(options: DockerBackendOptions) {
    if (options.dockerCommand && !options.dockerCommand.file.trim()) throw new Error('Docker CLI 路径不能为空');
    if (!Number.isFinite(options.cpus ?? 2) || (options.cpus ?? 2) <= 0) throw new Error('Docker CPU 上限无效');
    if (!Number.isInteger(options.pidsLimit ?? 256) || (options.pidsLimit ?? 256) < 16) throw new Error('Docker 进程数上限无效');
    if (options.user && !/^[1-9]\d*:[1-9]\d*$/.test(options.user)) throw new Error('Docker 沙箱必须使用非 root 用户和组');
    if (options.memory) {
      const memory = /^(\d+)([mg])$/i.exec(options.memory);
      if (!memory || Number(memory[1]) * (memory[2]!.toLowerCase() === 'g' ? 1024 : 1) < 6) throw new Error('Docker 内存上限至少为 6 MiB');
    }
    if (!options.packageCacheVolume.startsWith('dmw-')) throw new Error('Docker 执行缓存卷需要 dmw- 前缀');
    this.options = {
      ...options,
      image: assertImmutableImage(options.image),
      packageCacheVolume: assertDockerResource(options.packageCacheVolume, 'Docker 包缓存卷'),
    };
    this.command = options.dockerCommand ?? { file: 'docker' };
  }

  private async cacheVolume(command: DockerCommand, create: boolean): Promise<string | undefined> {
    const name = this.options.packageCacheVolume;
    const inspect = () => commandResult(command, ['volume', 'inspect', '--format',
      '{{index .Labels "com.dual-model-workbench.owner"}}', name]);
    let result = await inspect();
    if (result.code !== 0) {
      if (!/no such volume|not found/i.test(result.stderr)) return boundedReason(result);
      if (!create) return undefined;
      const created = await commandResult(command, ['volume', 'create', '--label', 'com.dual-model-workbench.owner=exec-v1', name]);
      if (created.code !== 0) return boundedReason(created);
      result = await inspect();
    }
    if (result.code !== 0 || result.stdout.trim() !== 'exec-v1') return 'Docker 缓存卷缺少工作台所有权标签';
    return undefined;
  }

  private async localCommand(): Promise<{ command?: DockerCommand; reason?: string }> {
    let endpoint = process.env.DOCKER_HOST?.trim();
    if (!endpoint) {
      const context = process.env.DOCKER_CONTEXT?.trim();
      const inspection = await commandResult(this.command, ['context', 'inspect', ...(context ? [context] : []), '--format', '{{(index .Endpoints "docker").Host}}']);
      if (inspection.code !== 0) return { reason: boundedReason(inspection) };
      endpoint = inspection.stdout.trim();
    }
    if (!endpoint.startsWith('unix:///') && !endpoint.startsWith('npipe:////./pipe/')) {
      return { reason: 'Docker 执行后端只允许本机套接字或命名管道' };
    }
    return { command: { ...this.command, prefixArgs: [...(this.command.prefixArgs ?? []), '--host', endpoint] } };
  }

  async probe(): Promise<{ ok: boolean; reason?: string }> {
    const { command, reason } = await this.localCommand();
    if (!command) return { ok: false, reason };
    const version = await commandResult(command, ['version', '--format', '{{json .Server}}']);
    if (version.code !== 0) return { ok: false, reason: boundedReason(version) };
    try {
      const server = JSON.parse(version.stdout) as { Os?: unknown };
      if (server.Os !== 'linux') return { ok: false, reason: 'Docker 沙箱只支持 Linux 容器模式' };
    } catch { return { ok: false, reason: 'Docker 服务端版本响应无效' }; }

    const inspected = await commandResult(command, ['image', 'inspect', '--format', '{{json .}}', this.options.image]);
    if (inspected.code !== 0) return { ok: false, reason: boundedReason(inspected) };
    try {
      const image = JSON.parse(inspected.stdout) as { Id?: unknown; RepoDigests?: unknown };
      const exact = this.options.image.startsWith('sha256:')
        ? image.Id === this.options.image
        : Array.isArray(image.RepoDigests) && image.RepoDigests.includes(this.options.image);
      if (!exact) return { ok: false, reason: 'Docker 镜像摘要与配置不一致' };
    } catch { return { ok: false, reason: 'Docker 镜像检查响应无效' }; }
    const cacheReason = await this.cacheVolume(command, false);
    return cacheReason ? { ok: false, reason: cacheReason } : { ok: true };
  }

  private async containerExists(command: DockerCommand, name: string): Promise<boolean | null> {
    const inspected = await commandResult(command, ['container', 'inspect', name], 5_000);
    if (inspected.code === 0) return true;
    if (/no such (object|container)|not found/i.test(inspected.stderr)) return false;
    return null;
  }

  private async cleanup(command: DockerCommand, name: string, runClosed: () => boolean): Promise<boolean> {
    // `docker run` may be between CLI spawn and container creation. Keep targeting this exact
    // generated name until the attached CLI closes; never enumerate or act on other containers.
    for (let attempt = 0; attempt < 40; attempt++) {
      await commandResult(command, ['container', 'stop', '--time', '2', name], 8_000);
      const exists = await this.containerExists(command, name);
      if (exists === false && runClosed()) return true;
      if (exists === null) return false;
      await delay(100);
    }
    await commandResult(command, ['container', 'kill', name], 8_000);
    for (let attempt = 0; attempt < 20; attempt++) {
      const exists = await this.containerExists(command, name);
      if (exists === false && runClosed()) return true;
      if (exists === null) return false;
      await delay(100);
    }
    return false;
  }

  async run(input: ExecSpec, context: ExecContext): Promise<ExecResult> {
    const { command, reason } = await this.localCommand();
    if (!command) throw Object.assign(new Error(reason), { exitConfirmed: true });
    const resolved = resolveExec(input, context, this.options);
    const cacheReason = await this.cacheVolume(command, true);
    if (cacheReason) throw Object.assign(new Error(cacheReason), { exitConfirmed: true });
    const stdoutRef = 'stdout.txt';
    const stderrRef = 'stderr.txt';
    const stdoutPath = path.join(resolved.outputDir, stdoutRef);
    const stderrPath = path.join(resolved.outputDir, stderrRef);
    if (context.signal.aborted) {
      writeFileSync(stdoutPath, '', { flag: 'wx' });
      writeFileSync(stderrPath, '', { flag: 'wx' });
      return { exitCode: null, timedOut: false, cancelled: true, exitConfirmed: true, durationMs: 0, stdoutRef, stderrRef, network: 'none' };
    }

    const name = 'dmw-exec-' + randomUUID().replaceAll('-', '');
    const network = installNetworkAllowed(resolved.spec, this.options.installNetwork === true, this.options.installCommands) ? 'full' : 'none';
    const args = dockerRunArgs(this.options, resolved.spec, resolved.copyDir, resolved.containerCwd, name);
    const started = Date.now();
    let timedOut = false;
    let cancelled = false;
    let runClosed = false;
    let cleanupPromise: Promise<boolean> | undefined;
    const terminate = (kind: 'timeout' | 'cancel' | 'output') => {
      timedOut ||= kind === 'timeout';
      cancelled ||= kind === 'cancel';
      cleanupPromise ??= this.cleanup(command, name, () => runClosed);
    };
    const capture = new BoundedOutputCapture(stdoutPath, stderrPath, () => terminate('output'));
    const timer = setTimeout(() => terminate('timeout'), resolved.spec.timeoutMs);
    const abort = () => terminate('cancel');
    context.signal.addEventListener('abort', abort, { once: true });

    let exitCode: number | null = null;
    let spawnFailed = false;
    let captureError: Error | undefined;
    try {
      exitCode = await new Promise<number | null>(resolve => {
        const child = spawn(command.file, [...(command.prefixArgs ?? []), ...args], {
          windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: dockerCliEnv(),
        });
        capture.attach(child.stdout, child.stderr);
        child.once('error', error => {
          spawnFailed = true;
          runClosed = true;
          resolve(null);
        });
        child.once('close', code => {
          runClosed = true;
          resolve(code);
        });
      });
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', abort);
      try { await capture.close(); }
      catch (error) { captureError = error instanceof Error ? error : new Error(String(error)); }
    }

    let exitConfirmed = spawnFailed;
    if (cleanupPromise) exitConfirmed = await cleanupPromise;
    else {
      for (let attempt = 0; attempt < 20; attempt++) {
        const exists = await this.containerExists(command, name);
        if (exists === false) { exitConfirmed = true; break; }
        if (exists === null) break;
        await delay(100);
      }
      if (!exitConfirmed) exitConfirmed = await this.cleanup(command, name, () => runClosed);
    }
    if (captureError) throw Object.assign(captureError, { exitConfirmed });
    return {
      exitCode, timedOut, cancelled, exitConfirmed,
      durationMs: Date.now() - started, stdoutRef, stderrRef, network,
      ...(capture.limited ? { outputLimited: true as const } : {}),
    };
  }
}
