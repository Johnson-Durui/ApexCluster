import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { RunStore } from '../orchestrator/store.js';
import { startWorkbench, stopWorkbench, type WorkbenchRuntime } from './main.js';

export type DesktopReply =
  | { type: 'ready'; url: string; pid: number }
  | { type: 'busy'; tasks: number; jobs: number }
  | { type: 'stopped' }
  | { type: 'error'; message: string }
  // Non-fatal: the launcher only logs it; the selection is already cancelled and the user can pick again.
  | { type: 'folder_error'; requestId: string; message: string };

export function countActiveWork(dataDir: string): { tasks: number; jobs: number } {
  const store = new RunStore(dataDir);
  let tasks = 0;
  let jobs = 0;
  for (const id of store.listIds()) {
    const run = store.load(id);
    if (!run) throw new Error(`无法读取运行 ${id}`);
    tasks += run.tasks.filter((t) => t.status === 'queued' || t.status === 'running').length;
    jobs += run.jobs.filter((j) => ['preparing', 'running', 'verifying'].includes(j.status)).length;
  }
  return { tasks, jobs };
}

export function protocolLine(reply: DesktopReply): string {
  return `DMW_DESKTOP ${JSON.stringify(reply)}`;
}

export interface DesktopHostOptions {
  runtime?: WorkbenchRuntime;
  dataDir?: string;
  port?: number;
  write?: (line: string) => void;
  exit?: (code: number) => void;
}

export class DesktopHost {
  private stopping: Promise<void> | null = null;
  private done = false;
  private readonly write: (line: string) => void;
  private readonly exit: (code: number) => void;
  private readonly runtime: WorkbenchRuntime;
  private readonly dataDir: string;
  private readonly port: number;

  constructor(options: DesktopHostOptions = {}) {
    const config = loadConfig();
    this.runtime = options.runtime ?? startWorkbench();
    this.dataDir = options.dataDir ?? config.dataDir;
    this.port = options.port ?? config.port;
    this.write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
    this.exit = options.exit ?? ((code) => { process.exitCode = code; });
    this.runtime.directoryPicker?.setTransport(requestId => this.write(`DMW_DESKTOP ${JSON.stringify({ type: 'folder_request', requestId })}`));
  }

  ready(): void {
    this.write(protocolLine({ type: 'ready', url: `http://127.0.0.1:${this.port}/`, pid: process.pid }));
  }

  error(message: string): void {
    this.write(protocolLine({ type: 'error', message }));
    this.exit(1);
  }

  get isDone(): boolean { return this.done; }
  get server(): WorkbenchRuntime['server'] { return this.runtime.server; }

  async command(input: unknown): Promise<void> {
    if (input && typeof input === 'object' && (input as { command?: unknown }).command === 'folder-selected') {
      const selection = input as { requestId?: unknown; path?: unknown };
      const picker = this.runtime.directoryPicker;
      if (!picker || typeof selection.requestId !== 'string' || (selection.path !== null && typeof selection.path !== 'string')) throw new Error('目录选择协议无效');
      // A malformed message, a relative path, or an unknown or finished request means the launcher is broken: stay fatal.
      if (selection.path !== null && !path.isAbsolute(selection.path)) throw new Error('目录选择协议无效：路径必须是绝对路径');
      const wasPending = picker.result(selection.requestId).status === 'pending';
      try {
        picker.completeFromHost(selection.requestId, selection.path);
      } catch (error) {
        // The system dialog returned an absolute folder the registry cannot grant (missing, unreadable, a link...).
        // That is a choice the user can redo, not a broken launcher: cancel this selection and keep running.
        if (!wasPending || selection.path === null) throw error;
        picker.completeFromHost(selection.requestId, null);
        const message = error instanceof Error ? error.message : String(error);
        this.write(protocolLine({ type: 'folder_error', requestId: selection.requestId, message: message.slice(0, 500) }));
      }
      return;
    }
    if (!input || typeof input !== 'object' || (input as { command?: unknown }).command !== 'stop') {
      throw new Error('仅支持 command=stop');
    }
    if (this.done) return;
    const force = (input as { force?: unknown }).force === true;
    // Keep the check and transition synchronous: no await can create a second
    // stop request between the idle check and entering shutdown.
    if (!force) {
      const active = countActiveWork(this.dataDir);
      active.tasks += this.runtime.chats?.list().reduce((count, c) => count + this.runtime.chats!.get(c.id).tasks.filter(t => ['queued', 'running', 'waiting_user', 'waiting_children'].includes(t.status)).length, 0) ?? 0;
      if (active.tasks || active.jobs) {
        this.write(protocolLine({ type: 'busy', ...active }));
        return;
      }
    }
    await this.shutdown();
  }

  async shutdown(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = stopWorkbench(this.runtime).then(() => {
      this.done = true;
      this.write(protocolLine({ type: 'stopped' }));
    });
    try { await this.stopping; } catch (error) {
      this.write(protocolLine({ type: 'error', message: error instanceof Error ? error.message : String(error) }));
      this.exit(1);
      throw error;
    }
  }
}

export async function runDesktopHost(): Promise<void> {
  let host: DesktopHost;
  try {
    host = new DesktopHost();
    await new Promise<void>((resolve, reject) => {
      if (host.server.listening) return resolve();
      const onListening = () => { cleanup(); resolve(); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const cleanup = () => { host.server.off('listening', onListening); host.server.off('error', onError); };
      host.server.once('listening', onListening);
      host.server.once('error', onError);
    });
    host.ready();
  } catch (error) {
    process.stdout.write(`${protocolLine({ type: 'error', message: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
    return;
  }
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', (line) => {
    if (!line.trim()) return;
    let value: unknown;
    try { value = JSON.parse(line); } catch { host.error('stdin 不是合法 JSON'); input.close(); return; }
    void host.command(value).catch((error) => host.error(error instanceof Error ? error.message : String(error))).finally(() => {
      if (host.isDone) { input.close(); process.stdin.destroy(); }
    });
  });
  await new Promise<void>((resolve) => input.once('close', resolve));
  process.stdin.destroy();
  await host.shutdown().catch(() => undefined);
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPath === fileURLToPath(import.meta.url)) void runDesktopHost();
