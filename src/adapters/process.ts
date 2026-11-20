/**
 * 跨平台子进程层（重点照顾 Windows）。
 *
 * - 提示词一律经 stdin（UTF-8）传入；命令行只放工作台自己生成的固定参数和文件路径，绝不拼接浏览器输入。
 * - 解析可执行文件：优先 .exe；遇到 npm 生成的 .cmd 垫片时，解析出真实目标，
 *   JS 目标改为用当前 node 直接运行，exe 目标直接运行，都不经过 cmd.exe；解析失败才退回 cross-spawn（它负责 cmd.exe 转义）。
 * - 输出用 StringDecoder 解码，避免中文多字节字符被分块截断；按 \n 分行并去掉 \r。
 * - 超时 / 取消：结束整个进程树（Windows: taskkill /T /F；POSIX: 进程组 SIGTERM → SIGKILL）。
 * - 认证类环境变量默认从子进程环境中移除，防止“订阅模式”被环境里的 API key 悄悄改成按量计费。
 */
import { spawn as nodeSpawn } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import { createWriteStream, existsSync, readFileSync, readdirSync, statSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { CommandOverride } from './types.js';

export interface ResolvedCommand {
  file: string;
  prefixArgs: string[];
  via: 'config' | 'direct' | 'node-shim' | 'exe-shim' | 'cmd-fallback';
}

/** 解析 npm cmd-shim 生成的 .cmd 文件，取出真实目标（相对 shim 所在目录） */
export function parseCmdShim(content: string, shimDir: string): { target: string; isNode: boolean } | null {
  // 典型行： "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
  // 或：     "%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*
  const re = /"%(?:~)?dp0%?\\([^"]+)"\s+%\*/gi;
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(content)) !== null) last = m[1] ?? null;
  if (!last) return null;
  const target = path.win32.join(shimDir, last);
  const isNode = /\.(c|m)?js$/i.test(last);
  return { target, isNode };
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function desktopCodexCommand(env: NodeJS.ProcessEnv, configuredBinDir?: string): string | null {
  const binDir = configuredBinDir ?? (env.LOCALAPPDATA ? path.win32.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin') : null);
  if (!binDir) return null;
  try {
    return readdirSync(binDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        try {
          const dir = path.win32.join(binDir, entry.name);
          return [{ command: path.win32.join(dir, 'codex.exe'), mtimeMs: statSync(dir).mtimeMs, name: entry.name }];
        } catch {
          return [];
        }
      })
      .filter((candidate) => isFile(candidate.command))
      .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))[0]?.command ?? null;
  } catch {
    return null;
  }
}

function missingManagedCodexBin(name: string, override: CommandOverride, env: NodeJS.ProcessEnv): string | null {
  if (name.toLowerCase() !== 'codex' || isFile(override.command)) return null;
  const configuredBin = path.win32.dirname(path.win32.dirname(override.command));
  const envBin = env.LOCALAPPDATA ? path.win32.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin') : null;
  if (configuredBin.toLowerCase() !== envBin?.toLowerCase() && !configuredBin.toLowerCase().endsWith('\\openai\\codex\\bin')) return null;
  const relative = path.win32.relative(configuredBin, override.command);
  const parts = relative.split(path.win32.sep);
  return parts.length === 2 && /^[0-9a-f]+$/i.test(parts[0] ?? '') && parts[1]?.toLowerCase() === 'codex.exe' ? configuredBin : null;
}

export function resolveCommand(
  name: string,
  opts: { override?: CommandOverride | null; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; nodePath?: string } = {},
): ResolvedCommand | null {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const configuredCodexBin = platform === 'win32' && opts.override ? missingManagedCodexBin(name, opts.override, env) : null;
  if (opts.override && !configuredCodexBin) {
    return { file: opts.override.command, prefixArgs: opts.override.args ?? [], via: 'config' };
  }
  const recoveredArgs = configuredCodexBin ? opts.override?.args ?? [] : [];
  const nodePath = opts.nodePath ?? process.execPath;
  const pathVar = env.PATH ?? env.Path ?? '';
  const dirs = pathVar.split(platform === 'win32' ? ';' : ':').filter(Boolean);
  if (platform !== 'win32') {
    for (const d of dirs) {
      const p = path.join(d, name);
      if (isFile(p)) return { file: p, prefixArgs: [], via: 'direct' };
    }
    return null;
  }
  // Windows：先找 .exe/.com，再找 .cmd/.bat 垫片
  for (const ext of ['.exe', '.com']) {
    for (const d of dirs) {
      const p = path.win32.join(d, name + ext);
      if (isFile(p)) return { file: p, prefixArgs: recoveredArgs, via: 'direct' };
    }
  }
  for (const ext of ['.cmd', '.bat']) {
    for (const d of dirs) {
      const p = path.win32.join(d, name + ext);
      if (!isFile(p)) continue;
      try {
        const shim = parseCmdShim(readFileSync(p, 'utf8'), d);
        if (shim && existsSync(shim.target)) {
          return shim.isNode
            ? { file: nodePath, prefixArgs: [shim.target, ...recoveredArgs], via: 'node-shim' }
            : { file: shim.target, prefixArgs: recoveredArgs, via: 'exe-shim' };
        }
      } catch {
        /* 退回 cross-spawn */
      }
      return { file: p, prefixArgs: recoveredArgs, via: 'cmd-fallback' };
    }
  }
  if (name.toLowerCase() === 'codex') {
    const command = desktopCodexCommand(env, configuredCodexBin ?? undefined);
    if (command) return { file: command, prefixArgs: recoveredArgs, via: 'direct' };
  }
  return null;
}

/** 任意供应商/扩展的 API key 变量都不能继承到受限子进程。 */
export function isApiKeyEnvName(key: string): boolean {
  return /_API_KEY$/i.test(key);
}

/** 从环境中移除认证/计费相关变量，只返回被移除的变量名（不记录值） */
export function scrubEnv(env: NodeJS.ProcessEnv, keys: string[]): { env: NodeJS.ProcessEnv; removed: string[] } {
  const out: NodeJS.ProcessEnv = { ...env };
  const removed: string[] = [];
  for (const k of keys) {
    let found = false;
    for (const actual of Object.keys(out)) {
      if (actual.toLowerCase() === k.toLowerCase() && out[actual] !== undefined) {
        delete out[actual];
        found = true;
      }
    }
    if (found) removed.push(k);
  }
  for (const actual of Object.keys(out)) {
    if (isApiKeyEnvName(actual) && out[actual] !== undefined) {
      delete out[actual];
      removed.push(actual);
    }
  }
  return { env: out, removed };
}

export async function killTree(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  graceMs = 3000,
  taskkillCommand = 'taskkill',
): Promise<boolean> {
  if (platform === 'win32') {
    return new Promise<boolean>((resolve) => {
      const p = nodeSpawn(taskkillCommand, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      p.once('error', () => resolve(false));
      p.once('close', (code) => resolve(code === 0));
    });
  }
  const alive = () => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return true;
    }
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!alive()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* 已退出 */
  }
  return !alive();
}

export interface RunProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdinText: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** 操作系统确认子进程创建成功时立即调用。 */
  onStarted?: (pid: number) => void;
  stdoutLogPath?: string;
  stderrLogPath?: string;
  /** 内存中保留的尾部字节数（完整内容在日志文件里） */
  tailBytes?: number;
  platform?: NodeJS.Platform;
  /** 仅供确定性测试 Windows taskkill 失败路径；生产环境不要设置。 */
  taskkillCommand?: string;
}

export interface RunProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  spawnError: string | null;
  stdoutTail: string;
  stderrTail: string;
  durationMs: number;
  pid: number | null;
  /** 无法确认整棵进程树已结束时的诊断；直接子进程仍会用句柄兜底终止。 */
  terminationWarning?: string;
}

class LineSplitter {
  private decoder = new StringDecoder('utf8');
  private buf = '';
  constructor(private onLine?: (line: string) => void) {}
  push(chunk: Buffer): string {
    const text = this.decoder.write(chunk);
    this.emit(text);
    return text;
  }
  end(): string {
    const text = this.decoder.end();
    this.emit(text);
    if (this.buf.length) {
      this.onLine?.(this.buf.replace(/\r$/, ''));
      this.buf = '';
    }
    return text;
  }
  private emit(text: string): void {
    if (!text) return;
    this.buf += text;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      this.onLine?.(line);
    }
  }
}

function appendTail(tail: string, add: string, max: number): string {
  const t = tail + add;
  return t.length > max ? t.slice(t.length - max) : t;
}

export function runProcess(cmd: ResolvedCommand, args: string[], opts: RunProcessOptions): Promise<RunProcessResult> {
  const platform = opts.platform ?? process.platform;
  const tailMax = opts.tailBytes ?? 1_000_000;
  const started = Date.now();
  return new Promise((resolve) => {
    let stdoutTail = '';
    let stderrTail = '';
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let outLog: WriteStream | null = null;
    let errLog: WriteStream | null = null;
    if (opts.stdoutLogPath) outLog = createWriteStream(opts.stdoutLogPath, { flags: 'a' });
    if (opts.stderrLogPath) errLog = createWriteStream(opts.stderrLogPath, { flags: 'a' });
    let timer: NodeJS.Timeout | undefined;
    let child: ReturnType<typeof nodeSpawn> | null = null;
    let spawnedPid: number | null = null;
    let killPromise: Promise<void> | null = null;
    let terminationWarning: string | undefined;

    const kill = () => {
      const proc = child;
      if (!proc?.pid || killPromise) return;
      const pid = proc.pid;
      killPromise = killTree(pid, platform, 3000, opts.taskkillCommand).then((treeConfirmed) => {
        if (!treeConfirmed) {
          terminationWarning = '无法确认整个子进程树已结束；已兜底终止直接子进程，孙进程可能仍在运行。';
        }
        // 先尝试进程树终止；若整树终止失败，再用直接子进程句柄避免调用永久悬挂。
        if (!treeConfirmed && proc.exitCode === null && proc.signalCode === null) {
          try {
            proc.kill();
          } catch {
            /* 已退出 */
          }
        }
      });
    };
    const onAbort = () => {
      cancelled = true;
      kill();
    };
    const finish = (r: Omit<RunProcessResult, 'durationMs' | 'stdoutTail' | 'stderrTail' | 'timedOut' | 'cancelled'>) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      const close = (s: WriteStream | null) => new Promise<void>((res) => (s ? s.end(() => res()) : res()));
      const termination = killPromise ?? Promise.resolve();
      void termination
        .then(() => Promise.all([close(outLog), close(errLog)]))
        .then(() => resolve({ ...r, stdoutTail, stderrTail, timedOut, cancelled, durationMs: Date.now() - started, ...(terminationWarning ? { terminationWarning } : {}) }));
    };

    const spawnFn = cmd.via === 'cmd-fallback' ? crossSpawn : nodeSpawn;
    try {
      child = spawnFn(cmd.file, [...cmd.prefixArgs, ...args], {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // POSIX 下建立独立进程组，才能整组结束；Windows 下 detached 会弹出新控制台，不能用
        detached: platform !== 'win32',
        shell: false,
      });
    } catch (e) {
      finish({ exitCode: null, signal: null, spawnError: (e as Error).message, pid: null });
      return;
    }
    const proc = child;

    proc.once('spawn', () => {
      if (proc.pid === undefined) return;
      spawnedPid = proc.pid;
      opts.onStarted?.(proc.pid);
    });

    timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const outSplit = new LineSplitter(opts.onStdoutLine);
    const errSplit = new LineSplitter(opts.onStderrLine);
    proc.stdout?.on('data', (c: Buffer) => {
      outLog?.write(c);
      stdoutTail = appendTail(stdoutTail, outSplit.push(c), tailMax);
    });
    proc.stderr?.on('data', (c: Buffer) => {
      errLog?.write(c);
      stderrTail = appendTail(stderrTail, errSplit.push(c), tailMax);
    });
    proc.stdin?.on('error', () => {
      /* 子进程提前退出导致 EPIPE：忽略，由退出码判断 */
    });
    if (opts.stdinText !== null) proc.stdin?.end(Buffer.from(opts.stdinText, 'utf8'));
    else proc.stdin?.end();

    proc.on('error', (e) => {
      finish({ exitCode: null, signal: null, spawnError: e.message, pid: spawnedPid });
    });
    proc.on('close', (code, sig) => {
      stdoutTail = appendTail(stdoutTail, outSplit.end(), tailMax);
      stderrTail = appendTail(stderrTail, errSplit.end(), tailMax);
      finish({ exitCode: code, signal: sig ?? null, spawnError: null, pid: spawnedPid });
    });
  });
}

/** 运行一个简单命令并取输出（用于 --version / auth status 之类的只读探测） */
export async function runSimple(
  cmd: ResolvedCommand,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<RunProcessResult> {
  return runProcess(cmd, args, {
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env ?? process.env,
    stdinText: null,
    timeoutMs: opts.timeoutMs ?? 30_000,
    signal: opts.signal,
  });
}

/** 生成可读的命令行（用于记录；不含提示词） */
export function describeCommand(cmd: ResolvedCommand, args: string[]): string[] {
  return [cmd.file, ...cmd.prefixArgs, ...args];
}
