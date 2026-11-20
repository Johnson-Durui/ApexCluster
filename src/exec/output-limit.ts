import { createWriteStream, type WriteStream } from 'node:fs';
import type { Readable } from 'node:stream';

export const EXEC_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;

/** Writes stdout/stderr separately while enforcing one shared byte budget. */
export class BoundedOutputCapture {
  private readonly stdout: WriteStream;
  private readonly stderr: WriteStream;
  private readonly completions: readonly [Promise<void>, Promise<void>];
  private readonly onFailure: () => void;
  private used = 0;
  private closed = false;
  private failureTriggered = false;
  private streamError: Error | undefined;
  limited = false;

  constructor(stdoutPath: string, stderrPath: string, onFailure: () => void, readonly limitBytes = EXEC_OUTPUT_LIMIT_BYTES) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 1) throw new Error('执行输出上限无效');
    this.onFailure = onFailure;
    this.stdout = createWriteStream(stdoutPath, { flags: 'wx' });
    this.stderr = createWriteStream(stderrPath, { flags: 'wx' });
    // Register before returning: an asynchronous open/write error must never become an
    // uncaught EventEmitter error while the child is still starting.
    this.completions = [this.watch(this.stdout), this.watch(this.stderr)];
  }

  get failed(): boolean { return this.streamError !== undefined; }

  attach(stdout: Readable, stderr: Readable): void {
    stdout.on('data', chunk => this.write(this.stdout, chunk));
    stderr.on('data', chunk => this.write(this.stderr, chunk));
  }

  private watch(stream: WriteStream): Promise<void> {
    return new Promise(resolve => {
      stream.once('error', error => {
        this.fail(error);
        resolve();
      });
      stream.once('close', resolve);
    });
  }

  private fail(error: unknown): void {
    if (this.streamError) return;
    this.streamError = error instanceof Error ? error : new Error(String(error));
    this.triggerFailure();
  }

  private triggerFailure(): void {
    if (this.failureTriggered) return;
    this.failureTriggered = true;
    this.onFailure();
  }

  private write(destination: WriteStream, chunk: Buffer | string): void {
    if (this.closed || this.limited || this.failed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = this.limitBytes - this.used;
    try {
      if (bytes.length <= remaining) {
        destination.write(bytes);
        this.used += bytes.length;
        return;
      }
      if (remaining > 0) {
        destination.write(bytes.subarray(0, remaining));
        this.used += remaining;
      }
      this.limited = true;
      this.triggerFailure();
    } catch (error) { this.fail(error); }
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      if (!this.stdout.destroyed) this.stdout.end();
      if (!this.stderr.destroyed) this.stderr.end();
    }
    await Promise.all(this.completions);
    if (this.streamError) throw this.streamError;
  }
}
