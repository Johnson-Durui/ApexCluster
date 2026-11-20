/**
 * 本机 HTTP 服务（Node 内置 http，无框架）：REST + SSE + 静态页面。
 * 接口清单见 docs/SPEC.md §13。所有输入都用 zod 严格校验；浏览器输入从不进入命令行。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod/v4';
import type { WorkbenchConfig } from '../config.js';
import { proposalToMermaid } from '../core/diagram.js';
import { DOC_CSP, renderMarkdown, renderStandaloneHtml } from '../core/doc-model.js';
import { buildDocModel, currentDocs, docFileNames, docSummaries, encodeRfc5987, findDocVersion, prdChecklist, prdTraceability, recordPendingCount } from '../core/docs.js';
import type { DocVersion, Run } from '../core/types.js';
import { groupQuestions } from '../core/questions.js';
import { renderDecisionRecord } from '../core/report.js';
import { AnswerInputZ, CreateRunInputZ, GateInputZ, OverrideInputZ, ReferenceArchiveNameZ, ReferenceArchivesZ, ReferenceDocumentsZ, ReferenceImportInputZ } from '../core/schemas.js';
import { importReferenceDocuments, REFERENCE_LIMITS } from '../core/reference-documents.js';
import { HttpError } from '../orchestrator/errors.js';
import type { EventBus, RunEvent } from '../orchestrator/events.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import { saveReferenceArchive, saveReferenceArchiveStream } from '../orchestrator/reference-store.js';
import { liveProbe, probeEnvironment } from '../probe.js';
import { cursorAvailability } from '../core/cursor-capabilities.js';
import { cursorWriteAvailability } from '../adapters/cursor-writer.js';
import { checkRequest, HTML_CSP, SECURITY_HEADERS } from './security.js';
import { deliveryArchive, listDeliverables, openArtifact } from './deliverables.js';

type Params = Record<string, string>;
type Handler = (req: IncomingMessage, res: ServerResponse, params: Params, body: unknown) => Promise<void> | void;

interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  handler: Handler;
}

export interface AppDeps {
  config: WorkbenchConfig;
  orchestrator: Orchestrator;
  bus: EventBus;
  token: string;
  /** 静态页面目录（web/dist）；不存在时显示占位页 */
  staticDir: string;
  /**
   * 是否允许通过 HTTP 新建模拟运行。产品服务（npm start）不开启：模拟模式已从工作台移除。
   * 只有自动化测试和开发验收服务显式开启，用来在不调用模型的情况下走完流程。
   */
  allowMockRuns?: boolean;
  /** 新聊天运行层；旧 Run 协议保留独立。 */
  chatHttp?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
}

const MAX_BODY = 1_000_000;
const ARCHIVE_IMPORT_PATH = '/api/reference-archives/import';

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(text);
}

async function readBody(req: IncomingMessage, limit = MAX_BODY): Promise<unknown> {
  if (['GET', 'HEAD'].includes(req.method ?? 'GET')) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, '请求体过大');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || '(根)'}：${i.message}`).join('；'));
  return r.data;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

const PLACEHOLDER = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>双模型架构工作台</title>
<body style="font-family:system-ui;max-width:720px;margin:40px auto;line-height:1.6">
<h1>双模型架构工作台（API 已运行）</h1>
<p>网页界面尚未构建（见 docs/TASKS.md 的 T2）。构建后运行 <code>npm run build:web</code>，本服务会自动提供 web/dist。</p>
<p>可用接口：<code>GET /api/health</code>、<code>GET /api/config</code>、<code>GET /api/runs</code> …（完整清单见 docs/SPEC.md §13）。</p>
<p>界面参考：<code>docs/wireframe.html</code>。</p></body></html>`;

export function createApp(deps: AppDeps) {
  const { config, orchestrator: orch, bus } = deps;
  const routes: Route[] = [];
  const on = (method: string, pattern: string, handler: Handler) => {
    const keys: string[] = [];
    const re = new RegExp(
      `^${pattern.replace(/:(\w+)/g, (_, k: string) => {
        keys.push(k);
        return '([A-Za-z0-9._-]+)';
      })}$`,
    );
    routes.push({ method, re, keys, handler });
  };

  // ------------------------------------------------------------ 基础
  on('GET', '/api/health', (_q, res) => send(res, 200, { ok: true, mode: 'local', time: new Date().toISOString() }));
  on('GET', '/api/session', (_q, res) => send(res, 200, { token: deps.token }));
  on('GET', '/api/config', (_q, res) =>
    send(res, 200, {
      models: config.models,
      docWriter: { ...config.docWriter, model: config.models[config.docWriter.role].model },
      preflight: config.preflight,
      build: config.build,
      evaluator: config.evaluator,
      finalReview: config.finalReview,
      contextBudget: config.contextBudget,
      chores: config.chores,
      cursorCapabilities: cursorAvailability(config.models.grok.model, config.adapters.cursor.capabilities, config.adapters.cursor.command),
      cursorWriteCapabilities: cursorWriteAvailability(config.adapters.cursorWriter.capabilities),
      criteria: config.criteria,
      decision: config.decision,
      limits: config.limits,
      targetPlatform: config.targetPlatform,
      referenceLimits: { ...REFERENCE_LIMITS, maxZipBytes: null },
    }),
  );
  on('POST', ARCHIVE_IMPORT_PATH, async (req, res) => {
    const encodedName = req.headers['x-reference-name'];
    let name: string;
    try {
      name = parse(ReferenceArchiveNameZ, typeof encodedName === 'string' ? decodeURIComponent(encodedName) : undefined);
    } catch {
      throw new HttpError(400, '请提供有效的 ZIP 文件名（x-reference-name）');
    }
    try {
      const archive = await saveReferenceArchiveStream(config.dataDir, name, req);
      send(res, 200, { documents: [], archives: parse(ReferenceArchivesZ, [archive]), skipped: [] });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOSPC') throw new HttpError(507, '保存资料的磁盘空间不足');
      throw new HttpError(400, error instanceof Error ? error.message : 'ZIP 保存失败');
    }
  });
  on('POST', '/api/reference-documents/import', (_q, res, _p, body) => {
    const input = parse(ReferenceImportInputZ, body);
    try {
      if (/\.zip$/i.test(input.name)) {
        const archive = saveReferenceArchive(config.dataDir, input.name, Buffer.from(input.contentBase64, 'base64'));
        send(res, 200, { documents: [], archives: parse(ReferenceArchivesZ, [archive]), skipped: [] });
        return;
      }
      const result = importReferenceDocuments(input.name, Buffer.from(input.contentBase64, 'base64'));
      send(res, 200, { documents: parse(ReferenceDocumentsZ, result.documents), archives: [], skipped: result.skipped });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, error instanceof Error ? error.message : '参考文档读取失败');
    }
  });
  on('POST', '/api/probe', async (_q, res, _p, body) => {
    const b = parse(z.object({ live: z.array(z.object({ role: z.enum(['claude', 'astra', 'sol', 'grok']), effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional() })).max(6).default([]), confirmCost: z.boolean().default(false) }), body);
    if (b.live.length && !b.confirmCost) throw new HttpError(400, '真实探测会消耗订阅额度，请在界面上确认（confirmCost=true）');
    orch.assertModelDispatchSafe();
    const env = await probeEnvironment(config);
    orch.assertModelDispatchSafe();
    const live = b.live.length ? await liveProbe(config, b.live) : [];
    send(res, 200, { env, live });
  });

  // ------------------------------------------------------------ 运行
  on('GET', '/api/runs', (_q, res) => send(res, 200, orch.listRuns()));
  const metricsAsOf = (req: IncomingMessage) => parse(z.object({ asOf: z.string().datetime({ offset: true }).optional() }).strict(), Object.fromEntries(new URL(req.url ?? '/', 'http://127.0.0.1').searchParams)).asOf;
  on('GET', '/api/metrics', (req, res) => send(res, 200, orch.allMetrics(metricsAsOf(req))));
  on('GET', '/api/runs/:id/metrics', (req, res, p) => send(res, 200, orch.metrics(p.id!, metricsAsOf(req))));
  on('POST', '/api/runs', (_q, res, _p, body) => {
    const input = parse(CreateRunInputZ, body);
    if (input.mode === 'mock' && !deps.allowMockRuns) throw new HttpError(400, '工作台已移除模拟模式：新建运行只能使用真实模式。');
    send(res, 201, orch.createRun(input));
  });
  on('GET', '/api/runs/:id', (_q, res, p) => send(res, 200, orch.getRun(p.id!)));
  on('GET', '/api/runs/:id/questions', (_q, res, p) => send(res, 200, groupQuestions(orch.getRun(p.id!).questions)));
  on('POST', '/api/runs/:id/questions/:qid/answer', (_q, res, p, body) => send(res, 200, orch.answerQuestion(p.id!, p.qid!, parse(AnswerInputZ, body))));
  on('POST', '/api/runs/:id/gates', (_q, res, p, body) => send(res, 200, orch.resolveGate(p.id!, parse(GateInputZ, body))));
  on('POST', '/api/runs/:id/blocked', (_q, res, p, body) => {
    const b = parse(z.object({ action: z.enum(['retry_failed', 'continue_single', 'architect_override']), reason: z.string().trim().min(1).max(5000).optional() }).strict(), body);
    send(res, 200, orch.resolveBlocked(p.id!, b.action, b.reason));
  });
  on('POST', '/api/runs/:id/cancel', (_q, res, p) => send(res, 200, orch.cancelRun(p.id!)));
  on('POST', '/api/runs/:id/tasks/:taskId/retry', (_q, res, p) => send(res, 200, orch.retryTask(p.id!, p.taskId!)));
  on('POST', '/api/runs/:id/tasks/:taskId/cancel', (_q, res, p) => send(res, 200, orch.cancelTask(p.id!, p.taskId!)));
  on('POST', '/api/runs/:id/tasks/:taskId/accept-mismatch', (_q, res, p) => send(res, 200, orch.acceptMismatch(p.id!, p.taskId!)));
  on('GET', '/api/runs/:id/tasks/:taskId/files', (_q, res, p) => send(res, 200, orch.taskFiles(p.id!, p.taskId!)));
  on('POST', '/api/runs/:id/overrides', (_q, res, p, body) => send(res, 200, orch.setOverride(p.id!, parse(OverrideInputZ, body))));
  on('POST', '/api/runs/:id/merge', (_q, res, p, body) => {
    const b = parse(z.object({ candidateIds: z.array(z.string().max(32)).min(2).max(6) }), body);
    send(res, 200, orch.mergeCandidates(p.id!, b.candidateIds));
  });
  on('POST', '/api/runs/:id/jobs/:jobId/manual', (_q, res, p, body) => {
    const b = parse(z.object({ criterionId: z.string().max(32), pass: z.boolean(), note: z.string().max(2000).nullable().default(null) }), body);
    send(res, 200, orch.setManualResult(p.id!, p.jobId!, b.criterionId, b.pass, b.note));
  });
  on('POST', '/api/runs/:id/jobs/:jobId/preflight', (_q, res, p, body) => {
    parse(z.object({}).strict(), body);
    send(res, 200, orch.rerunPreflight(p.id!, p.jobId!));
  });
  on('POST', '/api/runs/:id/jobs/:jobId/checkpoint', async (_q, res, p, body) => {
    const input = parse(z.object({ reason: z.string().trim().min(1).max(5000) }).strict(), body);
    send(res, 200, await orch.checkpointJob(p.id!, p.jobId!, input.reason));
  });
  on('GET', '/api/runs/:id/g2-defaults', (_q, res, p) => send(res, 200, orch.frameworkGateDefaults(p.id!)));
  on('GET', '/api/runs/:id/diagram/:proposalId', (_q, res, p) => {
    const run = orch.getRun(p.id!);
    const prop = run.proposals.find((x) => x.id === p.proposalId);
    if (!prop) throw new HttpError(404, '方案不存在');
    send(res, 200, { mermaid: proposalToMermaid(prop) });
  });
  on('GET', '/api/runs/:id/export', (_q, res, p) => {
    const md = renderDecisionRecord(orch.getRun(p.id!));
    send(res, 200, md, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="decision-${p.id}.md"` });
  });
  on('GET', '/api/runs/:id/deliverables', async (_q, res, p) => {
    const run = orch.getRun(p.id!);
    send(res, 200, { jobs: await Promise.all(run.jobs.map(job => listDeliverables(job))), generatedAt: new Date().toISOString() });
  });
  const deliveryJob = (runId: string, jobId: string) => {
    const run = orch.getRun(runId);
    const job = run.jobs.find(item => item.id === jobId && item.runId === runId);
    if (!job) throw new HttpError(404, '作业不存在。');
    return { run, job };
  };
  on('GET', '/api/runs/:id/jobs/:jobId/artifact', async (req, res, p) => {
    const { job } = deliveryJob(p.id!, p.jobId!);
    const relative = new URL(req.url ?? '/', 'http://x').searchParams.get('path') ?? '';
    const { file, size } = await openArtifact(job, relative);
    try {
      res.writeHead(200, {
        ...SECURITY_HEADERS, 'Cache-Control': 'no-store', 'Content-Type': 'application/octet-stream',
        'Content-Length': String(size),
        'Content-Disposition': `attachment; filename="artifact"; filename*=UTF-8''${encodeRfc5987(path.basename(relative))}`,
      });
      await pipeline(file.createReadStream({ autoClose: false }), res);
    } finally { await file.close(); }
  });
  on('GET', '/api/runs/:id/jobs/:jobId/archive', async (_q, res, p) => {
    const { run, job } = deliveryJob(p.id!, p.jobId!);
    const archive = await deliveryArchive(run, job, config.targetPlatform);
    res.writeHead(200, {
      ...SECURITY_HEADERS, 'Cache-Control': 'no-store', 'Content-Type': 'application/zip',
      'Content-Length': String(archive.size),
      'Content-Disposition': `attachment; filename="delivery-${run.id}-${job.id}.zip"`,
    });
    await pipeline(Readable.from(archive.stream), res);
  });

  // ------------------------------------------------------------ PRD 与架构说明手册
  const docOr404 = (run: Run, kind: string, version: string): DocVersion => {
    const v = /^\d{1,4}$/.test(version) ? findDocVersion(run, kind, Number(version)) : undefined;
    if (!v) throw new HttpError(404, `文档 ${kind} v${version} 不存在`);
    return v;
  };
  on('GET', '/api/runs/:id/docs', (_q, res, p) => {
    const run = orch.getRun(p.id!);
    const cur = currentDocs(run);
    send(res, 200, {
      writeDocs: run.writeDocs,
      writePrd: run.writePrd,
      docWriter: run.docWriter,
      batch: run.docs.batch,
      missing: run.docs.missing,
      requests: run.docs.requests,
      current: { handbook: cur.handbook?.version ?? null, devdoc: cur.devdoc?.version ?? null, prd: cur.prd?.version ?? null },
      versions: docSummaries(run),
    });
  });
  on('GET', '/api/runs/:id/docs/:kind/:version', (_q, res, p) => {
    const run = orch.getRun(p.id!);
    const v = docOr404(run, p.kind!, p.version!);
    send(res, 200, { ...v, traceability: v.kind === 'prd' ? prdTraceability(run, v) : null, checklist: v.kind === 'prd' ? prdChecklist(v, recordPendingCount(run, v)) : null });
  });
  /** 预览：独立 HTML（无脚本、无外部资源），界面用 <iframe sandbox> 显示，也可以直接“打印 → 另存为 PDF” */
  on('GET', '/api/runs/:id/docs/:kind/:version/render', (_q, res, p) => {
    const run = orch.getRun(p.id!);
    const v = docOr404(run, p.kind!, p.version!);
    const html = renderStandaloneHtml(buildDocModel(run, v, { targetPlatform: config.targetPlatform }));
    send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': DOC_CSP, 'X-Frame-Options': 'SAMEORIGIN' });
  });
  on('GET', '/api/runs/:id/docs/:kind/:version/download', (req, res, p) => {
    const run = orch.getRun(p.id!);
    const v = docOr404(run, p.kind!, p.version!);
    const format = new URL(req.url ?? '/', 'http://localhost').searchParams.get('format') ?? 'html';
    if (format !== 'md' && format !== 'html') throw new HttpError(400, 'format 只能是 md 或 html');
    const model = buildDocModel(run, v, { targetPlatform: config.targetPlatform });
    const names = docFileNames(run, v, format);
    send(res, 200, format === 'md' ? renderMarkdown(model) : renderStandaloneHtml(model), {
      'Content-Type': format === 'md' ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8',
      'Content-Disposition': `attachment; filename="${names.ascii}"; filename*=UTF-8''${encodeRfc5987(names.utf8)}`,
      ...(format === 'html' ? { 'Content-Security-Policy': DOC_CSP } : {}),
    });
  });

  // ------------------------------------------------------------ SSE
  on('GET', '/api/runs/:id/events', (req, res, p) => {
    const run = orch.getRun(p.id!);
    const url = new URL(req.url ?? '/', 'http://x');
    const since = Number(req.headers['last-event-id'] ?? url.searchParams.get('since') ?? 0) || 0;
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    // An SSE comment flushes the headers now, so EventSource opens on a quiet run instead of after the first ping.
    res.write(': open\n\n');
    const write = (ev: RunEvent) => res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    let last = since;
    for (const ev of bus.replay(run.id, since)) {
      write(ev);
      last = ev.seq;
    }
    const unsub = bus.subscribe(run.id, (ev) => {
      if (ev.seq > last) {
        last = ev.seq;
        write(ev);
      }
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(ping);
      unsub();
    });
  });

  // ------------------------------------------------------------ 静态页面
  const serveStatic = (urlPath: string, res: ServerResponse) => {
    const root = path.resolve(deps.staticDir);
    const index = path.join(root, 'index.html');
    if (!existsSync(index)) {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': HTML_CSP });
      res.end(PLACEHOLDER);
      return;
    }
    const rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
    let file = path.resolve(root, rel || 'index.html');
    if (!file.startsWith(root + path.sep) && file !== root) file = index;
    if (!existsSync(file) || statSync(file).isDirectory()) file = index; // 单页应用回退
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[ext] ?? 'application/octet-stream', ...(ext === '.html' ? { 'Content-Security-Policy': HTML_CSP, 'Cache-Control': 'no-store' } : {}) });
    res.end(readFileSync(file));
  };

  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = (req.method ?? 'GET').toUpperCase();
      if (url.pathname.startsWith('/internal/chat-tools/') && deps.chatHttp) {
        if (await deps.chatHttp(req, res)) return;
      }
      const binaryBody = method === 'POST' && url.pathname === ARCHIVE_IMPORT_PATH;
      const sec = checkRequest(req, { port: config.port, devOrigins: config.devOrigins, token: deps.token, binaryBody });
      if (!sec.ok) return send(res, sec.status, { error: sec.reason });
      if (deps.chatHttp && await deps.chatHttp(req, res)) return;
      if (!url.pathname.startsWith('/api/')) {
        if (method !== 'GET' && method !== 'HEAD') return send(res, 405, { error: '不支持的方法' });
        return serveStatic(url.pathname, res);
      }
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const params: Params = {};
        r.keys.forEach((k, i) => (params[k] = m[i + 1]!));
        const body = binaryBody ? undefined : await readBody(req, url.pathname === '/api/reference-documents/import'
          ? 4 * Math.ceil(REFERENCE_LIMITS.maxZipBytes / 3) + 4096
          : url.pathname === '/api/runs' ? 2_000_000 : MAX_BODY);
        await r.handler(req, res, params, body);
        return;
      }
      send(res, 404, { error: '接口不存在' });
    } catch (e) {
      if (res.destroyed) return;
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      if (e instanceof z.ZodError) return send(res, 400, { error: e.issues.map(i => i.message).join('；') });
      send(res, 500, { error: `内部错误：${(e as Error).message}` });
    }
  };
}
