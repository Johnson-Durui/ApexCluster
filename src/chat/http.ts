import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod/v4';
import { pipelineCreateSchema, pipelineGateActionSchema, type PipelineGateId } from '../pipeline/state.js';
import { HttpError } from '../orchestrator/errors.js';
import { safePlanFeedback } from './plans.js';
import { SECURITY_HEADERS, allowedHosts } from '../server/security.js';
import type { ChatRuntime } from './runtime.js';
import type { WorkspaceGrant, WorkspaceRegistry } from './workspace.js';

interface Selection { requestId: string; status: 'pending' | 'selected' | 'cancelled'; expiresAt: number; workspace?: WorkspaceGrant }
/** 浏览器只能发起选择；只有启动器的私有 stdin 协议能提交原生对话框结果。 */
export class NativeDirectorySelector {
  private transport?: (requestId: string) => void;
  private readonly selections = new Map<string, Selection>();
  constructor(private readonly registry: WorkspaceRegistry) {}
  setTransport(transport: (requestId: string) => void) { this.transport = transport; }
  get available() { return !!this.transport; }
  request() {
    if (!this.transport) throw new HttpError(503, '请从便携启动器打开工作台，以使用原生目录选择');
    if ([...this.selections.values()].some(s => s.status === 'pending' && s.expiresAt > Date.now())) throw new HttpError(409, '已有目录选择窗口，请先完成该选择');
    const requestId = this.registry.issueNativeSelectionRequest();
    const selection: Selection = { requestId, status: 'pending', expiresAt: Date.now() + 120_000 };
    this.selections.set(requestId, selection); this.transport(requestId); return selection;
  }
  result(requestId: string): Selection {
    const selection = this.selections.get(requestId); if (!selection) throw new HttpError(404, '目录选择请求不存在');
    if (selection.status === 'pending' && selection.expiresAt <= Date.now()) selection.status = 'cancelled';
    return selection;
  }
  completeFromHost(requestId: string, selectedPath: string | null) {
    const selection = this.result(requestId);
    // A native dialog may return after timeout/cancellation; discard its path without killing the desktop host.
    if (selection.status === 'cancelled') return selection;
    if (selection.status !== 'pending') throw new HttpError(409, '目录选择请求已结束');
    if (!selectedPath) selection.status = 'cancelled';
    else { selection.workspace = this.registry.grantFromNativeSelection(selectedPath, requestId); selection.status = 'selected'; }
    return selection;
  }
}
export interface ChatHttpOptions {
  runtime?: ChatRuntime; registry?: WorkspaceRegistry; picker?: NativeDirectorySelector;
  bridgeToken: string; port: number; dataRoot: string; unavailableReason?: string;
  runner?: { available: boolean; reason?: string; platforms?: import('./runner-contract.js').RunnerAvailability[]; commands?: import('./runner-contract.js').RunnerCommandInfo[] };
}
function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage, maxBytes = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) { bytes += (chunk as Buffer).length; if (bytes > maxBytes) throw new HttpError(413, '请求体过大'); chunks.push(chunk as Buffer); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new HttpError(400, '请求体不是合法JSON'); }
}
const number = (value: string | null, fallback: number, max = Number.MAX_SAFE_INTEGER) => { if (value === null) return fallback; if (!/^\d+$/.test(value)) throw new HttpError(400, '分页参数应为非负整数'); const n = Number(value); if (!Number.isSafeInteger(n) || n > max) throw new HttpError(400, '分页参数超出范围'); return n; };
const idPattern = '[A-Za-z0-9_-]+';
export function createChatHttp(options: ChatHttpOptions) {
  const runtime = () => { if (!options.runtime) throw new HttpError(503, options.unavailableReason ?? '聊天运行层不可用'); return options.runtime; };
  const registry = () => { if (!options.registry) throw new HttpError(503, options.unavailableReason ?? '本地工作区不可用'); return options.registry; };
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1'); const method = req.method ?? 'GET'; const pathname = url.pathname;
    if (pathname.startsWith('/internal/chat-tools/')) {
      const match = new RegExp(`^/internal/chat-tools/(${idPattern})/(${idPattern})$`).exec(pathname);
      if (method !== 'POST' || !match || req.headers.origin || !['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(req.socket.remoteAddress ?? '') || !allowedHosts(options.port).includes(req.headers.host ?? '')) throw new HttpError(403, '内部工具入口拒绝请求');
      const expected = createHmac('sha256', options.bridgeToken).update(`${match[1]}\n${match[2]}`).digest('hex');
      const supplied = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw new HttpError(403, '内部工具身份无效');
      const input = z.object({ name: z.string().min(1).max(100), arguments: z.unknown() }).strict().parse(await body(req));
      try { send(res, 200, await runtime().callTool(match[1]!, match[2]!, input.name, input.arguments)); }
      catch (error) {
        const feedback = safePlanFeedback(error, input.name);
        if (!feedback) throw error;
        send(res, feedback.status, { planError: { code: feedback.code, details: feedback.details } });
      }
      return true;
    }
    if (pathname === '/api/chat-capabilities' && method === 'GET') {
      const [services, exec] = await Promise.all([options.runtime?.serviceCapabilities(), options.runtime?.execCapabilities()]);
      send(res, 200, { drivers: options.runtime?.capabilities() ?? [], services: services ?? [], exec,
        apiConfiguration: options.runtime?.apiConfiguration?.(exec),
        runner: options.runner ?? { available: false, reason: '测试runner尚未验证' }, nativePicker: options.picker?.available ?? false,
        dataRoot: options.dataRoot, unavailableReason: options.unavailableReason });
      return true;
    }
    if (pathname === '/api/chat-settings') {
      if (method === 'GET') { send(res, 200, runtime().serviceSettings()); return true; }
      if (method === 'PUT') { send(res, 200, await runtime().configureServices(await body(req))); return true; }
    }
    if (pathname === '/api/workspaces' && method === 'GET') { send(res, 200, registry().list()); return true; }
    if (pathname === '/api/workspaces/select' && method === 'POST') { z.object({}).strict().parse(await body(req)); if (!options.picker) throw new HttpError(503, '原生目录选择不可用'); send(res, 202, options.picker.request()); return true; }
    const selection = new RegExp(`^/api/workspaces/select/(${idPattern})$`).exec(pathname);
    if (selection && method === 'GET') { if (!options.picker) throw new HttpError(503, '原生目录选择不可用'); send(res, 200, options.picker.result(selection[1]!)); return true; }
    const workspace = new RegExp(`^/api/workspaces/(${idPattern})$`).exec(pathname);
    if (workspace && method === 'DELETE') { z.object({}).strict().parse(await body(req)); registry().revoke(workspace[1]!); options.runtime?.revokeWorkspace(workspace[1]!); send(res, 200, { revoked: true }); return true; }
    if (pathname === '/api/chats') {
      if (method === 'GET') { send(res, 200, runtime().list()); return true; }
      if (method === 'POST') { const input = z.object({ title: z.string().trim().min(1).max(200).optional(), workspaceId: z.string().max(100).optional(), pipeline: pipelineCreateSchema.optional() }).strict().parse(await body(req)); send(res, 201, runtime().create(input)); return true; }
    }
    const pipelineGate = new RegExp(`^/api/chats/(${idPattern})/gates/(A|B)$`).exec(pathname);
    if (pipelineGate) {
      if (method !== 'POST') throw new HttpError(405, '该流水线关卡接口只接受POST');
      const decision = pipelineGateActionSchema.parse(await body(req));
      send(res, 200, runtime().decidePipelineGate(pipelineGate[1]!, pipelineGate[2]! as PipelineGateId, decision)); return true;
    }
    const chat = new RegExp(`^/api/chats/(${idPattern})(?:/(messages|answers|cancel|events|artifacts|attachments|trace)(?:/(${idPattern}))?)?$`).exec(pathname);
    if (!chat) return false;
    const rt = runtime(); const id = chat[1]!; const action = chat[2]; rt.get(id);
    if (!action && method === 'GET') { const page = rt.store.messages(id); const record = rt.get(id); send(res, 200, { chat: record, messages: page.items, nextBefore: page.nextBefore, capabilities: rt.capabilities(), streams: rt.streams(id), recentEvents: rt.store.events(id, Math.max(0, record.seq - 500), 500).items }); return true; }
    if (action === 'messages' && method === 'GET') { send(res, 200, rt.store.messages(id, { before: url.searchParams.has('before') ? number(url.searchParams.get('before'), 0) : undefined, limit: number(url.searchParams.get('limit'), 50, 50) })); return true; }
    if (action === 'messages' && method === 'POST') { const input = z.object({ text: z.string().min(1).max(100_000), clientMessageId: z.string().min(1).max(100), confirmCost: z.boolean().optional(), attachmentIds: z.array(z.string()).max(10).optional() }).strict().parse(await body(req)); send(res, 202, rt.send(id, input)); return true; }
    if (action === 'answers' && method === 'POST') { send(res, 202, rt.answer(id, z.object({ ticketId: z.string(), text: z.string().min(1).max(100_000), clientMessageId: z.string().min(1).max(100) }).strict().parse(await body(req)))); return true; }
    if (action === 'cancel' && method === 'POST') { z.object({}).strict().parse(await body(req)); send(res, 200, rt.cancel(id)); return true; }
    if (action === 'trace' && method === 'GET') {
      const page = rt.store.events(id, number(url.searchParams.get('since'), 0), 500);
      send(res, 200, { ...page, schemaVersion: 1 }); return true;
    }
    if (action === 'attachments') {
      if (!chat[3] && method === 'GET') { send(res, 200, rt.files.list(rt.get(id), true)); return true; }
      if (!chat[3] && method === 'POST') {
        const input = z.object({ name: z.string().min(1).max(160), base64: z.string(), clientUploadId: z.string().min(1).max(100) }).strict().parse(await body(req, 28 * 1024 * 1024 + 4096));
        send(res, 201, rt.upload(id, input)); return true;
      }
      if (chat[3] && method === 'DELETE') { z.object({}).strict().parse(await body(req)); rt.removeUpload(id, chat[3]); send(res, 200, { removed: true }); return true; }
      if (chat[3] && method === 'GET') {
        const file = rt.files.read(rt.get(id), chat[3], true); const preview = url.searchParams.get('preview') === '1';
        const canPreview = /^image\/(png|jpeg|gif|webp)$/.test(file.metadata.mime) || file.metadata.mime.startsWith('text/plain');
        if (preview && !canPreview) throw new HttpError(415, '此文件请下载后打开，浏览器不直接执行主动内容');
        res.writeHead(200, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', 'Content-Type': preview ? file.metadata.mime : 'application/octet-stream', 'Content-Length': String(file.bytes.length), 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': `${preview ? 'inline' : 'attachment'}; filename="file"; filename*=UTF-8''${encodeURIComponent(file.metadata.name)}` }); res.end(file.bytes); return true;
      }
    }
    if (action === 'artifacts' && chat[3] && method === 'GET') {
      const artifact = rt.get(id).artifacts.find(a => a.id === chat[3]); if (!artifact) throw new HttpError(404, '文件不存在');
      const data = artifact.fileId ? rt.files.read(rt.get(id), artifact.fileId).bytes : rt.store.readBlob(id, artifact.relativePath);
      res.writeHead(200, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', 'Content-Type': 'application/octet-stream', 'Content-Length': String(data.length), 'Content-Disposition': `attachment; filename="artifact"; filename*=UTF-8''${encodeURIComponent(artifact.name)}` }); res.end(data); return true;
    }
    if (action === 'events' && method === 'GET') {
      let since = number(req.headers['last-event-id'] ? String(req.headers['last-event-id']) : url.searchParams.get('since'), 0);
      if (since > rt.get(id).seq) since = 0;
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      // An SSE comment flushes the headers now, so EventSource opens on an idle chat instead of after the first ping.
      res.write(': open\n\n');
      const write = (event: import('./types.js').ChatEvent) => { if (event.seq <= since || res.destroyed) return; since = event.seq; res.write(`id: ${event.seq}\nevent: chat_event\ndata: ${JSON.stringify(event)}\n\n`); };
      // 每次重放最多500。live时订阅，恢复过程中没有await，不存在订阅缝隙。
      const page = rt.store.events(id, since, 500); page.items.forEach(write);
      if (page.hasMore) { res.write(`event: chat_more\ndata: ${JSON.stringify({ since })}\n\n`); res.end(); return true; }
      const unsubscribe = rt.subscribe(id, write); const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
      const close = () => { clearInterval(ping); unsubscribe(); }; req.once('close', close); res.once('close', close); return true;
    }
    throw new HttpError(405, '该聊天接口不支持此方法');
  };
}
