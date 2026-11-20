import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod/v4';
import { HttpError } from '../orchestrator/errors.js';
import { ProjectOutputStore, type ProjectExport } from '../artifacts/project-output.js';
import type { ProducedFile } from './capability-contract.js';
import { ChatStore } from './store.js';
import type { ChatArtifact, ChatAttachment, ChatRecord, ProgramDiffArtifact } from './types.js';

export const SESSION_FILE_LIMITS = { fileBytes: 20 * 1024 * 1024, totalBytes: 200 * 1024 * 1024, files: 200, batch: 10 } as const;
const filename = z.string().min(1).max(160).refine(name => !/[\\/:\x00-\x1f\x7f]/.test(name) && name !== '.' && name !== '..' && name === name.trim() && !name.endsWith('.'), '文件名不能包含路径或控制字符');
const blocked = /\.(exe|com|scr|msi|dll|bat|cmd|ps1|vbs|lnk|hta)$/i;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function decodeFileBase64(value: string): Buffer {
  if (value.length > Math.ceil(SESSION_FILE_LIMITS.fileBytes / 3) * 4) throw new HttpError(413, '单文件最大20 MiB');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new HttpError(400, '文件不是合法base64');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > SESSION_FILE_LIMITS.fileBytes || bytes.toString('base64') !== value) throw new HttpError(413, '文件大小或编码校验失败');
  return bytes;
}
export function fileMime(name: string, bytes: Uint8Array): string {
  const b = Buffer.from(bytes); const extension = path.extname(name).toLowerCase();
  if (b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a/.test(b.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (b.subarray(0,4).toString() === 'RIFF' && b.subarray(8,12).toString() === 'WEBP') return 'image/webp';
  if (b.subarray(0,5).toString() === '%PDF-') return 'application/pdf';
  if (b[0] === 80 && b[1] === 75) return ({ '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' } as Record<string, string>)[extension] ?? 'application/zip';
  if (['.txt','.md','.csv','.tsv','.json','.html','.htm','.xml','.svg','.py','.js','.ts','.yaml','.yml','.css'].includes(extension) && !b.includes(0)) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

/** Immutable per-chat blobs. Display names never become filesystem paths. */
export class SessionFiles {
  constructor(private readonly store: ChatStore, private readonly projectOutputs?: ProjectOutputStore) {}
  exportToProject(chat: ChatRecord, taskId: string, name: string, bytes: Uint8Array): ProjectExport | undefined {
    if (!chat.workspaceId || !this.projectOutputs) return undefined;
    try {
      const task = chat.tasks.find(item => item.id === taskId);
      if (task?.workspaceId && task.workspaceId !== chat.workspaceId) throw new Error('任务与聊天的项目授权不一致');
      return this.projectOutputs.save({ workspaceId: chat.workspaceId, workspaceVersion: task?.workspaceVersion, chatId: chat.id, name, bytes });
    } catch (error) { return { status: 'failed', error: (error instanceof Error ? error.message : '项目目录不可写').slice(0, 500) }; }
  }
  private rollbackExport(output?: ProjectExport) {
    if (output?.status === 'saved') {
      try { this.projectOutputs!.rollback(output); } catch { /* Preserve files changed by the user or covered by a revoked grant. */ }
    }
  }
  list(chat: ChatRecord, includePending = false): ChatAttachment[] {
    return (chat.attachments ?? []).filter(file => includePending || file.source === 'generated' || file.messageIds?.length);
  }
  private directory(chat: ChatRecord, source: ChatAttachment['source']) {
    const root = this.store.sessionDirectory(chat.id);
    if (lstatSync(root).isSymbolicLink()) throw new HttpError(409, '会话文件目录不能是链接');
    const dir = path.join(root, source === 'upload' ? 'inputs' : 'outputs');
    mkdirSync(dir, { recursive: true });
    if (lstatSync(dir).isSymbolicLink()) throw new HttpError(409, '文件目录不能是链接');
    return dir;
  }
  private filePath(chat: ChatRecord, file: ChatAttachment) {
    if (!/^[0-9a-f-]{36}$/.test(file.id)) throw new HttpError(400, '文件身份非法');
    const target = path.join(this.directory(chat, file.source), file.id);
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new HttpError(409, '文件不能是链接');
    return target;
  }
  read(chat: ChatRecord, id: string, includePending = false): { metadata: ChatAttachment; bytes: Buffer } {
    const metadata = chat.attachments?.find(item => item.id === id);
    if (!metadata) throw new HttpError(404, '会话文件不存在');
    if (!includePending && metadata.source === 'upload' && !metadata.messageIds?.length) throw new HttpError(409, '附件尚未发送给智能体');
    const bytes = readFileSync(this.filePath(chat, metadata));
    if (bytes.length !== metadata.bytes || hash(bytes) !== metadata.hash) throw new HttpError(409, '文件内容校验失败，请恢复原文件');
    return { metadata, bytes };
  }
  private validate(chat: ChatRecord, inputs: ProducedFile[]) {
    if (!inputs.length || inputs.length > SESSION_FILE_LIMITS.batch) throw new HttpError(400, '每批需要1至10个文件');
    if ((chat.attachments?.length ?? 0) + inputs.length > SESSION_FILE_LIMITS.files) throw new HttpError(413, '每个聊天最多200个文件');
    for (const input of inputs) {
      filename.parse(input.name);
      if (blocked.test(input.name)) throw new HttpError(415, '不接受可执行文件或系统脚本附件');
      if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength > SESSION_FILE_LIMITS.fileBytes) throw new HttpError(413, '单文件最大20 MiB');
      if (input.inputHashes?.some(value => !/^[a-f0-9]{64}$/.test(value))) throw new HttpError(400, '输入文件哈希无效');
    }
    const total = (chat.attachments ?? []).reduce((n, file) => n + file.bytes, 0) + inputs.reduce((n, file) => n + file.bytes.byteLength, 0);
    if (total > SESSION_FILE_LIMITS.totalBytes) throw new HttpError(413, '每个聊天文件总量最大200 MiB');
  }
  private put(chat: ChatRecord, inputs: ProducedFile[], origin: Pick<ChatAttachment, 'source' | 'taskId' | 'invocationId' | 'clientUploadId'>, registerArtifacts = false) {
    this.validate(chat, inputs);
    const items: ChatAttachment[] = inputs.map(input => ({ id: randomUUID(), name: input.name, bytes: input.bytes.byteLength, hash: hash(input.bytes), mime: fileMime(input.name, input.bytes), createdAt: new Date().toISOString(), ...origin, ...(input.inputHashes ? { inputHashes: input.inputHashes } : {}) }));
    const written: string[] = []; const before = chat.attachments; const beforeArtifacts = chat.artifacts;
    try {
      items.forEach((item, index) => { const file = this.filePath(chat, item); writeFileSync(file, inputs[index]!.bytes, { flag: 'wx' }); written.push(file); });
      if (origin.source === 'generated') items.forEach((item, index) => {
        const output = this.exportToProject(chat, origin.taskId!, item.name, inputs[index]!.bytes);
        if (output) item.projectExport = output;
      });
      chat.attachments = [...(before ?? []), ...items];
      if (registerArtifacts) chat.artifacts = [...beforeArtifacts, ...items.map(file => ({ id: randomUUID(), taskId: origin.taskId!, invocationId: origin.invocationId!, name: file.name, relativePath: `files/outputs/${file.id}`, fileId: file.id, mime: file.mime, inputHashes: file.inputHashes, hash: file.hash, bytes: file.bytes, kind: 'file' as const, createdAt: file.createdAt, provenance: 'model' as const, ...(file.projectExport ? { projectExport: file.projectExport } : {}) }))];
      this.store.save(chat); return items;
    } catch (error) {
      chat.attachments = before;
      chat.artifacts = beforeArtifacts;
      items.forEach(item => this.rollbackExport(item.projectExport));
      for (const file of written) { try { unlinkSync(file); } catch { /* Orphan is not registered or exposed. */ } }
      throw error;
    }
  }
  upload(chat: ChatRecord, raw: { name: string; base64: string; clientUploadId: string }): ChatAttachment {
    const input = z.object({ name: filename, base64: z.string(), clientUploadId: z.string().min(1).max(100) }).strict().parse(raw);
    const bytes = decodeFileBase64(input.base64);
    const prior = chat.attachments?.find(item => item.clientUploadId === input.clientUploadId);
    if (prior) {
      if (prior.name !== input.name || prior.hash !== hash(bytes)) throw new HttpError(409, '相同上传身份对应不同文件');
      this.read(chat, prior.id, true); return prior;
    }
    return this.put(chat, [{ name: input.name, bytes }], { source: 'upload', clientUploadId: input.clientUploadId })[0]!;
  }
  publish(chat: ChatRecord, taskId: string, invocationId: string, inputs: ProducedFile[]) { return this.put(chat, inputs, { source: 'generated', taskId, invocationId }); }
  publishArtifacts(chat: ChatRecord, taskId: string, invocationId: string, inputs: ProducedFile[]) {
    const files = this.put(chat, inputs, { source: 'generated', taskId, invocationId }, true);
    const ids = new Set(files.map(file => file.id));
    return { files, artifacts: chat.artifacts.filter(artifact => artifact.fileId && ids.has(artifact.fileId)) };
  }
  publishTextArtifact(chat: ChatRecord, taskId: string, invocationId: string, input: { name: string; text: string; kind: ChatArtifact['kind']; binding?: ProgramDiffArtifact['binding'] }, provenance: NonNullable<ChatArtifact['provenance']>): ChatArtifact {
    filename.parse(input.name);
    const blob = this.store.putBlob(chat.id, `artifact-${randomUUID()}.txt`, input.text);
    const output = this.exportToProject(chat, taskId, input.name, Buffer.from(input.text));
    const artifact: ChatArtifact = { id: randomUUID(), taskId, invocationId, name: input.name, ...blob, kind: input.kind, createdAt: new Date().toISOString(), provenance, ...(input.binding ? { binding: input.binding } : {}), ...(output ? { projectExport: output } : {}) };
    const before = chat.artifacts;
    try {
      chat.artifacts = [...before, artifact]; this.store.save(chat); return artifact;
    } catch (error) { chat.artifacts = before; this.rollbackExport(output); throw error; }
  }
  validateBinding(chat: ChatRecord, ids: string[]) {
    z.array(z.string()).max(SESSION_FILE_LIMITS.batch).refine(list => new Set(list).size === list.length, '附件身份重复').parse(ids);
    ids.forEach(id => this.read(chat, id, true));
  }
  bind(chat: ChatRecord, ids: string[], messageId: string, persist = true) {
    if (!ids.length) return;
    this.validateBinding(chat, ids);
    for (const id of ids) { const file = chat.attachments!.find(item => item.id === id)!; file.messageIds = [...new Set([...(file.messageIds ?? []), messageId])]; }
    if (persist) this.store.save(chat);
  }
  remove(chat: ChatRecord, id: string) {
    const file = chat.attachments?.find(item => item.id === id); if (!file) throw new HttpError(404, '附件不存在');
    if (file.messageIds?.length || file.source !== 'upload') throw new HttpError(409, '已发送附件和正式产物不能删除');
    const target = this.filePath(chat, file); const before = chat.attachments;
    chat.attachments = chat.attachments!.filter(item => item.id !== id);
    try { this.store.save(chat); } catch (error) { chat.attachments = before; throw error; }
    try { unlinkSync(target); } catch { /* An unreferenced orphan cannot be read through the API. */ }
  }
}
