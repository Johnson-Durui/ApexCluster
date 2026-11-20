import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod/v4';
import { isApiKeyEnvName, killTree } from '../adapters/process.js';
import type { CommandRunner, RunnerAvailability, RunnerCommandInfo } from './runner-contract.js';
import type { CommandSpec, RunnerResult } from './runner.js';

const DEFAULT_NODE = '/opt/cursor-agent/versions/2026.10.22-27dcf5f/node';
const AUTH_ENV = new Set(['anthropic_api_key', 'openai_api_key', 'codex_api_key', 'cursor_api_key', 'xai_api_key', 'aws_access_key_id', 'aws_secret_access_key']);
const POLICY = Object.freeze({ version: 1, network: 'none', writableScope: 'derived-test-copy', executable: DEFAULT_NODE, allowedEnv: ['CI', 'NODE_ENV'] });
const RUNTIME_FILE = fileURLToPath(new URL('./wsl-test-runtime.mjs', import.meta.url));
const HOST_RUNNER_FILE = fileURLToPath(import.meta.url);

export interface WslRunnerOptions {
  distro?: string;
  wslExecutable?: string;
  linuxNode?: string;
  bwrapPath?: string;
  setsidPath?: string;
  unsharePath?: string;
  workRootWindows: string;
  concurrency?: number;
  allowedEnv?: string[];
}

export interface WslRunnerProof {
  version: 1;
  platform: 'linux';
  distro: string;
  verified: boolean;
  verifiedAt: string;
  nodePath: string;
  nodeSha256: string;
  bwrapPath: string;
  bwrapSha256: string;
  setsidPath: string;
  setsidSha256: string;
  unsharePath: string;
  unshareSha256: string;
  runtimeSha256: string;
  hostRunnerSha256: string;
  policySha256: string;
  positiveWrite: boolean;
  outsideReadDenied: boolean;
  outsideWriteDenied: boolean;
  fakeCredentialReadDenied: boolean;
  networkDenied: boolean;
  subprocessEscapeDenied: boolean;
  outsideSampleHostReadable: boolean;
  outsideSampleHostWritable: boolean;
  fakeCredentialSampleHostReadable: boolean;
  networkControlReachable: boolean;
  childProcessWorks: boolean;
  childOutsideReadDenied: boolean;
  childFakeCredentialReadDenied: boolean;
  childOutsideWriteDenied: boolean;
  childNetworkDenied: boolean;
  normalTreeTerminationConfirmed: boolean;
  earlyParentTreeTerminationConfirmed: boolean;
  cancelTreeTerminationConfirmed: boolean;
  diagnostics?: string;
}

interface Ticket {
  id: string;
  invocationId: string;
  spec: CommandSpec;
  allowedRoot: string;
  expiresAt: number;
  used: boolean;
}

interface NormalizedOptions {
  distro: string;
  wslExecutable: string;
  linuxNode: string;
  bwrapPath: string;
  setsidPath: string;
  unsharePath: string;
  workRootWindows: string;
  concurrency: number;
  allowedEnv: string[];
}

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const proofSchema = z.object({
  version: z.literal(1), platform: z.literal('linux'), distro: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/),
  verified: z.boolean(), verifiedAt: z.string(), nodePath: z.string(), nodeSha256: hash,
  bwrapPath: z.string(), bwrapSha256: hash, setsidPath: z.string(), setsidSha256: hash,
  unsharePath: z.string(), unshareSha256: hash, runtimeSha256: hash, hostRunnerSha256: hash, policySha256: hash,
  positiveWrite: z.boolean(), outsideReadDenied: z.boolean(), outsideWriteDenied: z.boolean(),
  fakeCredentialReadDenied: z.boolean(), networkDenied: z.boolean(), subprocessEscapeDenied: z.boolean(),
  outsideSampleHostReadable: z.boolean(), outsideSampleHostWritable: z.boolean(), fakeCredentialSampleHostReadable: z.boolean(), networkControlReachable: z.boolean(),
  childProcessWorks: z.boolean(), childOutsideReadDenied: z.boolean(), childFakeCredentialReadDenied: z.boolean(),
  childOutsideWriteDenied: z.boolean(), childNetworkDenied: z.boolean(), normalTreeTerminationConfirmed: z.boolean(),
  earlyParentTreeTerminationConfirmed: z.boolean(), cancelTreeTerminationConfirmed: z.boolean(), diagnostics: z.string().optional(),
}).strict();

function hashText(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function hashBuffer(value: Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function isCredentialEnvName(key: string): boolean { return AUTH_ENV.has(key.toLowerCase()) || isApiKeyEnvName(key); }
function policySha256(options: NormalizedOptions): string {
  return hashText(JSON.stringify({ version: 1, network: 'none', writableScope: 'derived-test-copy', executable: options.linuxNode, allowedEnv: options.allowedEnv }));
}

function normalizeOptions(options: WslRunnerOptions): NormalizedOptions {
  const distro = options.distro ?? 'codex-cursor-h7';
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(distro)) throw new Error('WSL distro 名称无效。');
  const allowedEnv = options.allowedEnv ?? [...POLICY.allowedEnv];
  if (allowedEnv.some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || isCredentialEnvName(key))) throw new Error('WSL runner 环境变量允许清单无效。');
  const concurrency = options.concurrency ?? 2;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) throw new Error('WSL runner 并发范围无效。');
  return {
    distro, wslExecutable: options.wslExecutable ?? 'wsl.exe', linuxNode: options.linuxNode ?? DEFAULT_NODE,
    bwrapPath: options.bwrapPath ?? '/usr/bin/bwrap', setsidPath: options.setsidPath ?? '/usr/bin/setsid',
    unsharePath: options.unsharePath ?? '/usr/bin/unshare', workRootWindows: canonicalDirectory(options.workRootWindows),
    concurrency, allowedEnv: [...allowedEnv],
  };
}

function canonicalDirectory(directory: string): string {
  if (!path.win32.isAbsolute(directory) || directory.slice(2).includes(':')) throw new Error('WSL 工作目录必须是无 ADS 的 Windows 绝对路径。');
  const info = lstatSync(directory);
  const attributes = (info as unknown as { fileAttributes?: number }).fileAttributes ?? 0;
  if (!info.isDirectory() || info.isSymbolicLink() || Boolean(attributes & 0x400)) throw new Error('WSL 工作目录不能是链接或 junction。');
  const actual = realpathSync.native(directory);
  if (path.win32.normalize(actual).toLowerCase() !== path.win32.normalize(path.resolve(directory)).toLowerCase()) throw new Error('WSL 工作目录规范路径已变化。');
  return actual;
}

function inside(candidate: string, root: string): boolean {
  const relative = path.win32.relative(root, candidate);
  return relative === '' || (!path.win32.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.win32.sep}`));
}

function stageFiles(root: string): Array<{ path: string; size: number; sha256: string; base64: string }> {
  const sensitive = new Set(['.env', '.git', '.ssh', '.aws', '.claude', '.codex', '.npmrc', '.pypirc', '.netrc', '.git-credentials', 'credentials.json', 'secrets.json', 'auth.json']);
  const files: Array<{ path: string; size: number; sha256: string; base64: string }> = [];
  const queue = [''];
  let total = 0;
  while (queue.length) {
    const relativeDir = queue.shift()!;
    const directory = relativeDir ? path.join(root, relativeDir) : root;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (sensitive.has(entry.name.toLowerCase())) throw new Error(`测试副本包含禁止传入 WSL 的敏感路径：${entry.name}`);
      const relative = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
      const absolute = path.join(root, relative);
      const info = lstatSync(absolute);
      const attributes = (info as unknown as { fileAttributes?: number }).fileAttributes ?? 0;
      if (info.isSymbolicLink() || Boolean(attributes & 0x400)) throw new Error(`测试副本包含链接或 junction：${relative}`);
      if (entry.isDirectory()) { queue.push(relative); continue; }
      if (!entry.isFile()) throw new Error(`测试副本包含非普通文件：${relative}`);
      if (info.size > 16 * 1024 * 1024 || files.length >= 20_000 || total + info.size > 128 * 1024 * 1024) throw new Error('测试副本超过 WSL runner 的传输上限。');
      const data = readFileSync(absolute);
      total += data.length;
      files.push({ path: relative.split(path.sep).join('/'), size: data.length, sha256: hashBuffer(data), base64: data.toString('base64') });
    }
  }
  return files;
}

function proofReason(proof: unknown, options: NormalizedOptions, runtimeSource: string): string | null {
  const parsed = proofSchema.safeParse(proof);
  if (!parsed.success) return 'WSL proof 结构无效。';
  const value = parsed.data;
  if (!value.verified || !Number.isFinite(Date.parse(value.verifiedAt))) return 'WSL proof 未完整验证。';
  if (![value.positiveWrite, value.outsideReadDenied, value.outsideWriteDenied, value.fakeCredentialReadDenied, value.networkDenied, value.subprocessEscapeDenied,
    value.outsideSampleHostReadable, value.outsideSampleHostWritable, value.fakeCredentialSampleHostReadable, value.networkControlReachable, value.childProcessWorks,
    value.childOutsideReadDenied, value.childFakeCredentialReadDenied, value.childOutsideWriteDenied, value.childNetworkDenied,
    value.normalTreeTerminationConfirmed, value.earlyParentTreeTerminationConfirmed, value.cancelTreeTerminationConfirmed].every(Boolean)) return 'WSL proof 的正反例或树收口验证不完整。';
  if (value.distro !== options.distro || value.nodePath !== options.linuxNode || value.bwrapPath !== options.bwrapPath || value.setsidPath !== options.setsidPath || value.unsharePath !== options.unsharePath) return 'WSL proof 与配置的 distro 或工具路径不匹配。';
  if (value.runtimeSha256 !== hashText(runtimeSource)) return 'WSL runtime 代码哈希已漂移。';
  if (value.hostRunnerSha256 !== hashBuffer(readFileSync(HOST_RUNNER_FILE))) return 'WSL host runner 代码哈希已漂移。';
  if (value.policySha256 !== policySha256(options)) return 'WSL runner 策略哈希已漂移。';
  return null;
}

function runtimeRequest(proof: WslRunnerProof, options: NormalizedOptions, runtimeSource: string): Record<string, unknown> {
  return {
    distro: options.distro, nodePath: options.linuxNode, bwrapPath: options.bwrapPath, setsidPath: options.setsidPath,
    unsharePath: options.unsharePath, nodeSha256: proof.nodeSha256, bwrapSha256: proof.bwrapSha256,
    setsidSha256: proof.setsidSha256, unshareSha256: proof.unshareSha256,
    runtimeSha256: hashText(runtimeSource), hostRunnerSha256: hashBuffer(readFileSync(HOST_RUNNER_FILE)), policySha256: policySha256(options),
  };
}

async function invokeWsl(options: NormalizedOptions, runtimeSource: string, guestArgs: string[], stdin: string | null, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    const args = ['-d', options.distro, '--exec', ...(runtimeSource ? [options.linuxNode, '--input-type=module', '-e', runtimeSource] : []), ...guestArgs];
    const child = spawn(options.wslExecutable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    let error: string | undefined;
    const timer = setTimeout(() => { if (child.pid) void killTree(child.pid, 'win32'); }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', (cause) => { error = cause.message; });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), ...(error ? { error } : {}) }); });
    child.stdin.end(stdin ?? undefined);
  });
}

export async function probeWslTestRunner(optionsInput: WslRunnerOptions): Promise<WslRunnerProof> {
  const options = normalizeOptions(optionsInput);
  const runtimeSource = readFileSync(RUNTIME_FILE, 'utf8');
  const request = {
    mode: 'probe', distro: options.distro, nodePath: options.linuxNode, bwrapPath: options.bwrapPath,
    setsidPath: options.setsidPath, unsharePath: options.unsharePath,
    runtimeSha256: hashText(runtimeSource), hostRunnerSha256: hashBuffer(readFileSync(HOST_RUNNER_FILE)), policySha256: policySha256(options),
  };
  const result = await invokeWsl(options, runtimeSource, [], JSON.stringify(request), 30_000);
  if (result.code !== 0) throw new Error(`WSL runner proof 失败：${result.stderr || result.stdout || result.error || 'unknown'}`);
  const proof = proofSchema.parse(JSON.parse(result.stdout)) as WslRunnerProof;
  const reason = proofReason(proof, options, runtimeSource);
  if (reason) throw new Error(`WSL runner proof 不可用：${reason}`);
  return proof;
}

export function loadWslTestRunner(proofFile: string, optionsInput: WslRunnerOptions): { runner: WslTestRunner | null; availability: RunnerAvailability; proof?: WslRunnerProof } {
  try {
    const options = normalizeOptions(optionsInput);
    if (!path.isAbsolute(proofFile) || !existsSync(proofFile) || !statSync(proofFile).isFile() || lstatSync(proofFile).isSymbolicLink()) throw new Error('proof 文件不存在或不是普通文件。');
    const parsed = proofSchema.safeParse(JSON.parse(readFileSync(proofFile, 'utf8')));
    if (!parsed.success) throw new Error('WSL proof 结构无效。');
    const proof = parsed.data as WslRunnerProof;
    const runtimeSource = readFileSync(RUNTIME_FILE, 'utf8');
    const reason = proofReason(proof, options, runtimeSource);
    if (reason) throw new Error(reason);
    return { runner: new WslTestRunner(proof, options, runtimeSource), availability: { available: true, platform: 'linux' }, proof };
  } catch (error) {
    return { runner: null, availability: { available: false, platform: 'linux', reason: error instanceof Error ? error.message : String(error) } };
  }
}

export async function createVerifiedWslTestRunner(optionsInput: WslRunnerOptions): Promise<{ runner: WslTestRunner; availability: RunnerAvailability; proof: WslRunnerProof }> {
  const proof = await probeWslTestRunner(optionsInput);
  const options = normalizeOptions(optionsInput);
  const runtimeSource = readFileSync(RUNTIME_FILE, 'utf8');
  return { runner: new WslTestRunner(proof, options, runtimeSource), availability: { available: true, platform: 'linux' }, proof };
}

export class WslTestRunner implements CommandRunner {
  readonly capability = { platform: 'linux' as const };
  private readonly tickets = new Map<string, Ticket>();
  private running = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly proof: WslRunnerProof, private readonly options: NormalizedOptions, private readonly runtimeSource: string) {
    const reason = proofReason(proof, options, runtimeSource);
    if (reason) throw new Error(`WSL runner 不可用：${reason}`);
  }

  commandInfo(): RunnerCommandInfo[] {
    return [{ platform: 'linux', executablePaths: [this.options.linuxNode], network: 'none', writableScope: 'derived-test-copy' }];
  }

  issueTicket(invocationId: string, spec: CommandSpec, allowedRoot: string, ttlMs = 60_000): string {
    const reason = proofReason(this.proof, this.options, this.runtimeSource);
    if (reason) throw new Error(`WSL runner 不可用：${reason}`);
    if (!invocationId) throw new Error('测试票据必须绑定调用身份。');
    if (spec.platform !== 'linux' || spec.network !== 'none') throw new Error('WSL runner 只接受 Linux 无网络命令。');
    if (spec.executable !== this.options.linuxNode) throw new Error('命令可执行文件不在 WSL proof 允许清单中。');
    if (!Number.isInteger(spec.timeoutMs) || spec.timeoutMs < 1 || spec.timeoutMs > 30 * 60_000) throw new Error('命令超时范围无效。');
    if (spec.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('命令参数包含非法字符。');
    for (const [key, value] of Object.entries(spec.env ?? {})) {
      if (!this.options.allowedEnv.includes(key) || isCredentialEnvName(key) || value.includes('\0')) throw new Error(`环境变量不在允许清单中：${key}`);
    }
    const root = canonicalDirectory(allowedRoot);
    if (!inside(root, this.options.workRootWindows)) throw new Error('测试副本不在配置的 WSL 工作根目录内。');
    const cwd = canonicalDirectory(spec.cwd);
    if (!inside(cwd, root)) throw new Error('命令工作目录越过受控副本。');
    const id = `wsl-rt-${randomUUID()}-${randomBytes(8).toString('hex')}`;
    this.tickets.set(id, { id, invocationId, spec: { ...spec, cwd, args: [...spec.args], env: { ...spec.env } }, allowedRoot: root, expiresAt: Date.now() + ttlMs, used: false });
    return id;
  }

  async run(ticketId: string, invocationId: string, signal?: AbortSignal): Promise<RunnerResult> {
    const ticket = this.tickets.get(ticketId);
    if (!ticket || ticket.used || ticket.invocationId !== invocationId || ticket.expiresAt < Date.now()) throw new Error('测试票据无效、已消费、已过期或调用身份不匹配。');
    ticket.used = true;
    await this.acquire(signal);
    try { return await this.execute(ticket, signal); }
    finally { this.release(); }
  }

  private async execute(ticket: Ticket, signal?: AbortSignal): Promise<RunnerResult> {
    const startedAt = Date.now();
    const proofDrift = proofReason(this.proof, this.options, this.runtimeSource);
    if (proofDrift) throw new Error(`WSL runner 不可用：${proofDrift}`);
    const root = canonicalDirectory(ticket.allowedRoot);
    const cwd = canonicalDirectory(ticket.spec.cwd);
    if (!inside(cwd, root)) throw new Error('执行前工作目录已越过受控副本。');
    const files = stageFiles(root);
    const relative = path.win32.relative(root, cwd).split(path.win32.sep).filter(Boolean).join('/');
    const marker = `dmw-wsl-${randomUUID()}`;
    const request = {
      ...runtimeRequest(this.proof, this.options, this.runtimeSource), mode: 'run', files, marker,
      executable: ticket.spec.executable, args: ticket.spec.args, cwd: relative ? `/workspace/${relative}` : '/workspace',
      env: ticket.spec.env ?? {}, timeoutMs: ticket.spec.timeoutMs,
    };
    const child = spawn(this.options.wslExecutable, ['-d', this.options.distro, '--exec', this.options.linuxNode, '--input-type=module', '-e', this.runtimeSource], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = []; const stderrChunks: Buffer[] = []; const runtimeErrors: Buffer[] = [];
    let lineBuffer = ''; let guestPid: number | null = null; let guestStarttime = ''; let stagedRoot = ''; let exitFrame: Record<string, unknown> | null = null;
    let spawnError: string | null = null; let cancelled = false; let hostTimedOut = false; let stopping: Promise<boolean> | null = null;
    let settleIdentity!: () => void;
    const identitySettled = new Promise<void>((resolve) => { settleIdentity = resolve; });
    const append = (target: Buffer[], value: Buffer) => { target.push(value); while (target.reduce((sum, item) => sum + item.length, 0) > 65_536) target.shift(); };
    const parseLine = (line: string) => {
      if (!line) return;
      try {
        const frame = JSON.parse(line) as Record<string, unknown>;
        if (frame.type === 'started' && Number.isInteger(frame.pid) && typeof frame.starttime === 'string' && typeof frame.stagedRoot === 'string' && frame.marker === marker) { guestPid = frame.pid as number; guestStarttime = frame.starttime; stagedRoot = frame.stagedRoot; settleIdentity(); }
        else if ((frame.type === 'stdout' || frame.type === 'stderr') && typeof frame.base64 === 'string') append(frame.type === 'stdout' ? stdoutChunks : stderrChunks, Buffer.from(frame.base64, 'base64'));
        else if (frame.type === 'exit') exitFrame = frame;
      } catch { append(runtimeErrors, Buffer.from(`${line}\n`)); }
    };
    child.stdout.on('data', (chunk) => { lineBuffer += Buffer.from(chunk).toString('utf8'); let index; while ((index = lineBuffer.indexOf('\n')) >= 0) { parseLine(lineBuffer.slice(0, index)); lineBuffer = lineBuffer.slice(index + 1); } });
    child.stderr.on('data', (chunk) => append(runtimeErrors, Buffer.from(chunk)));
    child.once('error', (error) => { spawnError = error.message; settleIdentity(); });
    const close = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('close', (code, childSignal) => { settleIdentity(); resolve({ code, signal: childSignal }); }));
    child.stdin.end(JSON.stringify(request));
    const stop = async (): Promise<boolean> => {
      if (stopping) return stopping;
      stopping = (async () => {
        if (guestPid === null || !guestStarttime) {
          let timer: NodeJS.Timeout | undefined;
          await Promise.race([identitySettled, new Promise<void>((resolve) => { timer = setTimeout(resolve, 5_000); })]);
          if (timer) clearTimeout(timer);
        }
        if (guestPid === null || !guestStarttime) { if (child.pid) await killTree(child.pid, 'win32'); return false; }
        const control = { ...runtimeRequest(this.proof, this.options, this.runtimeSource), mode: 'control', marker, pid: guestPid, starttime: guestStarttime, stagedRoot };
        const result = await invokeWsl(this.options, this.runtimeSource, [], JSON.stringify(control), 12_000);
        let confirmed = false;
        try { confirmed = result.code === 0 && JSON.parse(result.stdout).confirmed === true; } catch { confirmed = false; }
        if (child.pid) await killTree(child.pid, 'win32');
        return confirmed;
      })();
      return stopping;
    };
    const onAbort = () => { cancelled = true; void stop(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const fallbackTimer = setTimeout(() => { hostTimedOut = true; void stop(); }, ticket.spec.timeoutMs + 5_000);
    const closed = await close;
    clearTimeout(fallbackTimer); signal?.removeEventListener('abort', onAbort); if (lineBuffer) parseLine(lineBuffer);
    const finalFrame = exitFrame as Record<string, unknown> | null;
    const treeConfirmed = stopping ? await stopping : finalFrame?.treeConfirmed === true;
    const guestTimedOut = finalFrame?.timedOut === true;
    const reportedExitCode = typeof finalFrame?.code === 'number' ? finalFrame.code : closed.code;
    const exitCode = treeConfirmed ? reportedExitCode : 72;
    const guestSignal = typeof finalFrame?.signal === 'string' ? finalFrame.signal : closed.signal;
    const warning = treeConfirmed ? undefined : '无法确认 WSL guest namespace/process group 已全部结束；runner 已 fail closed。';
    return {
      ticketId: ticket.id, command: [this.options.linuxNode, ...ticket.spec.args], removedEnv: [],
      exitCode, signal: guestSignal, timedOut: guestTimedOut || hostTimedOut, cancelled, spawnError,
      stdoutTail: Buffer.concat(stdoutChunks).toString('utf8'),
      stderrTail: Buffer.concat([...stderrChunks, ...runtimeErrors]).toString('utf8').slice(-65_536),
      durationMs: Date.now() - startedAt, pid: guestPid, ...(warning ? { terminationWarning: warning } : {}),
    };
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('测试请求已取消。');
    if (this.running < this.options.concurrency) { this.running += 1; return; }
    await new Promise<void>((resolve, reject) => {
      const ready = () => { signal?.removeEventListener('abort', aborted); this.running += 1; resolve(); };
      const aborted = () => { const index = this.waiters.indexOf(ready); if (index >= 0) this.waiters.splice(index, 1); reject(new Error('测试请求已取消。')); };
      this.waiters.push(ready); signal?.addEventListener('abort', aborted, { once: true });
    });
  }

  private release(): void { this.running -= 1; this.waiters.shift()?.(); }
}
