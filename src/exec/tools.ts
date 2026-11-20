import { z } from 'zod/v4';
import type { ToolDefinition } from '../chat/types.js';
import { ExecJobs } from './jobs.js';
import { parseExecSpec, type ExecPolicyOptions } from './policy.js';
import type { ExecBackend } from './types.js';

const string = { type: 'string' };
const commandInput = {
  type: 'object',
  additionalProperties: false,
  required: ['argv', 'cwd', 'timeoutMs'],
  properties: {
    argv: { type: 'array', minItems: 1, items: string },
    cwd: string,
    env: { type: 'object', additionalProperties: string },
    timeoutMs: { type: 'integer', minimum: 100, maximum: 3_600_000 },
    purpose: { type: 'string', enum: ['install', 'build', 'test', 'run'] },
  },
};
const jobInput = { type: 'object', additionalProperties: false, required: ['jobId'], properties: { jobId: string } };

export const execJobInput = z.object({ jobId: z.uuid() }).strict();
export const execDefinitions: ToolDefinition[] = [
  { name: 'exec', description: '在当前任务获准的工作副本执行参数数组，返回退出码、快照绑定和日志引用。', inputSchema: commandInput },
  { name: 'job_start', description: '在工作副本启动后台命令，返回本任务作业 ID。', inputSchema: commandInput },
  { name: 'job_output', description: '查询本任务后台命令的状态及已登记输出。', inputSchema: jobInput },
  { name: 'job_stop', description: '停止本任务后台命令并等待执行端确认退出。', inputSchema: jobInput },
];

/** Runtime-owned backend capability and its task-scoped job handles. */
export class ExecTools {
  readonly jobs: ExecJobs;
  private probeResult?: { expires: number; value: Awaited<ReturnType<ExecBackend['probe']>> };
  private probing?: ReturnType<ExecBackend['probe']>;

  constructor(readonly backend: ExecBackend, scratchRoot: string, private readonly policy: ExecPolicyOptions = {}) {
    this.jobs = new ExecJobs(backend, scratchRoot);
  }

  parse(value: unknown) { return parseExecSpec(value, this.policy); }

  async capabilities() {
    if (!this.probeResult || this.probeResult.expires < Date.now()) {
      this.probing ??= this.backend.probe()
        .catch(error => ({ ok: false, reason: error instanceof Error ? error.message : String(error) }))
        .then(value => {
          this.probeResult = { value, expires: Date.now() + 15_000 };
          return value;
        }).finally(() => { this.probing = undefined; });
      await this.probing;
    }
    const result = this.probeResult!.value;
    return { backend: this.backend.id, available: result.ok, reason: result.reason, unsafe: this.backend.id === 'local-unsafe' };
  }
}
