// Run endpoints of the online demo (README.md "Runs"; the protocol is the server's, src/server/app.ts).
//
// install() builds the four synthetic runs of scenario/runs and registers, with mock/router.ts:
// - GET /api/runs (summaries, newest first) and GET /api/runs/:id (the whole Run);
// - every derived GET the history and run pages call: metrics, deliverables, docs list / detail / render / download,
//   g2-defaults, diagram, task files, export, job artifact and job archive;
// - the run event stream /api/runs/:id/events: it replays the stored progress history after ?since=, and for the
//   running run a scripted progress line arrives every few seconds (scaled by mock/clock.ts);
// - every run write (create run, gate decisions, answers, overrides, merges, retries, cancel, checkpoints) is
//   answered 409 with READ_ONLY. Nothing changes state, and nothing here calls a model.
// Downloads are real files: Markdown, HTML and zip blobs that mock/navigation.ts saves through the browser.
import type { DocKind, ProgressEntry } from '../../src/lib/types';
import { buildRunBundles, type RunBundle } from '../scenario/runs';
import type { DemoFile } from '../scenario/runs/common';
import { decisionRecord, docDetail, docFileNames, docsOverview, docTitle, findDoc, g2Defaults, proposalMermaid, runMetrics, summarizeRun, taskFiles } from '../scenario/runs/derive';
import { standaloneHtml, zipStored } from '../scenario/runs/render';
import { after } from './clock';
import { fail, json, READ_ONLY, route, stream, type StreamContext } from './router';

interface StoredEvent { seq: number; runId: string; at: string; type: 'task.progress'; payload: { taskId: string; role: string; progress: ProgressEntry } }

interface RunState {
  bundle: RunBundle;
  /** Event log; seq starts at 1 and only grows. The first `historyCount` entries are the recorded history. */
  events: StoredEvent[];
  historyCount: number;
  /** Open event streams of this run. */
  listeners: Set<StreamContext>;
}

/**
 * How many live events the log keeps after the recorded history. Older live events are dropped, so a tab left open
 * for hours does not replay thousands of lines; seq numbers stay strictly increasing, which is all the client needs.
 */
const MAX_LIVE_EVENTS = 400;

const encoder = new TextEncoder();
const runs = new Map<string, RunState>();

/** RFC 5987 encoding for Content-Disposition filename* (encodeURIComponent leaves '()* alone). */
const rfc5987 = (name: string) => encodeURIComponent(name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

function attachment(asciiName: string, utf8Name = asciiName): string {
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${rfc5987(utf8Name)}`;
}

function file(body: BodyInit, type: string, disposition?: string): Response {
  const headers: Record<string, string> = { 'Content-Type': type, 'Cache-Control': 'no-store' };
  if (disposition) headers['Content-Disposition'] = disposition;
  return new Response(body, { status: 200, headers });
}

function stateOf(id: string): RunState | Response {
  return runs.get(id) ?? fail(404, `运行 ${id} 不存在`);
}

// ---------------------------------------------------------------- workspace files

const zipCache = new Map<string, Uint8Array<ArrayBuffer>>();

function fileBytes(runId: string, jobId: string, files: DemoFile[], item: DemoFile): Uint8Array<ArrayBuffer> {
  if (!item.zipOf) return encoder.encode(item.content ?? '');
  const key = `${runId}/${jobId}/${item.path}`;
  let zip = zipCache.get(key);
  if (!zip) {
    const root = (item.path.split('/').at(-1) ?? 'archive').replace(/\.zip$/i, '');
    zip = zipStored(item.zipOf.flatMap(path => {
      const source = files.find(entry => entry.path === path && !entry.zipOf);
      return source ? [{ name: `${root}/${path}`, data: encoder.encode(source.content ?? '') }] : [];
    }));
    zipCache.set(key, zip);
  }
  return zip;
}

function jobFiles(state: RunState, jobId: string): DemoFile[] | null {
  const job = state.bundle.run.jobs.find(item => item.id === jobId);
  return job ? state.bundle.files[job.id] ?? [] : null;
}

// ---------------------------------------------------------------- events

function buildEventLog(bundle: RunBundle): StoredEvent[] {
  const entries = Object.entries(bundle.trails).flatMap(([taskId, list]) => {
    const role = bundle.run.tasks.find(task => task.id === taskId)?.role ?? 'claude';
    return list.map(progress => ({ taskId, role, progress }));
  });
  entries.sort((a, b) => a.progress.at.localeCompare(b.progress.at));
  return entries.map((entry, index) => ({ seq: index + 1, runId: bundle.run.id, at: entry.progress.at, type: 'task.progress', payload: entry }));
}

function publish(state: RunState, event: StoredEvent): void {
  state.events.push(event);
  const extra = state.events.length - state.historyCount - MAX_LIVE_EVENTS;
  if (extra > 0) state.events.splice(state.historyCount, extra);
  for (const listener of state.listeners) listener.emit(event.type, event, String(event.seq));
}

const TOKENS = /估计已生成\s*(\d+)\s*tokens/;

/**
 * The scripted live feed of a running run. Like the server it keeps running whether or not a page is watching: a page
 * that opens the run later receives the lines it missed through the replay. Each line also becomes the task's
 * lastProgress, as on the server.
 */
function startLiveFeed(state: RunState): void {
  const live = state.bundle.live;
  if (!live || !live.lines.length) return;
  const tokens = new Map<string, number>();
  for (const [taskId, list] of Object.entries(state.bundle.trails)) {
    for (const entry of list) {
      const found = TOKENS.exec(entry.text);
      if (found) tokens.set(taskId, Number(found[1]));
    }
  }
  let cursor = 0;
  const [min, max] = live.intervalMs;
  const tick = () => {
    const line = live.lines[cursor % live.lines.length]!;
    // From the second pass through the script on, tool and message lines say that they are a re-check.
    const repeat = cursor >= live.lines.length && (line.kind === 'tool' || line.kind === 'message');
    cursor += 1;
    const task = state.bundle.run.tasks.find(item => item.id === line.taskId);
    if (task && task.status === 'running') {
      let text = repeat ? `再次核对：${line.text}` : line.text;
      if (text.includes('{tokens}')) {
        const next = (tokens.get(line.taskId) ?? 2400) + 500 + Math.round(Math.random() * 900);
        tokens.set(line.taskId, next);
        text = text.replace('{tokens}', String(next));
      }
      const at = new Date().toISOString();
      const progress: ProgressEntry = { at, kind: line.kind, text };
      task.lastProgress = text;
      task.lastProgressAt = at;
      const seq = (state.events.at(-1)?.seq ?? 0) + 1;
      publish(state, { seq, runId: state.bundle.run.id, at, type: 'task.progress', payload: { taskId: task.id, role: task.role, progress } });
    }
    after(min + Math.random() * (max - min), tick);
  };
  after(min, tick);
}

function openStream(ctx: StreamContext): (() => void) | void {
  const state = runs.get(ctx.params.id ?? '');
  // An unknown run ends the stream at once, as the server's 404 does: the page then shows its disconnected state
  // instead of 实时同步 next to "运行不存在".
  if (!state) { ctx.close(); return; }
  const since = Number(ctx.query.get('since') ?? '0');
  const from = Number.isFinite(since) ? since : 0;
  for (const event of state.events) if (event.seq > from) ctx.emit(event.type, event, String(event.seq));
  state.listeners.add(ctx);
  return () => { state.listeners.delete(ctx); };
}

// ---------------------------------------------------------------- documents

function docResponse(state: RunState, kind: string, version: string, format: 'render' | 'md' | 'html'): Response {
  const doc = findDoc(state.bundle.run, kind, version);
  if (!doc) return fail(404, `文档 ${kind} v${version} 不存在`);
  const run = state.bundle.run;
  const markdown = state.bundle.docs[`${doc.kind}/${doc.version}` as `${DocKind}/${number}`] ?? `# ${docTitle(doc.kind)} v${doc.version}\n\n在线演示没有为这个版本准备正文。`;
  const title = `${docTitle(doc.kind)} v${doc.version} · ${run.title}`;
  const status = doc.status === 'approved' ? `已确认（${doc.approval?.conclusion ?? '通过'}）` : doc.status === 'draft' ? '草稿' : '历史版本';
  const meta = `${doc.docRef} · ${status} · 运行 ${run.id} · 在线演示的预设文档`;
  if (format === 'md') {
    const names = docFileNames(run, doc, 'md');
    return file(`<!-- ${meta} -->\n\n${markdown}`, 'text/markdown; charset=utf-8', attachment(names.ascii, names.utf8));
  }
  const html = standaloneHtml(title, meta, markdown);
  if (format === 'render') return file(html, 'text/html; charset=utf-8');
  const names = docFileNames(run, doc, 'html');
  return file(html, 'text/html; charset=utf-8', attachment(names.ascii, names.utf8));
}

// ---------------------------------------------------------------- install

let installed = false;

/** Registers the run routes and streams with mock/router.ts. Called once by main.ts before the product loads. */
export function install(): void {
  if (installed) return;
  installed = true;
  for (const bundle of buildRunBundles(Date.now())) {
    const events = buildEventLog(bundle);
    const state: RunState = { bundle, events, historyCount: events.length, listeners: new Set() };
    runs.set(bundle.run.id, state);
    startLiveFeed(state);
  }

  route('GET', '/api/runs', () => json([...runs.values()].map(state => summarizeRun(state.bundle.run)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))));
  route('GET', '/api/runs/:id', req => {
    const state = stateOf(req.params.id!);
    return state instanceof Response ? state : json(state.bundle.run);
  });
  route('GET', '/api/runs/:id/metrics', req => {
    const state = stateOf(req.params.id!);
    return state instanceof Response ? state : json(runMetrics(state.bundle.run, new Date().toISOString()));
  });
  route('GET', '/api/runs/:id/questions', req => {
    const state = stateOf(req.params.id!);
    return state instanceof Response ? state : json(state.bundle.run.questions);
  });
  route('GET', '/api/runs/:id/deliverables', req => {
    const state = stateOf(req.params.id!);
    if (state instanceof Response) return state;
    const run = state.bundle.run;
    return json({
      generatedAt: new Date().toISOString(),
      jobs: run.jobs.map(job => {
        const files = jobFiles(state, job.id) ?? [];
        return { jobId: job.id, workspaceDir: job.workspaceDir, available: true, incomplete: false, warnings: [],
          files: files.map(item => ({ path: item.path, size: fileBytes(run.id, job.id, files, item).length })).sort((a, b) => a.path.localeCompare(b.path)) };
      }),
    });
  });
  route('GET', '/api/runs/:id/jobs/:jobId/artifact', req => {
    const state = stateOf(req.params.id!);
    if (state instanceof Response) return state;
    const files = jobFiles(state, req.params.jobId!);
    if (!files) return fail(404, '作业不存在。');
    const path = req.query.get('path') ?? '';
    const item = files.find(entry => entry.path === path);
    if (!item) return fail(404, `文件不存在：${path}`);
    const name = path.split('/').at(-1) ?? 'artifact';
    return file(fileBytes(state.bundle.run.id, req.params.jobId!, files, item), 'application/octet-stream', attachment('artifact', name));
  });
  route('GET', '/api/runs/:id/jobs/:jobId/archive', req => {
    const state = stateOf(req.params.id!);
    if (state instanceof Response) return state;
    const files = jobFiles(state, req.params.jobId!);
    if (!files) return fail(404, '作业不存在。');
    const run = state.bundle.run;
    const root = `delivery-${run.id}-${req.params.jobId}`;
    const entries = files.filter(item => !item.zipOf).map(item => ({ name: `${root}/workspace/${item.path}`, data: encoder.encode(item.content ?? '') }));
    for (const doc of run.docs.versions) {
      const body = state.bundle.docs[`${doc.kind}/${doc.version}` as `${DocKind}/${number}`];
      if (body) entries.push({ name: `${root}/docs/${docFileNames(run, doc, 'md').utf8}`, data: encoder.encode(body) });
    }
    entries.push({ name: `${root}/decision-${run.id}.md`, data: encoder.encode(decisionRecord(run)) });
    return file(zipStored(entries), 'application/zip', attachment(`${root}.zip`));
  });
  route('GET', '/api/runs/:id/docs', req => {
    const state = stateOf(req.params.id!);
    return state instanceof Response ? state : json(docsOverview(state.bundle));
  });
  route('GET', '/api/runs/:id/docs/:kind/:version', req => {
    const state = stateOf(req.params.id!);
    if (state instanceof Response) return state;
    const doc = findDoc(state.bundle.run, req.params.kind!, req.params.version!);
    return doc ? json(docDetail(state.bundle, doc)) : fail(404, `文档 ${req.params.kind} v${req.params.version} 不存在`);
  });
  route('GET', '/api/runs/:id/docs/:kind/:version/render', req => {
    const state = stateOf(req.params.id!);
    return state instanceof Response ? state : docResponse(state, req.params.kind!, req.params.version!, 'render');
  });
  route('GET', '/api/runs/:id/docs/:kind/:version/download', req => {
    const state = stateOf(req.params.id!);
    if (state instanceof Response) return state;
    const format = req.query.get('format') ?? 'html';
    if (format !== 'md' && format !== 'html') return fail(400, 'format 只能是 md 或 html');
    return docResponse(state, req.params.kind!, req.params.version!, format);
  });
  route('GET', '/api/runs/:id/g2-defaults', req => {
    const state = stateOf(req.params.id!);
    return state instanceof Response ? state : json(g2Defaults(state.bundle.run));
  });
  route('GET', '/api/runs/:id/diagram/:proposalId', req => {
    const state = stateOf(req.params.id!);
    if (state instanceof Response) return state;
    const proposal = state.bundle.run.proposals.find(item => item.id === req.params.proposalId);
    return proposal ? json({ mermaid: proposalMermaid(proposal) }) : fail(404, '方案不存在');
  });
  route('GET', '/api/runs/:id/tasks/:taskId/files', req => {
    const state = stateOf(req.params.id!);
    if (state instanceof Response) return state;
    const task = state.bundle.run.tasks.find(item => item.id === req.params.taskId);
    return task ? json(taskFiles(state.bundle, task)) : fail(404, '任务不存在');
  });
  route('GET', '/api/runs/:id/export', req => {
    const state = stateOf(req.params.id!);
    if (state instanceof Response) return state;
    const name = `decision-${state.bundle.run.id}.md`;
    return file(decisionRecord(state.bundle.run), 'text/markdown; charset=utf-8', attachment(name));
  });

  // Every write is refused: the demo serves preset records only.
  route('POST', '/api/runs', () => fail(409, READ_ONLY));
  route('POST', '/api/runs/:id/*', () => fail(409, READ_ONLY));
  // POST /api/reference-documents/import and /api/reference-archives/import (NewPage) are registered by mock/system.ts.

  stream('/api/runs/:id/events', openStream);
}
