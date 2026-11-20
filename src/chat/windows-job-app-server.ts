import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ResolvedCommand } from '../adapters/process.js';
import { buildWindowsJobRequest, windowsJobReceiptPath, type WindowsJobReceipt } from './windows-job-process.js';

export interface WindowsJobAppServerOptions { cwd: string; env: NodeJS.ProcessEnv; receiptDirectory: string; supervisorPath: string }
export interface WindowsJobAppServerEvidence {
  confirmed: boolean; targetPid: number | null; activeBeforeStop: number | null; activeProcesses: number | null;
  rootExited: boolean; cancelReceived: boolean; targetExitCode: number | null;
}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function connectControl(name: string): Promise<Socket> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try { return await new Promise<Socket>((resolve, reject) => { const socket = createConnection({ path: `\\\\.\\pipe\\${name}`, allowHalfOpen: true }, () => resolve(socket)); socket.once('error', reject); }); }
    catch (error) { if (Date.now() >= deadline) throw error; await delay(25); }
  }
}

/** Interactive stdio transport using the same Job supervisor protocol as one-shot chat processes. */
export class WindowsJobAppServerProcess extends EventEmitter {
  readonly stdin: ChildProcessWithoutNullStreams['stdin'];
  readonly stdout: ChildProcessWithoutNullStreams['stdout'];
  readonly stderr: ChildProcessWithoutNullStreams['stderr'];
  readonly helperPid: number | null;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly receiptFile: string;
  private readonly pipeName: string;
  private readonly readyPromise: Promise<void>;
  private readonly closePromise: Promise<void>;
  private control: Socket | null = null;
  private targetPid: number | null = null;
  private stopRequested = false;
  private finalReceipt: WindowsJobReceipt | null = null;
  private helperExitCode: number | null = null;
  private helperSignal: NodeJS.Signals | null = null;
  private helperClosed = false;
  private spawnError: Error | null = null;
  private stopped: Promise<boolean> | null = null;

  constructor(cmd: ResolvedCommand, args: string[], options: WindowsJobAppServerOptions) {
    super();
    if (cmd.via === 'cmd-fallback') throw new Error('Windows Job app-server does not execute cmd fallback shims');
    for (const [label, file] of [['supervisor', options.supervisorPath], ['receipt directory', options.receiptDirectory]] as const) {
      if (!path.isAbsolute(file) || !existsSync(file)) throw new Error(`Windows Job app-server ${label} unavailable`);
      const info = lstatSync(file);
      if (info.isSymbolicLink() || (label === 'supervisor' ? !info.isFile() : !info.isDirectory())) throw new Error(`Windows Job app-server ${label} unsafe`);
    }
    const id = randomUUID(); this.pipeName = `dmw-chat-app-server-${id}`; this.receiptFile = windowsJobReceiptPath(options.receiptDirectory, id);
    const encoded = Buffer.from(JSON.stringify(buildWindowsJobRequest(cmd, ['app-server', ...args], options.cwd)), 'utf8').toString('base64');
    this.child = spawn(options.supervisorPath, [encoded, this.pipeName, this.receiptFile], { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    this.stdin = this.child.stdin; this.stdout = this.child.stdout; this.stderr = this.child.stderr; this.helperPid = this.child.pid ?? null;
    this.child.once('error', error => { this.spawnError = error; this.emit('error', error); });
    this.closePromise = new Promise(resolve => this.child.once('close', (code, signal) => {
      this.helperClosed = true; this.helperExitCode = code; this.helperSignal = signal;
      try { this.finalReceipt = JSON.parse(readFileSync(this.receiptFile, 'utf8')) as WindowsJobReceipt; } catch { /* fail closed */ }
      this.emit('close', this.finalReceipt?.exitCode ?? code, signal); resolve();
    }));
    this.readyPromise = this.establish().catch(error => { this.spawnError ??= error instanceof Error ? error : new Error(String(error)); throw this.spawnError; });
    void this.readyPromise.catch(() => undefined);
  }

  get pid(): number | null { return this.targetPid ?? this.helperPid; }
  get exitCode(): number | null { return this.finalReceipt?.exitCode ?? this.helperExitCode; }

  private async establish(): Promise<void> {
    const deadline = Date.now() + 5_000; let receipt: WindowsJobReceipt | null = null;
    while (Date.now() < deadline) {
      try { receipt = JSON.parse(readFileSync(this.receiptFile, 'utf8')) as WindowsJobReceipt; } catch { /* READY not persisted */ }
      if (receipt?.ready === true && Number.isInteger(receipt.rootPid) && (receipt.rootPid ?? 0) > 0) break;
      if (this.helperClosed || this.spawnError) throw this.spawnError ?? new Error('Windows Job app-server helper closed before READY');
      await delay(10);
    }
    if (!receipt?.ready || !receipt.rootPid) throw new Error('Windows Job app-server READY timeout');
    this.targetPid = receipt.rootPid; this.control = await connectControl(this.pipeName);
    // The helper closes the duplex pipe as part of a confirmed Job teardown;
    // consume that transport error and trust only its typed FINAL receipt.
    this.control.on('error', () => undefined);
    const command = this.stopRequested ? 1 : 2; this.control.write(Buffer.from([command])); if (command === 1) this.control.end();
  }

  private confirmed(): boolean {
    const r = this.finalReceipt;
    return !!r && r.version === 1 && Number.isInteger(r.rootPid) && (r.rootPid ?? 0) > 0 && r.rootPid === this.targetPid
      && r.rootExited === true && r.activeProcesses === 0 && r.jobConfirmed === true && r.helperError === null
      && this.helperExitCode === 0 && this.helperSignal === null && this.spawnError === null;
  }

  evidence(): WindowsJobAppServerEvidence {
    const r = this.finalReceipt;
    return { confirmed: this.confirmed(), targetPid: r?.rootPid ?? this.targetPid, activeBeforeStop: r?.activeBeforeStop ?? null,
      activeProcesses: r?.activeProcesses ?? null, rootExited: r?.rootExited === true, cancelReceived: r?.cancelReceived === true, targetExitCode: r?.exitCode ?? null };
  }

  stop(): Promise<boolean> {
    if (this.stopped) return this.stopped;
    this.stopRequested = true;
    this.stopped = (async () => {
      try { await this.readyPromise; } catch { /* helper timeout path owns cleanup */ }
      if (this.control && !this.control.destroyed) this.control.end(Buffer.from([1]));
      let timeout: NodeJS.Timeout | undefined;
      const closed = await Promise.race([this.closePromise.then(() => true), new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), 15_000); timeout.unref(); })]);
      if (timeout) clearTimeout(timeout);
      const confirmed = closed && this.confirmed();
      if (confirmed) { try { if (existsSync(this.receiptFile)) unlinkSync(this.receiptFile); } catch { /* cleanup only */ } }
      this.control?.destroy(); return confirmed;
    })();
    return this.stopped;
  }
}
