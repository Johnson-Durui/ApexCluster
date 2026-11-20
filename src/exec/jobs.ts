import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { ExecBackend, ExecResult, ExecSpec } from './types.js';

type JobStatus = 'running' | 'finished' | 'failed';
interface Job {
  id: string;
  owner: string;
  directory: string;
  status: JobStatus;
  controller: AbortController;
  done: Promise<void>;
  result?: ExecResult;
  failure?: Error;
}

/** Track host execution jobs independently from provider windows, scoped to a single task. */
export class ExecJobs {
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly backend: ExecBackend, private readonly scratchRoot: string) {}

  start(owner: string, spec: ExecSpec, copyDir: string, signal: AbortSignal, id: string = randomUUID()): string {
    signal.throwIfAborted();
    mkdirSync(this.scratchRoot, { recursive: true });
    if (this.jobs.has(id)) throw new Error('后台作业 ID 已存在');
    const directory = mkdtempSync(path.join(this.scratchRoot, 'exec-'));
    const controller = new AbortController();
    const cancel = () => controller.abort(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    const job: Job = { id, owner, directory, status: 'running', controller, done: Promise.resolve() };
    this.jobs.set(id, job);
    job.done = Promise.resolve().then(() => this.backend.run(spec, { copyDir, outputDir: directory, signal: controller.signal })).then(result => {
      job.result = result;
      job.status = 'finished';
    }, error => {
      job.failure = error instanceof Error ? error : new Error(String(error));
      job.status = 'failed';
    }).finally(() => signal.removeEventListener('abort', cancel));
    return id;
  }

  status(owner: string, id: string) {
    const job = this.owned(owner, id);
    if (job.failure) throw job.failure;
    return { id, status: job.status, directory: job.directory, result: job.result };
  }

  async wait(owner: string, id: string) {
    await this.owned(owner, id).done;
    return this.status(owner, id);
  }

  async stop(owner: string, id: string) {
    const job = this.owned(owner, id);
    if (job.status === 'running') job.controller.abort();
    return this.wait(owner, id);
  }

  running(owner: string): string[] {
    return [...this.jobs.values()].filter(job => job.owner === owner && job.status === 'running').map(job => job.id);
  }

  private owned(owner: string, id: string) {
    const job = this.jobs.get(id);
    if (!job || job.owner !== owner) throw new Error('后台作业不存在或不属于当前任务');
    return job;
  }
}
