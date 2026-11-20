import crypto, { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess, type ResolvedCommand, type RunProcessOptions, type RunProcessResult } from '../adapters/process.js';

export interface ChatWindowsJobOptions extends RunProcessOptions {
  supervisorPath: string;
  receiptDirectory: string;
  /** Deterministic EOF-path regression only; production callers must not set this. */
  testOnlyDisconnectControlAfterResume?: boolean;
  /** Deterministic READY/connect race regression only; production callers must not set these. */
  testOnlyControlConnectDelayMs?: number;
  testOnlyOnReady?: () => void;
  /** Deterministic process-boundary regression only; production callers must not set this. */
  testOnlyRunProcess?: typeof runProcess;
}
export type WindowsJobProcessPhase = 'pre_dispatch' | 'post_dispatch';
export class WindowsJobProcessError extends Error {
  constructor(message: string, public readonly exitConfirmed: boolean, public readonly phase: WindowsJobProcessPhase) { super(message); this.name = 'WindowsJobProcessError'; }
}
export interface WindowsJobReceipt { version: 1; rootPid: number | null; rootExited: boolean; activeProcesses: number | null; activeBeforeStop: number | null; jobConfirmed: boolean; cancelReceived: boolean; exitCode: number | null; helperError: string | null; ready?: boolean; resumed?: boolean }
export interface ChatWindowsJobResult extends RunProcessResult { windowsJob: {
  protocol: 1; ready: boolean; final: boolean; jobActiveProcesses: number | null; targetPid: number | null; resumed: boolean; confirmed: boolean;
  activeBeforeStop: number | null; rootExited: boolean; cancelReceived: boolean; targetExitCode: number | null;
} }
export interface ChatWindowsJobSupervisorAssets { binaryPath: string; sourceCsSha256: string; wrapperSha256: string; binarySha256: string; compilerSha256: string; manifestSha256: string; protocol: 1 }
const digest = (file: string) => crypto.createHash('sha256').update(readFileSync(file)).digest('hex');
const MAX_WINDOWS_LEGACY_PATH = 260;
const MAX_RECEIPT_TEMP_NAME = 46; // .j- + 10 digit pid + - + 32 hex UUID
const RECEIPT_PREFIXES = new Set(['claude-job-control-', 'codex-job-control-']);
const FIXED_UUID_SHAPE = '00000000-0000-0000-0000-000000000000';
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
export function windowsJobReceiptPath(directory: string, id = randomUUID()): string {
  const file = path.join(directory, `j-${id}`);
  if (file.length >= MAX_WINDOWS_LEGACY_PATH || directory.length + 1 + MAX_RECEIPT_TEMP_NAME >= MAX_WINDOWS_LEGACY_PATH) throw new Error('Windows Job receipt path exceeds the legacy safe limit');
  return file;
}
export function validateChatWindowsJobReceiptRoot(baseDirectory: string, testOnlyWritableProbe?: (directory: string) => void): string {
  try {
    if (!path.isAbsolute(baseDirectory) || !existsSync(baseDirectory)) throw new Error('Windows Job receipt root must be an existing absolute directory');
    const resolved = path.resolve(baseDirectory), real = realpathSync(baseDirectory);
    const same = process.platform === 'win32' ? resolved.toLowerCase() === real.toLowerCase() : resolved === real;
    const info = lstatSync(baseDirectory);
    if (!same || !info.isDirectory() || info.isSymbolicLink()) throw new Error('Windows Job receipt root is unsafe');
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('Windows Job receipt root owner mismatch');
    for (const prefix of RECEIPT_PREFIXES) windowsJobReceiptPath(path.join(real, `${prefix}xxxxxx`), FIXED_UUID_SHAPE);
    if (testOnlyWritableProbe) testOnlyWritableProbe(real);
    else {
      accessSync(real, constants.W_OK);
      const probe = path.join(real, `.receipt-write-check-${process.pid}-${randomUUID()}`);
      try { writeFileSync(probe, 'ok', { flag: 'wx', mode: 0o600 }); } finally { if (existsSync(probe)) unlinkSync(probe); }
    }
    return real;
  } catch (error) {
    throw error instanceof WindowsJobProcessError ? error : new WindowsJobProcessError(errorMessage(error), true, 'pre_dispatch');
  }
}
export function createChatWindowsJobReceiptDirectory(prefix: 'claude-job-control-' | 'codex-job-control-', baseDirectory: string): string {
  if (!RECEIPT_PREFIXES.has(prefix)) throw new WindowsJobProcessError('Windows Job receipt prefix is not authorized', true, 'pre_dispatch');
  let directory: string | undefined;
  try {
    const receiptRoot = validateChatWindowsJobReceiptRoot(baseDirectory);
    directory = mkdtempSync(path.join(receiptRoot, prefix));
    chmodSync(directory, 0o700);
    const info = lstatSync(directory);
    if (path.dirname(directory) !== receiptRoot || !info.isDirectory() || info.isSymbolicLink()) throw new Error('Windows Job receipt directory is unsafe');
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('Windows Job receipt directory owner mismatch');
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('Windows Job receipt directory permissions are too broad');
    windowsJobReceiptPath(directory, FIXED_UUID_SHAPE);
    return directory;
  } catch (error) {
    if (directory) try { rmSync(directory, { recursive: true, force: true }); } catch { /* creation failure remains primary */ }
    throw error instanceof WindowsJobProcessError ? error : new WindowsJobProcessError(errorMessage(error), true, 'pre_dispatch');
  }
}
export function loadChatWindowsJobSupervisorAssets(): ChatWindowsJobSupervisorAssets {
  const wrapper = fileURLToPath(import.meta.url), directory = path.dirname(wrapper), binaryPath = path.join(directory, 'windows-job-supervisor.exe'), source = path.join(directory, 'windows-job-supervisor.cs'), manifestFile = path.join(directory, 'windows-job-supervisor.manifest.json');
  for (const file of [wrapper, binaryPath, source, manifestFile]) { if (!existsSync(file)) throw new Error(`Windows Job supervisor asset missing: ${path.basename(file)}`); const info = lstatSync(file); if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Windows Job supervisor asset unsafe: ${path.basename(file)}`); }
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, unknown>;
  if (manifest.protocol !== 1 || !['sourceCsSha256', 'wrapperSha256', 'binarySha256', 'compilerSha256'].every(key => typeof manifest[key] === 'string' && /^[a-f0-9]{64}$/.test(manifest[key] as string))) throw new Error('Windows Job supervisor manifest invalid');
  if (digest(source) !== manifest.sourceCsSha256 || digest(wrapper) !== manifest.wrapperSha256 || digest(binaryPath) !== manifest.binarySha256) throw new Error('Windows Job supervisor assets drifted');
  return { binaryPath, sourceCsSha256: manifest.sourceCsSha256 as string, wrapperSha256: manifest.wrapperSha256 as string, binarySha256: manifest.binarySha256 as string, compilerSha256: manifest.compilerSha256 as string, manifestSha256: digest(manifestFile), protocol: 1 };
}
export function buildWindowsJobRequest(cmd: ResolvedCommand, args: string[], cwd: string): { file: string; args: string[]; cwd: string } {
  return { file: cmd.file, args: [...cmd.prefixArgs, ...args], cwd };
}
async function connectControl(name: string): Promise<Socket> {
  const deadline = Date.now() + 5_000;
  for (;;) { try { return await new Promise<Socket>((resolve, reject) => { const socket = createConnection({ path: `\\\\.\\pipe\\${name}`, allowHalfOpen: true }, () => resolve(socket)); socket.once('error', reject); }); }
    catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 25)); } }
}
export function windowsJobFinalConfirmed(receipt: WindowsJobReceipt | null, helper: RunProcessResult): boolean {
  return receipt?.version === 1 && receipt.rootExited === true && receipt.activeProcesses === 0 && receipt.jobConfirmed === true && receipt.helperError === null
    && Number.isInteger(receipt.rootPid) && (receipt.rootPid ?? 0) > 0
    && helper.exitCode === 0 && helper.signal === null && helper.spawnError === null && helper.timedOut === false && !helper.terminationWarning;
}
export async function runChatWindowsJobProcess(cmd: ResolvedCommand, args: string[], opts: ChatWindowsJobOptions): Promise<RunProcessResult | ChatWindowsJobResult> {
  const processRunner = opts.testOnlyRunProcess ?? runProcess;
  const { testOnlyRunProcess: _testOnlyRunProcess, ...processOptions } = opts;
  if ((opts.platform ?? process.platform) !== 'win32') return processRunner(cmd, args, processOptions);
  let receiptDirectory: string, pipe: string, receiptFile: string, encoded: string;
  try {
    if (cmd.via === 'cmd-fallback') throw new Error('Windows Job supervisor does not execute cmd fallback shims');
    if (!path.isAbsolute(opts.supervisorPath) || !existsSync(opts.supervisorPath) || !lstatSync(opts.supervisorPath).isFile() || lstatSync(opts.supervisorPath).isSymbolicLink()) throw new Error('Windows Job supervisor binary unavailable');
    receiptDirectory = opts.receiptDirectory;
    if (!path.isAbsolute(receiptDirectory) || !existsSync(receiptDirectory)) throw new Error('Windows Job receipt directory must be an existing absolute directory');
    const receiptInfo = lstatSync(receiptDirectory);
    if (!receiptInfo.isDirectory() || receiptInfo.isSymbolicLink()) throw new Error('Windows Job receipt directory is unsafe');
    const id = randomUUID(); pipe = `dmw-chat-job-${id}`; receiptFile = windowsJobReceiptPath(receiptDirectory, id);
    encoded = Buffer.from(JSON.stringify(buildWindowsJobRequest(cmd, args, opts.cwd)), 'utf8').toString('base64');
  } catch (error) {
    throw error instanceof WindowsJobProcessError ? error : new WindowsJobProcessError(errorMessage(error), true, 'pre_dispatch');
  }
  let timedOut = false, cancelled = false, resumed = false, startedPid: number | null = null;
  let controlPromise: Promise<void> | null = null, controlSocket: Socket | null = null, controlError: string | null = null;
  const sendCancel = () => {
    cancelled = cancelled || !!opts.signal?.aborted;
    if (!resumed || !controlSocket || controlSocket.destroyed) return;
    controlSocket.end(Buffer.from([1]));
  };
  const onAbort = () => { cancelled = true; sendCancel(); }; if (opts.signal?.aborted) cancelled = true; else opts.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; sendCancel(); }, opts.timeoutMs), started = Date.now();
  const startPoll = setInterval(() => {
    if (startedPid !== null) return;
    try {
      const initial = JSON.parse(readFileSync(receiptFile, 'utf8')) as WindowsJobReceipt;
      if (initial.ready !== true || !Number.isInteger(initial.rootPid) || (initial.rootPid ?? 0) <= 0) return;
      const pid = initial.rootPid as number;
      startedPid = pid;
      opts.testOnlyOnReady?.();
      controlPromise = (async () => {
        if ((opts.testOnlyControlConnectDelayMs ?? 0) > 0) await new Promise(resolve => setTimeout(resolve, opts.testOnlyControlConnectDelayMs));
        return connectControl(pipe);
      })().then(socket => {
        controlSocket = socket;
        const command: 1 | 2 = cancelled || timedOut ? 1 : 2;
        socket.write(Buffer.from([command]));
        if (command === 1) socket.end();
        if (command === 2) {
          resumed = true;
          opts.onStarted?.(pid);
          if (opts.testOnlyDisconnectControlAfterResume) socket.end(); else if (cancelled || timedOut) sendCancel();
        }
      });
      void controlPromise.catch(error => { controlError = error instanceof Error ? error.message : String(error); });
    } catch { /* READY receipt not written yet */ }
  }, 10);
  let helper: RunProcessResult;
  try { helper = await processRunner({ file: opts.supervisorPath, prefixArgs: [], via: 'direct' }, [encoded, pipe, receiptFile], { ...processOptions, onStarted: undefined, signal: undefined, timeoutMs: opts.timeoutMs + 15_000, platform: 'win32' }); }
  catch (error) { clearInterval(startPoll); clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort); sendCancel(); (controlSocket as Socket | null)?.destroy(); throw new WindowsJobProcessError(errorMessage(error), false, 'post_dispatch'); }
  clearInterval(startPoll); clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort);
  try { await controlPromise; } catch { /* final receipt is authoritative */ }
  let receipt: WindowsJobReceipt | null = null; try { receipt = JSON.parse(readFileSync(receiptFile, 'utf8')) as WindowsJobReceipt; } catch { /* fail closed */ }
  const valid = windowsJobFinalConfirmed(receipt, helper);
  if (valid) { try { if (existsSync(receiptFile)) unlinkSync(receiptFile); } catch { /* confirmed receipt cleanup is best effort */ } }
  (controlSocket as Socket | null)?.destroy();
  const targetPid = receipt?.rootPid ?? null;
  return { ...helper, pid: targetPid, exitCode: valid ? receipt!.exitCode : helper.exitCode, timedOut: timedOut || helper.timedOut, cancelled, durationMs: Date.now() - started, ...(valid ? {} : { terminationWarning: helper.terminationWarning ?? `Windows Job Object 未确认：${receipt?.helperError ?? controlError ?? 'receipt missing or incomplete'}` }), windowsJob: {
    protocol: 1, ready: receipt?.ready === true, final: !!receipt, jobActiveProcesses: receipt?.activeProcesses ?? null, targetPid, resumed: receipt?.resumed === true, confirmed: !!valid,
    activeBeforeStop: receipt?.activeBeforeStop ?? null, rootExited: receipt?.rootExited === true, cancelReceived: receipt?.cancelReceived === true, targetExitCode: receipt?.exitCode ?? null,
  } };
}
