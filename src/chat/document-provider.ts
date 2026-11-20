import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod/v4';
import { HttpError } from '../orchestrator/errors.js';
import type { ChatCapabilityHost, CapabilityCall, CapabilityReply, CapabilityStatus, ProducedFile } from './capability-contract.js';
import { decodeFileBase64, fileMime, SessionFiles } from './session-files.js';
import type { ToolDefinition } from './types.js';

const string = { type: 'string' };
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const fileIds = z.array(z.string()).min(1).max(10).refine(ids => new Set(ids).size === ids.length);
const definitions: ToolDefinition[] = [
  { name: 'document_read', description: '读取已发送PDF/Word/Excel/PPT/HTML/Markdown/文本，返回带页、表、幻灯片来源的文本。返回完整结果引用后用result_read分页，不能凭文件名猜内容。', inputSchema: schema({ fileId: string }, ['fileId']) },
  { name: 'document_create', description: '创建真实docx/xlsx/pptx/md/html。document:{title,blocks:[{type:heading|paragraph|table|image,text?,level?,rows?,fileId?}],sheets:[{name,rows,widths?}],slides:[{title,body,notes?,imageFileId?}],theme?:{background,text,accent,font}}。theme 是 PPTX 可选配色/字体样式，颜色为6位RGB；混合格式请求仅应用于PPTX，不改写母版或加载模板。表格rows是二维值数组。编辑xlsx用fileId+changes[{sheet,cell,value}]。公式保留，不宣称已计算。图片只能引用本聊天文件。', inputSchema: schema({ formats: { type: 'array', items: { type: 'string', enum: ['docx','xlsx','pptx','md','html'] }, maxItems: 5 }, document: { type: 'object' }, fileId: string, changes: { type: 'array', items: { type: 'object' } } }, ['formats']) },
  { name: 'document_convert', description: '将指定会话Office文件转换为PDF，或转成md/html。程序保存可下载文件与输入哈希；不改变原件。', inputSchema: schema({ fileIds: { type: 'array', items: string, maxItems: 10 }, to: { type: 'string', enum: ['pdf','md','html'] } }, ['fileIds','to']) },
  { name: 'files_archive', description: '仅将明确选择的本聊天文件，或指定taskId的正式产物打包为ZIP。最多200文件、总请求60MiB；不读取任意目录。fileIds与taskId二选一。', inputSchema: schema({ fileIds: { type: 'array', items: string, maxItems: 200 }, taskId: string, name: string }) },
];
const cellValue = z.union([z.string().max(100_000), z.number().finite(), z.boolean(), z.null()]);
const themeSchema = z.object({
  background: z.string().regex(/^[0-9A-Fa-f]{6}$/).optional(),
  text: z.string().regex(/^[0-9A-Fa-f]{6}$/).optional(),
  accent: z.string().regex(/^[0-9A-Fa-f]{6}$/).optional(),
  font: z.string().trim().min(1).max(100).regex(/^[\p{L}\p{N}_ .,+()'\-]+$/u).optional(),
}).strict();
const documentSchema = z.object({
  title: z.string().max(200).default('文档'),
  blocks: z.array(z.object({ type: z.enum(['heading','paragraph','table','image']), text: z.string().max(100_000).optional(), level: z.number().int().min(1).max(6).optional(), rows: z.array(z.array(cellValue).max(200)).max(10_000).optional(), fileId: z.string().optional() }).strict()).max(500).optional(),
  sheets: z.array(z.object({ name: z.string().max(31), rows: z.array(z.array(cellValue).max(200)).max(10_000), widths: z.array(z.number().positive().max(200)).max(200).optional() }).strict()).max(20).optional(),
  slides: z.array(z.object({ title: z.string().max(300), body: z.union([z.string().max(10_000), z.array(z.string().max(2000)).max(30)]).optional(), notes: z.string().max(20_000).optional(), imageFileId: z.string().optional() }).strict()).max(100).optional(),
  theme: themeSchema.optional(),
}).strict();
const responseSchema = z.object({ files: z.array(z.object({ name: z.string().min(1).max(160), mime: z.string().max(200), base64: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(10), text: z.string().max(4_000_000).optional(), metadata: z.record(z.string(), z.unknown()).optional() }).strict();
export function documentWorkerIdentity() {
  const root = fileURLToPath(new URL('../../services/document-worker/document_worker/', import.meta.url));
  const digest = createHash('sha256');
  for (const name of readdirSync(root, { recursive: true }).map(String).filter(name => name.endsWith('.py')).map(name => name.replaceAll('\\','/')).sort()) digest.update(name + '\n').update(readFileSync(path.join(root, name)));
  return digest.digest('hex');
}

async function jsonResponse(response: Response, limit = 60 * 1024 * 1024) {
  if (Number(response.headers.get('content-length')) > limit) throw new HttpError(502, '文档服务响应超限');
  if (!response.body) throw new HttpError(502, '文档服务响应为空');
  const reader = response.body.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > limit) throw new HttpError(502, '文档服务响应超限'); chunks.push(next.value); }
  } finally { await reader.cancel().catch(() => undefined); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { throw new HttpError(502, '文档服务未返回合法JSON'); }
}
export class DocumentProvider {
  constructor(private readonly files: SessionFiles, private readonly settings: () => { enabled: boolean; url: string }) {}
  definitions() { return this.settings().enabled ? definitions : []; }
  private endpoint(route: string) {
    const url = new URL(this.settings().url);
    if (url.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new HttpError(400, '文档服务必须使用本机根地址');
    return new URL(route, url);
  }
  async status(): Promise<CapabilityStatus> {
    const config = this.settings(); const implementationSha256 = documentWorkerIdentity(); const base = { id: 'documents', name: '文档与Office服务', tools: definitions.map(item => item.name), fingerprint: createHash('sha256').update(JSON.stringify({ config, definitions, implementationSha256 })).digest('hex') };
    if (!config.enabled) return { ...base, state: 'disabled' };
    try {
      const response = await fetch(this.endpoint('/health'), { signal: AbortSignal.timeout(2500), redirect: 'error' });
      const result = await jsonResponse(response, 128_000) as { status?: string; version?: string; implementationSha256?: string };
      if (!response.ok || result.status !== 'ok' || !/^1(?:\.\d+){0,2}$/.test(String(result.version))) throw new Error();
      if (result.implementationSha256 !== documentWorkerIdentity()) return { ...base, state: 'drifted', reason: '运行中文档镜像与当前源码不一致，请重新构建容器' };
      return { ...base, state: 'ready' };
    } catch { return { ...base, state: 'unhealthy', reason: '文档容器未就绪；请启动项目Docker服务并检查健康状态' }; }
  }
  private file(context: CapabilityCall, id: string) {
    const { metadata, bytes } = this.files.read(context.chat, id);
    return { file: { name: metadata.name, base64: bytes.toString('base64') }, hash: metadata.hash };
  }
  private async request(payload: unknown, context: Pick<CapabilityCall, 'signal' | 'toolCallId'>, readonly: boolean) {
    const status = await this.status(); if (status.state !== 'ready') throw new HttpError(503, status.reason ?? '文档服务尚未就绪');
    const body = JSON.stringify(payload); if (Buffer.byteLength(body) > 60 * 1024 * 1024) throw new HttpError(413, '文档请求总大小超限，请减少文件');
    for (let attempt = 0;; attempt++) {
      context.signal.throwIfAborted();
      const response = await fetch(this.endpoint('/v1/jobs'), { method: 'POST', headers: { 'content-type': 'application/json', 'x-workbench-job-id': context.toolCallId }, body, signal: AbortSignal.any([context.signal, AbortSignal.timeout(120_000)]), redirect: 'error' });
      if (readonly && [429,503].includes(response.status) && attempt < 2) {
        const retry = Math.min(3000, Math.max(250, Number(response.headers.get('retry-after') ?? '0') * 1000 || 250 * 2 ** attempt)); await response.body?.cancel();
        await new Promise<void>((resolve, reject) => { const abort = () => { clearTimeout(timer); reject(context.signal.reason); }; const timer = setTimeout(() => { context.signal.removeEventListener('abort', abort); resolve(); }, retry); context.signal.addEventListener('abort', abort, { once: true }); if (context.signal.aborted) abort(); }); continue;
      }
      const data = await jsonResponse(response); context.signal.throwIfAborted();
      if (!response.ok) { const error = data as { error?: { code?: string; message?: string } }; throw new HttpError(response.status < 500 ? 422 : 502, `文档服务：${String(error.error?.message ?? '处理失败').slice(0,500)}`); }
      return responseSchema.parse(data);
    }
  }
  async inspectImage(input: { name: string; mime: string; bytes: Buffer }, signal: AbortSignal): Promise<{ mime: 'image/png' | 'image/jpeg' | 'image/webp'; width: number; height: number }> {
    if (!this.settings().enabled) throw new HttpError(503, '图像解码所需文档服务已关闭');
    // Header sniff selects a parser filename only; the isolated decoder must still load every pixel.
    const detected = fileMime(input.name,input.bytes); const extension = ({'image/png':'png','image/jpeg':'jpg','image/webp':'webp'} as Record<string,string>)[detected];
    if (!extension) throw new HttpError(415, '图片必须是PNG/JPEG/WebP字节');
    const result = await this.request({ operation: 'image_info', files: [{ name: `image.${extension}`, base64: input.bytes.toString('base64') }] }, { signal, toolCallId: `image-check-${createHash('sha256').update(input.bytes).digest('hex').slice(0,24)}` }, true);
    const data = z.object({ images: z.array(z.object({ name: z.string(), mime: z.enum(['image/png','image/jpeg','image/webp']), width: z.number().int().positive().max(16384), height: z.number().int().positive().max(16384), sha256: z.string() }).passthrough()).length(1) }).passthrough().parse(result.metadata);
    const image = data.images[0]!;
    if (image.sha256 !== createHash('sha256').update(input.bytes).digest('hex') || (input.mime !== 'application/octet-stream' && image.mime !== input.mime) || image.width * image.height > 64_000_000) throw new HttpError(502, '图像解码回执不匹配');
    return { mime: image.mime, width: image.width, height: image.height };
  }
  async call(name: string, raw: unknown, context: CapabilityCall): Promise<CapabilityReply> {
    if (!this.settings().enabled) throw new HttpError(503, '文档服务已关闭');
    const hashes: string[] = []; const file = (id: string) => { const result = this.file(context, id); hashes.push(result.hash); return result.file; };
    let payload: Record<string, unknown>;
    if (name === 'document_read') { const input = z.object({ fileId: z.string() }).strict().parse(raw); payload = { operation: 'read', files: [file(input.fileId)] }; }
    else if (name === 'document_create') {
      const input = z.object({ formats: z.array(z.enum(['docx','xlsx','pptx','md','html'])).min(1).max(5), document: documentSchema.optional(), fileId: z.string().optional(), changes: z.array(z.object({ sheet: z.string().max(31), cell: z.string().regex(/^[A-Z]{1,3}[1-9][0-9]{0,6}$/), value: cellValue }).strict()).max(10_000).optional() }).strict().parse(raw);
      if (!input.document && !input.fileId) throw new HttpError(400, '创建需要document，编辑需要fileId');
      if (input.document?.theme && !input.formats.includes('pptx')) throw new HttpError(400, 'document.theme 仅用于 PPTX，formats 必须包含 pptx');
      const document = input.document ? { ...input.document, blocks: input.document.blocks?.map(({ fileId, ...block }) => ({ ...block, ...(fileId ? { file: file(fileId) } : {}) })), slides: input.document.slides?.map(({ imageFileId, ...slide }) => ({ ...slide, body: Array.isArray(slide.body) ? slide.body.join('\n') : slide.body ?? '', ...(imageFileId ? { image: file(imageFileId) } : {}) })) } : undefined;
      payload = { operation: 'create', formats: input.formats, document, ...(input.fileId ? { file: file(input.fileId) } : {}), changes: input.changes };
    } else if (name === 'document_convert') { const input = z.object({ fileIds, to: z.enum(['pdf','md','html']) }).strict().parse(raw); payload = { operation: 'convert', files: input.fileIds.map(file), to: input.to }; }
    else if (name === 'files_archive') {
      const input = z.object({ fileIds: z.array(z.string()).min(1).max(200).optional(), taskId: z.string().optional(), name: z.string().max(160).default('任务文件.zip') }).strict().refine(value => Boolean(value.fileIds) !== Boolean(value.taskId), 'fileIds与taskId需二选一').parse(raw);
      if (input.taskId && input.taskId !== context.task.id && !context.chat.tasks.some(task => task.id === input.taskId && task.parentTaskId === context.task.id)) throw new HttpError(403, '只能归档自身或直接子任务的产物');
      const ids = input.fileIds ?? context.chat.artifacts.filter(artifact => artifact.taskId === input.taskId && artifact.fileId).map(artifact => artifact.fileId!);
      if (!ids.length || ids.length > 200 || new Set(ids).size !== ids.length) throw new HttpError(400, '归档需要1至200个唯一文件');
      const names = new Set<string>();
      const inputs = ids.map(id => { const item = file(id); let name = item.name; if (names.has(name.toLowerCase())) name = `${path.parse(name).name}-${id.slice(0,8)}${path.extname(name)}`; names.add(name.toLowerCase()); return { ...item, name }; });
      payload = { operation: 'archive', files: inputs, archiveName: input.name };
    }
    else throw new HttpError(404, '文档工具不存在');
    const result = await this.request(payload, context, name === 'document_read');
    if (name !== 'document_read' && !result.files.length) throw new HttpError(502, '文档服务未生成任何文件，不能标为成功');
    if (name === 'document_create' && !(payload.formats as string[]).every(format => result.files.some(file => path.extname(file.name).toLowerCase() === `.${format}`))) throw new HttpError(502, '文档服务未返回请求的全部格式');
    if (name === 'document_convert' && (result.files.length !== (payload.files as unknown[]).length || result.files.some(file => path.extname(file.name).toLowerCase() !== `.${payload.to}`))) throw new HttpError(502, '文档转换产物数量或格式不匹配');
    if (name === 'files_archive' && (result.files.length !== 1 || !result.files[0]!.name.toLowerCase().endsWith('.zip'))) throw new HttpError(502, '文档服务未返回ZIP归档');
    const produced: ProducedFile[] = result.files.map(item => { const bytes = decodeFileBase64(item.base64); if (createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new HttpError(502, '文档服务产物哈希不一致，整批拒绝发布'); return { name: item.name, bytes, mime: item.mime, inputHashes: [...new Set(hashes)] }; });
    const identity = documentWorkerIdentity();
    return { text: JSON.stringify({ text: result.text, metadata: result.metadata, implementationSha256: identity, inputHashes: [...new Set(hashes)], files: result.files.map(({ base64: _base64, ...item }) => item) }), data: { metadata: result.metadata, implementationSha256: identity, inputHashes: [...new Set(hashes)] }, ...(produced.length ? { files: produced } : {}) };
  }
}

/** A deterministic provider and optional extensions share the Runtime tool boundary. */
export class CourseCapabilities implements ChatCapabilityHost {
  constructor(private readonly documents: DocumentProvider, private readonly extensions: ChatCapabilityHost) {}
  definitions(task: import('./types.js').AgentTask) { return [...this.documents.definitions(), ...this.extensions.definitions(task)]; }
  call(name: string, input: unknown, context: CapabilityCall) { return this.documents.definitions().some(tool => tool.name === name) ? this.documents.call(name, input, context) : this.extensions.call(name, input, context); }
  async status() { const [documents, extensions] = await Promise.all([this.documents.status(), this.extensions.status()]); return [documents, ...extensions]; }
  settings() { return this.extensions.settings?.() ?? {}; }
  async configure(input: unknown) { if (!this.extensions.configure) throw new HttpError(503, '配置服务不可用'); return this.extensions.configure(input); }
  async close() { await this.extensions.close?.(); }
}
