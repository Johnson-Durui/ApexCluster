import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod/v4';
import { resolveCommand, runProcess, scrubEnv, type ResolvedCommand, type RunProcessResult } from '../adapters/process.js';
import { CHAT_LIMITS } from './types.js';
import type { RunnerCommandInfo } from './runner-contract.js';

const AUTH_ENV = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CURSOR_API_KEY', 'XAI_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'];

export interface CommandSpec {
  executable: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
  network: 'none';
  platform: 'windows' | 'linux';
}

export interface SandboxCapability {
  version: 1;
  verified: boolean;
  verifiedAt: string;
  platform: CommandSpec['platform'];
  wrapper: string;
  wrapperSha256: string;
  wrapperArgs: string[];
  wrapperDependencies: { path: string; sha256: string }[];
  policyFile: string;
  policySha256: string;
  networkDenied: true;
  childEscapeDenied: true;
  credentialReadDenied: true;
  allowedExecutables: { path: string; sha256: string }[];
  allowedEnv: string[];
}

export interface RunnerResult extends RunProcessResult {
  ticketId: string;
  command: string[];
  removedEnv: string[];
}

interface Ticket { id: string; invocationId: string; spec: CommandSpec; allowedRoot: string; expiresAt: number; used: boolean }

const hashSchema = z.string().regex(/^[0-9a-f]{64}$/i);
const sandboxCapabilitySchema = z.object({
  version: z.literal(1),
  verified: z.boolean(),
  verifiedAt: z.string(),
  platform: z.enum(['windows', 'linux']),
  wrapper: z.string(),
  wrapperSha256: hashSchema,
  wrapperArgs: z.array(z.string()),
  wrapperDependencies: z.array(z.object({ path: z.string(), sha256: hashSchema }).strict()),
  policyFile: z.string(),
  policySha256: hashSchema,
  networkDenied: z.boolean(),
  childEscapeDenied: z.boolean(),
  credentialReadDenied: z.boolean(),
  allowedExecutables: z.array(z.object({ path: z.string(), sha256: hashSchema }).strict()),
  allowedEnv: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)),
}).strict();

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function samePath(a: string, b: string): boolean {
  return path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
}

function canonicalDirectory(directory: string): string {
  if (!path.isAbsolute(directory)) throw new Error('命令工作目录必须是绝对路径。');
  const info = lstatSync(directory);
  const attributes = (info as unknown as { fileAttributes?: number }).fileAttributes ?? 0;
  if (!info.isDirectory() || info.isSymbolicLink() || Boolean(attributes & 0x400)) throw new Error('命令工作目录不能是链接或 junction。');
  const actual = realpathSync.native(directory);
  if (!samePath(actual, path.resolve(directory))) throw new Error('命令工作目录的规范路径已变化。');
  return actual;
}

function inside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export function validateSandboxCapability(input: unknown): string | null {
  const parsed = sandboxCapabilitySchema.safeParse(input);
  if (!parsed.success) return '沙箱能力配置结构无效。';
  const capability = parsed.data;
  if (!capability.verified || !Number.isFinite(Date.parse(capability.verifiedAt))) return '沙箱能力尚未验证。';
  if (!capability.networkDenied || !capability.childEscapeDenied || !capability.credentialReadDenied) return '沙箱反例验证不完整。';
  const hostPlatform = process.platform === 'win32' ? 'windows' : process.platform === 'linux' ? 'linux' : null;
  if (!hostPlatform || capability.platform !== hostPlatform) return '沙箱能力平台与当前宿主不匹配；跨平台 wrapper 尚无独立验证证明。';
  for (const [file, expected, label] of [
    [capability.wrapper, capability.wrapperSha256, '沙箱 wrapper'],
    [capability.policyFile, capability.policySha256, '沙箱策略'],
  ] as const) {
    if (!path.isAbsolute(file) || !existsSync(file) || !statSync(file).isFile() || lstatSync(file).isSymbolicLink()) return `${label}不存在或不是普通文件。`;
    if (!/^[0-9a-f]{64}$/i.test(expected) || sha256(file) !== expected) return `${label}哈希已漂移。`;
  }
  if (!capability.allowedExecutables.length) return '沙箱未绑定允许的可执行文件。';
  for (const argument of capability.wrapperArgs.filter((item) => path.isAbsolute(item))) {
    const dependency = capability.wrapperDependencies.find((item) => samePath(item.path, argument));
    if (!dependency || !existsSync(argument) || lstatSync(argument).isSymbolicLink() || sha256(argument) !== dependency.sha256) {
      return '沙箱 wrapper 依赖缺失或哈希已漂移。';
    }
  }
  for (const executable of capability.allowedExecutables) {
    if (!path.isAbsolute(executable.path) || !existsSync(executable.path) || lstatSync(executable.path).isSymbolicLink() || sha256(executable.path) !== executable.sha256) return '允许的可执行文件缺失或哈希已漂移。';
  }
  return null;
}

export class SandboxRunner {
  private readonly tickets = new Map<string, Ticket>();
  private running = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(readonly capability: SandboxCapability, readonly concurrency = CHAT_LIMITS.runnerConcurrency) {}

  commandInfo(): RunnerCommandInfo[] {
    return [{ platform: this.capability.platform, executablePaths: this.capability.allowedExecutables.map(item => item.path), network: 'none', writableScope: 'derived-test-copy' }];
  }

  issueTicket(invocationId: string, spec: CommandSpec, allowedRoot: string, ttlMs = 60_000): string {
    const reason = validateSandboxCapability(this.capability);
    if (reason) throw new Error(`受控测试能力不可用：${reason}`);
    if (!invocationId) throw new Error('测试票据必须绑定调用身份。');
    if (spec.platform !== this.capability.platform) throw new Error('命令平台与沙箱能力不匹配。');
    if (spec.network !== 'none') throw new Error('测试 runner 不允许网络访问。');
    if (!Number.isInteger(spec.timeoutMs) || spec.timeoutMs < 1 || spec.timeoutMs > 30 * 60_000) throw new Error('命令超时范围无效。');
    if (spec.args.some((arg) => arg.includes('\0'))) throw new Error('命令参数包含非法字符。');
    const executable = this.capability.allowedExecutables.find((candidate) => samePath(candidate.path, spec.executable));
    if (!executable || sha256(executable.path) !== executable.sha256) throw new Error('命令可执行文件不在已验证清单中。');
    const root = canonicalDirectory(allowedRoot);
    const cwd = canonicalDirectory(spec.cwd);
    if (!inside(cwd, root)) throw new Error('命令工作目录越过受控副本。');
    for (const key of Object.keys(spec.env ?? {})) {
      if (!this.capability.allowedEnv.includes(key) || AUTH_ENV.some((item) => item.toLowerCase() === key.toLowerCase())) {
        throw new Error(`环境变量不在允许清单中：${key}`);
      }
    }
    const id = `rt-${randomUUID()}-${randomBytes(8).toString('hex')}`;
    this.tickets.set(id, { id, invocationId, spec: { ...spec, cwd, args: [...spec.args], env: { ...spec.env } }, allowedRoot: root, expiresAt: Date.now() + ttlMs, used: false });
    return id;
  }

  async run(ticketId: string, invocationId: string, signal?: AbortSignal): Promise<RunnerResult> {
    const ticket = this.tickets.get(ticketId);
    if (!ticket || ticket.used || ticket.invocationId !== invocationId || ticket.expiresAt < Date.now()) {
      throw new Error('测试票据无效、已消费、已过期或调用身份不匹配。');
    }
    ticket.used = true;
    const reason = validateSandboxCapability(this.capability);
    if (reason) throw new Error(`受控测试能力不可用：${reason}`);
    await this.acquire(signal);
    try {
      const root = canonicalDirectory(ticket.allowedRoot);
      const cwd = canonicalDirectory(ticket.spec.cwd);
      if (!inside(cwd, root)) throw new Error('执行前工作目录已越过受控副本。');
      const envInput: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, ...ticket.spec.env };
      const scrubbed = scrubEnv(envInput, AUTH_ENV);
      const wrapper: ResolvedCommand = { file: this.capability.wrapper, prefixArgs: [], via: 'direct' };
      const args = [
        ...this.capability.wrapperArgs,
        '--policy', this.capability.policyFile,
        '--cwd', cwd,
        '--network', 'none',
        '--', ticket.spec.executable,
        ...ticket.spec.args,
      ];
      const result = await runProcess(wrapper, args, {
        cwd,
        env: scrubbed.env,
        stdinText: null,
        timeoutMs: ticket.spec.timeoutMs,
        signal,
      });
      return { ...result, ticketId, command: [this.capability.wrapper, ...args], removedEnv: scrubbed.removed };
    } finally {
      this.release();
    }
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    if (this.running < this.concurrency) {
      this.running += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        signal?.removeEventListener('abort', aborted);
        this.running += 1;
        resolve();
      };
      const aborted = () => {
        const index = this.waiters.indexOf(ready);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error('测试请求已取消。'));
      };
      this.waiters.push(ready);
      signal?.addEventListener('abort', aborted, { once: true });
    });
  }

  private release(): void {
    this.running -= 1;
    this.waiters.shift()?.();
  }
}

/** 从固定配置名解析可执行文件只用于宿主生成 CommandSpec；模型输出不能传到这里。 */
export function resolvedExecutable(name: string): string {
  const resolved = resolveCommand(name);
  if (!resolved || resolved.prefixArgs.length || resolved.via === 'cmd-fallback') throw new Error(`无法把 ${name} 解析为无 shell 的固定可执行文件。`);
  return resolved.file;
}
