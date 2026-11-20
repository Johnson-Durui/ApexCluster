import crypto from 'node:crypto';
import type { RunProcessResult } from '../adapters/process.js';
import {
  cursorWriteAvailability,
  type CursorWriteCapabilities,
  type CursorWriterBridge,
  type CursorWriterLifecycle,
  type CursorWriterProbe,
  type CursorWriterSnapshot,
} from '../adapters/cursor-writer.js';
import { CURSOR_DENY_ALL, SystemWslCursorDenyBridge } from './cursor-deny-bridge.js';
import { verifyCursorNativeToolExclusion } from './cursor-native-tool-exclusion.js';

export interface IsolatedCursorRoundOptions {
  capabilities: CursorWriteCapabilities;
  prompt: string;
  signal: AbortSignal;
  timeoutMs: number;
  stdoutLogPath: string;
  stderrLogPath: string;
  onStdoutLine(line: string): void;
  onStderrLine?(line: string): void;
  bridge?: CursorWriterBridge;
  /** Deterministic no-model test seam. Production always runs the fixed WSL artifact verifier. */
  nativeToolExclusionVerifier?: typeof verifyCursorNativeToolExclusion;
}

export interface IsolatedCursorRoundResult extends RunProcessResult {
  exitConfirmed: true;
  lifecycle?: CursorWriterLifecycle;
  probe?: CursorWriterProbe;
  snapshot?: CursorWriterSnapshot;
  nativeToolDetected?: boolean;
}

export class CursorIsolationError extends Error {
  constructor(message: string, public readonly exitConfirmed: boolean) {
    super(message);
    this.name = 'CursorIsolationError';
  }
}

export function validateCursorIsolationProbe(cap: CursorWriteCapabilities, probe: CursorWriterProbe): string | null {
  const availability = cursorWriteAvailability(cap);
  if (!availability.available) return availability.reason;
  if (probe.uid <= 0 || probe.machineId !== cap.machineId || probe.kernel !== cap.kernel || probe.version !== cap.cliVersion) return 'Cursor WSL 身份或版本已漂移';
  if (probe.nodeSha256 !== cap.nodeSha256 || probe.entrySha256 !== cap.entrySha256 || probe.bwrapSha256 !== cap.bwrapSha256 || probe.setsidSha256 !== cap.setsidSha256) return 'Cursor WSL 可信工具哈希已漂移';
  if (!probe.bwrapSecure || !probe.setsidSecure || !probe.automountDisabled || !probe.interopDisabled || !probe.drvfsAbsent) return 'Cursor WSL 隔离环境未保持 H7 安全状态';
  return null;
}

export function cursorNativeToolEvent(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(cursorNativeToolEvent);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => /^(?:tool_call|tool_calls|tool_use|toolCall|\w+ToolCall)$/i.test(key)
    || (key === 'type' && typeof child === 'string' && /^(?:tool_call|tool_use)$/i.test(child))
    || cursorNativeToolEvent(child));
}

export function validateCursorDenyAllSnapshot(snapshot: CursorWriterSnapshot): void {
  if (snapshot.files.length !== 1 || snapshot.files[0]?.path !== '.cursor/cli.json' || snapshot.files[0].type !== 'file' || !snapshot.files[0].base64) {
    throw new Error('Grok deny_all 工作区出现未授权内容');
  }
  let policy: any;
  try { policy = JSON.parse(Buffer.from(snapshot.files[0].base64, 'base64').toString('utf8')); }
  catch { throw new Error('Grok deny_all 策略不是有效 JSON'); }
  if (!policy || Object.keys(policy).join(',') !== 'permissions' || !Array.isArray(policy?.permissions?.allow) || policy.permissions.allow.length !== 0
    || !Array.isArray(policy?.permissions?.deny) || JSON.stringify(policy.permissions.deny) !== JSON.stringify(CURSOR_DENY_ALL)) {
    throw new Error('Grok deny_all 策略内容已漂移');
  }
}

export async function runIsolatedCursorRound(options: IsolatedCursorRoundOptions): Promise<IsolatedCursorRoundResult> {
  const deadline = Date.now() + options.timeoutMs;
  const bridge = options.bridge ?? new SystemWslCursorDenyBridge();
  const id = crypto.randomUUID();
  const root = `/home/codex/.dual-model-workbench/writer-${id}`;
  const marker = `DMW_CURSOR_${id.replaceAll('-', '_').toUpperCase()}`;
  const runAbort = new AbortController();
  const forwardAbort = () => runAbort.abort();
  options.signal.addEventListener('abort', forwardAbort, { once: true });
  if (options.signal.aborted) runAbort.abort();
  const deadlineTimer = setTimeout(() => runAbort.abort(), Math.max(0, options.timeoutMs));
  let setupAttempted = false;
  let dispatchAttempted = false;
  let lifecycle: CursorWriterLifecycle | null = null;
  let nativeToolDetected = false;
  let probe: CursorWriterProbe | null = null;
  try {
    await (options.nativeToolExclusionVerifier ?? verifyCursorNativeToolExclusion)(options.capabilities, runAbort.signal);
    probe = await bridge.probe(options.capabilities, runAbort.signal);
    const drift = validateCursorIsolationProbe(options.capabilities, probe);
    if (drift) throw new CursorIsolationError(drift, true);
    setupAttempted = true;
    await bridge.setup(options.capabilities, root, [], runAbort.signal);
    if (runAbort.signal.aborted) throw new CursorIsolationError('Grok 隔离回合已取消或超时', true);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new CursorIsolationError('Grok 隔离回合在派发前超时', true);
    dispatchAttempted = true;
    const process = await bridge.run(options.capabilities, {
      root, marker, nodePath: options.capabilities.nodePath, entryPath: options.capabilities.entryPath, bwrapPath: options.capabilities.bwrapPath,
    }, options.prompt, {
      signal: runAbort.signal,
      timeoutMs: remaining,
      stdoutLogPath: options.stdoutLogPath,
      stderrLogPath: options.stderrLogPath,
      onStarted: () => undefined,
      onStdoutLine: (line) => {
        try { if (cursorNativeToolEvent(JSON.parse(line))) { nativeToolDetected = true; runAbort.abort(); } } catch { /* protocol parser owns malformed output */ }
        options.onStdoutLine(line);
      },
      onStderrLine: options.onStderrLine ?? (() => undefined),
    });
    lifecycle = await bridge.control(options.capabilities, root, marker);
    if (!lifecycle.confirmed || !lifecycle.supervisorGone || !lifecycle.bwrapGone || lifecycle.remaining.length) throw new CursorIsolationError('Grok 隔离进程树退出状态未确认', false);
    const snapshot = await bridge.inspect(options.capabilities, root, new AbortController().signal);
    validateCursorDenyAllSnapshot(snapshot);
    await bridge.cleanup(options.capabilities, root, marker, new AbortController().signal);
    return { ...process, exitConfirmed: true, lifecycle, probe, snapshot, nativeToolDetected };
  } catch (error) {
    if (setupAttempted && dispatchAttempted && !lifecycle) {
      try { lifecycle = await bridge.control(options.capabilities, root, marker); } catch { /* exit remains unconfirmed */ }
    }
    const reportedExit = error && typeof error === 'object' && typeof (error as { exitConfirmed?: unknown }).exitConfirmed === 'boolean'
      ? (error as { exitConfirmed: boolean }).exitConfirmed : undefined;
    const exitConfirmed = !dispatchAttempted ? reportedExit ?? true : Boolean(lifecycle?.confirmed && lifecycle.supervisorGone && lifecycle.bwrapGone && lifecycle.remaining.length === 0);
    if (setupAttempted && exitConfirmed) {
      try { await bridge.cleanup(options.capabilities, root, marker, new AbortController().signal); } catch { /* primary error remains authoritative */ }
    }
    if (error instanceof CursorIsolationError && error.exitConfirmed === exitConfirmed) throw error;
    throw new CursorIsolationError(error instanceof Error ? error.message : String(error), exitConfirmed);
  } finally {
    clearTimeout(deadlineTimer);
    options.signal.removeEventListener('abort', forwardAbort);
  }
}
