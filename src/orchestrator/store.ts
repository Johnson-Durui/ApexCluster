/**
 * 文件存储：每个运行一个目录，run.json 是单一事实来源；任务原始输出放在 tasks/<taskId>/ 下。
 *   data/runs/<runId>/run.json
 *   data/runs/<runId>/events.jsonl
 *   data/runs/<runId>/tasks/<taskId>/{prompt.md, stdout.jsonl|events.jsonl, stderr.log, final-message.txt, output.json, validation.json, meta.json}
 * 写入采用“临时文件 + 重命名”；Windows 上杀毒软件/索引器可能短暂占用文件，重命名失败会退避重试。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Run } from '../core/types.js';

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function writeFileAtomicSync(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, data, 'utf8');
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (i >= 10 || !['EPERM', 'EBUSY', 'EACCES'].includes(code)) {
        try {
          unlinkSync(tmp);
        } catch {
          /* ignore */
        }
        throw e;
      }
      sleepSync(30 * (i + 1));
    }
  }
}

/** 读取旧版本保存的 run.json 时补齐新字段（加入“文档”步骤之前的运行：不写文档，G3_final 改名为 G4_final） */
export function migrateRun(run: Run): Run {
  const r = run as Run & { writeDocs?: boolean; writePrd?: boolean; docWriter?: Run['docWriter']; docs?: Run['docs'] };
  if (r.writeDocs === undefined) r.writeDocs = false;
  // v0.2 及更早：没有“MVP 之后写 PRD”这一步；文档由 Sol 按它的强度撰写
  if (r.writePrd === undefined) r.writePrd = false;
  if (!r.docWriter) {
    const sol = r.models?.sol;
    r.docWriter = { role: 'sol', model: sol?.model ?? '未记录', effort: sol?.effort ?? 'high' };
  }
  if (!r.docs) r.docs = { batch: 0, bases: [], requests: [], versions: [], missing: [], requestSeq: 0 };
  if (r.docs.requestSeq === undefined) r.docs.requestSeq = 0;
  for (const g of r.gates) if ((g.id as string) === 'G3_final') g.id = 'G4_final';
  for (const j of r.jobs ?? []) if (j.devGuideVersion === undefined) j.devGuideVersion = null;
  return r;
}

export interface RunSummary {
  id: string;
  title: string;
  mode: Run['mode'];
  createdAt: string;
  updatedAt: string;
  phase: Run['phase'];
  phaseStatus: Run['phaseStatus'];
  terminal: Run['terminal'];
  /** 以下为 v0.4 列表页使用的只读摘要；旧客户端可以忽略 */
  writeDocs: boolean;
  writePrd: boolean;
  finalChoice: Run['finalChoice'];
  /** 关卡决定的动作（submit / validate / stop …），用于区分“走完”和“在某个关卡停止” */
  gates: { id: Run['gates'][number]['id']; resolved: boolean; action: string | null }[];
  /** 正在排队或运行的模型任务 */
  activeTasks: { role: Run['tasks'][number]['role']; phase: Run['tasks'][number]['phase']; status: Run['tasks'][number]['status']; startedAt: string | null }[];
}

function gateAction(resolution: unknown): string | null {
  if (!resolution || typeof resolution !== 'object' || !('action' in resolution)) return null;
  const action = (resolution as { action: unknown }).action;
  return typeof action === 'string' ? action : null;
}

export function summarizeRun(r: Run): RunSummary {
  return {
    id: r.id,
    title: r.title,
    mode: r.mode,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    phase: r.phase,
    phaseStatus: r.phaseStatus,
    terminal: r.terminal,
    writeDocs: r.writeDocs,
    writePrd: r.writePrd,
    finalChoice: r.finalChoice,
    gates: r.gates.map((g) => ({ id: g.id, resolved: Boolean(g.resolvedAt), action: gateAction(g.resolution) })),
    activeTasks: r.tasks
      .filter((t) => t.status === 'running' || t.status === 'queued')
      .map((t) => ({ role: t.role, phase: t.phase, status: t.status, startedAt: t.startedAt })),
  };
}

export class RunStore {
  private cache = new Map<string, Run>();
  constructor(readonly dataDir: string) {
    mkdirSync(this.runsDir(), { recursive: true });
  }

  runsDir(): string {
    return path.join(this.dataDir, 'runs');
  }
  runDir(runId: string): string {
    if (!/^[a-z0-9-]+$/i.test(runId)) throw new Error('非法的运行编号');
    return path.join(this.runsDir(), runId);
  }
  taskDir(runId: string, taskId: string): string {
    if (!/^[a-z0-9.:-]+$/i.test(taskId)) throw new Error('非法的任务编号');
    return path.join(this.runDir(runId), 'tasks', taskId.replace(/:/g, '_'));
  }

  save(run: Run): void {
    this.cache.set(run.id, run);
    const dir = this.runDir(run.id);
    mkdirSync(dir, { recursive: true });
    writeFileAtomicSync(path.join(dir, 'run.json'), JSON.stringify(run, null, 1));
  }

  load(runId: string): Run | null {
    const hit = this.cache.get(runId);
    if (hit) return hit;
    const file = path.join(this.runDir(runId), 'run.json');
    if (!existsSync(file)) return null;
    const run = migrateRun(JSON.parse(readFileSync(file, 'utf8')) as Run);
    this.cache.set(runId, run);
    return run;
  }

  listIds(): string[] {
    if (!existsSync(this.runsDir())) return [];
    return readdirSync(this.runsDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(path.join(this.runsDir(), d.name, 'run.json')))
      .map((d) => d.name);
  }

  list(): RunSummary[] {
    return this.listIds()
      .map((id) => this.load(id))
      .filter((r): r is Run => !!r)
      .map(summarizeRun)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  writeTaskFile(runId: string, taskId: string, name: string, content: string): string {
    const dir = this.taskDir(runId, taskId);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    writeFileAtomicSync(file, content);
    return file;
  }

  readTaskFile(runId: string, taskId: string, name: string): string | null {
    if (!/^[\w.-]+$/.test(name)) throw new Error('非法的文件名');
    const file = path.join(this.taskDir(runId, taskId), name);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  }

  listTaskFiles(runId: string, taskId: string): string[] {
    const dir = this.taskDir(runId, taskId);
    return existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name) : [];
  }

  appendEventLine(runId: string, line: string): void {
    const dir = this.runDir(runId);
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, 'events.jsonl'), `${line}\n`, 'utf8');
  }

  readEventLines(runId: string): string[] {
    const file = path.join(this.runDir(runId), 'events.jsonl');
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8').split('\n').filter(Boolean);
  }
}
