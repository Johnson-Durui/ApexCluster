import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess, scrubEnv, type ResolvedCommand } from '../adapters/process.js';
import type { CommandSpec, RunnerResult } from './runner.js';
import type { CommandRunner, RunnerAvailability } from './runner-contract.js';

const AUTH_ENV = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CURSOR_API_KEY', 'XAI_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'];
const SAFE_ENV = ['LANG', 'TZ'];
const RUNNER_CODE = fileURLToPath(import.meta.url);
const REQUIRED = ['insideRead', 'insideWrite', 'outsideReadDenied', 'outsideWriteDenied', 'credentialReadDenied', 'networkDenied', 'childProcessWorks', 'childEscapeDenied', 'normalTreeConfirmed', 'cancelTreeConfirmed', 'runnerModuleVerified'] as const;

export interface WindowsMxcCapability {
  version: 3;
  verified: boolean;
  verifiedAt: string;
  policyVersion: 'windows-mxc-v2';
  policySha256: string;
  codexVersion: string;
  codex: { path: string; sha256: string };
  runnerCode: { path: string; sha256: string };
  profile: string;
  allowedExecutable: { path: string; sha256: string };
  readonlyRoots: { path: string; sha256?: string }[];
  allowedEnv: string[];
  tests: Partial<Record<(typeof REQUIRED)[number], boolean>>;
}

interface Ticket { id: string; invocationId: string; spec: CommandSpec; root: string; expiresAt: number; used: boolean; fingerprint: string; }
function digest(file: string): string { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
function same(a: string, b: string): boolean { return path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase(); }
function inside(file: string, root: string): boolean { const relative = path.relative(root, file); return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)); }
function directory(value: string): string {
  if (!path.isAbsolute(value) || !existsSync(value) || !statSync(value).isDirectory() || lstatSync(value).isSymbolicLink()) throw new Error('受控目录不存在、不是目录或是链接。');
  const canonical = realpathSync.native(value);
  if (!same(canonical, path.resolve(value))) throw new Error('受控目录规范路径已变化。');
  return canonical;
}
function regular(value: string, hash?: string): boolean { return path.isAbsolute(value) && existsSync(value) && statSync(value).isFile() && !lstatSync(value).isSymbolicLink() && (!hash || digest(value) === hash); }
function policyHash(capability: WindowsMxcCapability): string {
  return createHash('sha256').update(JSON.stringify({ version: capability.policyVersion, profile: capability.profile, filesystem: [':root=deny', ':minimal=read', ':workspace_roots=write', ':ticket_root=read', ...capability.readonlyRoots.map(root => `${path.resolve(root.path)}=read`)], network: false, webSearch: 'disabled', probe: 'loopback-listener+explicit-denials+detached-tree-v2' })).digest('hex');
}

/** Validates a capability proof; success means only that the local no-model probes were complete. */
export function validateWindowsMxcCapability(input: unknown): string | null {
  try {
    if (process.platform !== 'win32') return '当前宿主不是 Windows。';
    if (!input || typeof input !== 'object') return 'MXC 能力配置不是对象。';
    const capability = input as WindowsMxcCapability;
    if (capability.version !== 3 || capability.policyVersion !== 'windows-mxc-v2' || capability.verified !== true || typeof capability.verifiedAt !== 'string' || !Number.isFinite(Date.parse(capability.verifiedAt)) || typeof capability.codexVersion !== 'string' || !capability.codexVersion) return 'MXC 能力版本或验证状态无效。';
    if (!/^[A-Za-z0-9_-]+$/.test(capability.profile) || !/^[0-9a-f]{64}$/i.test(capability.policySha256)) return 'MXC profile 或策略哈希无效。';
    if (!capability.codex || !capability.runnerCode || !capability.allowedExecutable || typeof capability.codex.path !== 'string' || typeof capability.runnerCode.path !== 'string' || typeof capability.allowedExecutable.path !== 'string' || !/^[0-9a-f]{64}$/i.test(capability.codex.sha256) || !/^[0-9a-f]{64}$/i.test(capability.runnerCode.sha256) || !/^[0-9a-f]{64}$/i.test(capability.allowedExecutable.sha256)) return 'MXC 可执行文件哈希结构无效。';
    if (!same(realpathSync.native(capability.runnerCode.path), realpathSync.native(RUNNER_CODE)) || !regular(capability.codex.path, capability.codex.sha256) || !regular(capability.allowedExecutable.path, capability.allowedExecutable.sha256) || !regular(capability.runnerCode.path, capability.runnerCode.sha256)) return 'Codex、runner 或允许的测试可执行文件已漂移。';
    if (!Array.isArray(capability.readonlyRoots) || capability.readonlyRoots.length !== 1 || typeof capability.readonlyRoots[0]?.path !== 'string' || !same(directory(capability.readonlyRoots[0].path), directory(path.dirname(capability.allowedExecutable.path)))) return 'MXC 只读根必须为已验证测试运行时目录。';
    if (!Array.isArray(capability.allowedEnv) || capability.allowedEnv.some(key => typeof key !== 'string' || !SAFE_ENV.includes(key)) || new Set(capability.allowedEnv).size !== capability.allowedEnv.length) return 'MXC 允许环境变量无效。';
    if (!capability.tests || typeof capability.tests !== 'object' || !REQUIRED.every(name => capability.tests[name] === true)) return 'MXC 反例证据不完整。';
    if (capability.policySha256 !== policyHash(capability)) return 'MXC 权限策略已漂移。';
    return null;
  } catch { return 'MXC 能力配置无法安全验证。'; }
}

export class WindowsMxcRunner implements CommandRunner {
  readonly capability = { platform: 'windows' as const };
  readonly availability: RunnerAvailability;
  private readonly tickets = new Map<string, Ticket>();
  constructor(readonly proof: WindowsMxcCapability) { const reason = validateWindowsMxcCapability(proof); this.availability = { platform: 'windows', available: !reason, reason: reason ?? undefined }; }
  commandInfo() { return [{ platform: 'windows' as const, executablePaths: [this.proof.allowedExecutable.path], network: 'none' as const, writableScope: 'derived-test-copy' as const }]; }

  issueTicket(invocationId: string, spec: CommandSpec, allowedRoot: string, ttlMs = 60_000): string {
    const reason = validateWindowsMxcCapability(this.proof);
    if (reason) throw new Error(`Windows MXC runner 不可用：${reason}`);
    if (!invocationId || spec.platform !== 'windows' || spec.network !== 'none') throw new Error('测试票据的身份、平台或网络策略无效。');
    if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 30 * 60_000 || !Number.isInteger(spec.timeoutMs) || spec.timeoutMs < 1 || spec.timeoutMs > 30 * 60_000) throw new Error('测试票据超时范围无效。');
    if (!same(spec.executable, this.proof.allowedExecutable.path) || !regular(spec.executable, this.proof.allowedExecutable.sha256) || spec.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('命令不在固定 Windows MXC 允许清单中。');
    const root = directory(allowedRoot); const cwd = directory(spec.cwd);
    if (!inside(cwd, root)) throw new Error('命令工作目录越过受控副本。');
    for (const key of Object.keys(spec.env ?? {})) if (!this.proof.allowedEnv.includes(key) || AUTH_ENV.some(auth => same(auth, key))) throw new Error(`环境变量不在允许清单中：${key}`);
    const id = `wmxc-${randomUUID()}-${randomBytes(8).toString('hex')}`;
    this.tickets.set(id, { id, invocationId, spec: { ...spec, args: [...spec.args], env: { ...spec.env }, cwd }, root, expiresAt: Date.now() + ttlMs, used: false, fingerprint: this.fingerprint() });
    return id;
  }

  async run(ticketId: string, invocationId: string, signal?: AbortSignal): Promise<RunnerResult> {
    const ticket = this.tickets.get(ticketId);
    if (!ticket || ticket.used || ticket.invocationId !== invocationId || ticket.expiresAt < Date.now()) throw new Error('Windows MXC 测试票据无效、已消费、已过期或调用身份不匹配。');
    ticket.used = true;
    const reason = validateWindowsMxcCapability(this.proof);
    if (reason || ticket.fingerprint !== this.fingerprint() || !inside(directory(ticket.spec.cwd), directory(ticket.root))) throw new Error(`执行前 Windows MXC 复核失败：${reason ?? 'runner 或目录已漂移。'}`);
    const profile = this.proof.profile;
    const filesystem = `{":root"="deny",":minimal"="read",":workspace_roots"="write",${JSON.stringify(ticket.root)}="read",${this.proof.readonlyRoots.map(root => `${JSON.stringify(root.path)}="read"`).join(',')}}`;
    const overrides = [`default_permissions="${profile}"`, `permissions.${profile}.filesystem=${filesystem}`, `permissions.${profile}.network.enabled=false`, 'web_search="disabled"'];
    const command: ResolvedCommand = { file: this.proof.codex.path, prefixArgs: [], via: 'direct' };
    const args = ['sandbox', '--enable', 'prefer_mxc', '-C', ticket.spec.cwd, '-P', profile, ...overrides.flatMap(value => ['-c', value]), '--', ticket.spec.executable, ...ticket.spec.args];
    // MXC itself requires this host system location; it is not exposed to the command as an allowed user variable.
    // Node otherwise realpaths each Windows ancestor for a file entry and MXC correctly denies the drive root.
    // This fixed runtime switch also propagates to a controlled Node child; it grants no filesystem access.
    const envInput: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LOCALAPPDATA: process.env.LOCALAPPDATA, TEMP: process.env.TEMP, TMP: process.env.TMP, NODE_OPTIONS: '--preserve-symlinks --preserve-symlinks-main', ...ticket.spec.env };
    const scrubbed = scrubEnv(envInput, AUTH_ENV);
    const result = await runProcess(command, args, { cwd: ticket.spec.cwd, env: scrubbed.env, stdinText: null, timeoutMs: ticket.spec.timeoutMs, signal });
    return { ...result, ticketId, command: [command.file, ...args], removedEnv: scrubbed.removed };
  }
  private fingerprint(): string { return createHash('sha256').update(JSON.stringify({ code: digest(this.proof.codex.path), executable: digest(this.proof.allowedExecutable.path), runner: digest(this.proof.runnerCode.path), codexVersion: this.proof.codexVersion, policy: this.proof.policySha256, roots: this.proof.readonlyRoots.map(root => realpathSync.native(root.path)) })).digest('hex'); }
}

/** Bootstrap helper: malformed, stale, or incomplete proof deliberately yields no runner. */
export function createWindowsMxcRunner(proof: unknown): WindowsMxcRunner | null {
  if (!proof || typeof proof !== 'object') return null;
  const runner = new WindowsMxcRunner(proof as WindowsMxcCapability);
  return runner.availability.available ? runner : null;
}
