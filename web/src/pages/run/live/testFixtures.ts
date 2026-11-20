import type { Run, TaskRecord } from '../../../lib/types';

/** 仅供单元测试使用的最小任务与运行数据。 */
let clock = 0;
export function task(patch: Partial<TaskRecord> & Pick<TaskRecord, 'id' | 'role' | 'phase'>): TaskRecord {
  clock += 1;
  const at = new Date(Date.UTC(2026, 9, 12, 8, 0, clock)).toISOString();
  return {
    runId: 'r-live', scope: patch.phase, attempt: 1, rootTaskId: patch.id, status: 'succeeded', outputValidity: 'valid', validationErrors: [],
    repairAttempted: false, failure: null, createdAt: at, startedAt: at, endedAt: at, lastProgress: null, lastProgressAt: null, meta: null,
    simulated: false, jobId: null, acceptedDespiteMismatch: false, inputRef: 'v1-live',
    ...patch,
  };
}

export function liveRun(tasks: TaskRecord[], patch: Partial<Run> = {}): Run {
  return {
    id: 'r-live', mode: 'real', phase: 'propose', phaseStatus: 'running', terminal: null,
    models: {
      claude: { role: 'claude', adapter: 'claude-code', model: 'claude-opus-5-5', effort: 'max' },
      astra: { role: 'astra', adapter: 'codex', model: 'gpt-6-astra', effort: 'max' },
      sol: { role: 'sol', adapter: 'codex', model: 'gpt-6.1-sol', effort: 'max' },
    },
    docWriter: { role: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' },
    jobs: [],
    tasks,
    ...patch,
  } as Run;
}
