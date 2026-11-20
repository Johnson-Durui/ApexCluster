import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SessionFiles } from './session-files.js';
import { ChatStore } from './store.js';
import type { ChatRecord } from './types.js';

interface BackupEntry { path: string; bytes: number; sha256: string }
interface BackupManifest { version: 1; createdAt: string; chatIds: string[]; files: BackupEntry[]; scope: 'chat-data-only' }
const hashBytes = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const hash = (file: string) => hashBytes(readFileSync(file));
const inside = (parent: string, child: string) => { const relative = path.relative(parent, child); return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)); };
const comparable = (value: string) => { const resolved = path.resolve(value).replace(/^\\\\\?\\/, ''); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; };
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).length === expected.length && expected.every(key => key in value);

function assertNoLinkedExistingPath(input: string) {
  let current = path.resolve(input);
  for (;;) {
    if (existsSync(current) && (lstatSync(current).isSymbolicLink() || comparable(realpathSync(current)) !== comparable(current))) throw new Error('备份/恢复路径不能经过链接或重解析点');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
function resolveFuturePath(input: string): string {
  const resolved = path.resolve(input); assertNoLinkedExistingPath(resolved);
  const missing: string[] = []; let current = resolved;
  while (!existsSync(current)) { missing.unshift(path.basename(current)); const parent = path.dirname(current); if (parent === current) throw new Error('找不到可验证的目标父目录'); current = parent; }
  if (!lstatSync(current).isDirectory()) throw new Error('目标父路径不是目录');
  return path.join(realpathSync(current), ...missing);
}
function distinct(sourceInput: string, targetInput: string): { source: string; target: string } {
  assertNoLinkedExistingPath(sourceInput);
  const source = realpathSync(sourceInput); if (!lstatSync(source).isDirectory()) throw new Error('备份/恢复来源必须是目录');
  const target = resolveFuturePath(targetInput);
  if (existsSync(targetInput) || existsSync(target)) throw new Error('目标必须是尚不存在的新目录，不能覆盖既有数据');
  if (inside(source, target) || inside(target, source)) throw new Error('备份/恢复目标必须位于来源之外');
  return { source, target };
}
function filesUnder(root: string, relative = ''): string[] {
  const directory = path.join(root, relative); const info = lstatSync(directory);
  if (info.isSymbolicLink()) throw new Error('备份拒绝链接目录');
  if (!info.isDirectory()) throw new Error('备份范围包含非目录节点');
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const name = path.join(relative, entry.name), absolute = path.join(root, name); const item = lstatSync(absolute);
    if (entry.isSymbolicLink() || item.isSymbolicLink()) throw new Error('备份拒绝链接或重解析输入');
    if (entry.isDirectory() && item.isDirectory()) return filesUnder(root, name);
    if (!entry.isFile() || !item.isFile()) throw new Error('备份只接受普通文件'); return [name];
  });
}
function validateRelative(name: string) {
  if (!name || path.isAbsolute(name) || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..' || /[:\x00-\x1f]/.test(part))) throw new Error('备份包含不安全路径');
  if (!/^chats\/[A-Za-z0-9_-]+\//.test(name)) throw new Error('备份范围只允许聊天数据');
}
function parseManifest(raw: string): BackupManifest {
  let value: unknown; try { value = JSON.parse(raw); } catch { throw new Error('备份清单不是合法JSON'); }
  if (!record(value) || !exactKeys(value, ['version', 'createdAt', 'chatIds', 'files', 'scope']) || value.version !== 1 || value.scope !== 'chat-data-only' || typeof value.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.createdAt) || Number.isNaN(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt || !Array.isArray(value.chatIds) || !Array.isArray(value.files) || value.files.length > 100_000) throw new Error('备份清单格式无效');
  const chatIds = value.chatIds;
  if (!chatIds.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id)) || new Set(chatIds.map(id => String(id).toLowerCase())).size !== chatIds.length) throw new Error('备份清单聊天身份无效或重复');
  const files: BackupEntry[] = value.files.map(item => {
    if (!record(item) || !exactKeys(item, ['path', 'bytes', 'sha256']) || typeof item.path !== 'string' || !Number.isSafeInteger(item.bytes) || (item.bytes as number) < 0 || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('备份清单文件字段无效');
    validateRelative(item.path); return { path: item.path, bytes: item.bytes as number, sha256: item.sha256 };
  });
  if (new Set(files.map(file => file.path.toLowerCase())).size !== files.length) throw new Error('备份清单包含重复路径');
  const ids = new Set(chatIds as string[]);
  if (files.some(file => !ids.has(file.path.split('/')[1]!)) || [...ids].some(id => !files.some(file => file.path === `chats/${id}/chat.json`))) throw new Error('备份清单聊天范围不一致');
  return { version: 1, createdAt: value.createdAt, chatIds: chatIds as string[], files, scope: 'chat-data-only' };
}
function validateBackupDirectory(root: string): BackupManifest {
  assertNoLinkedExistingPath(root);
  const manifestPath = path.join(root, 'manifest.json');
  if (!existsSync(manifestPath) || lstatSync(manifestPath).isSymbolicLink() || !lstatSync(manifestPath).isFile()) throw new Error('备份清单不存在或不是普通文件');
  const manifest = parseManifest(readFileSync(manifestPath, 'utf8'));
  const actual = filesUnder(root).map(name => name.split(path.sep).join('/')).filter(name => name !== 'manifest.json').sort();
  const declared = manifest.files.map(file => file.path).sort();
  if (actual.length !== declared.length || actual.some((name, index) => name !== declared[index])) throw new Error('备份包含未登记输入或缺少清单文件');
  for (const file of manifest.files) {
    const from = path.join(root, ...file.path.split('/')); const relative = path.relative(root, realpathSync(from)); const info = lstatSync(from);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !info.isFile() || info.isSymbolicLink() || file.bytes !== info.size || file.sha256 !== hash(from)) throw new Error(`备份完整性校验失败：${file.path}`);
  }
  return manifest;
}
function validateBlob(store: ChatStore, chatId: string, ref: string, bytes?: number, digest?: string) {
  const value = store.readBlob(chatId, ref);
  if (bytes !== undefined && value.length !== bytes) throw new Error(`登记内容长度不一致：${ref}`);
  if (digest !== undefined && hashBytes(value) !== digest) throw new Error(`登记内容哈希不一致：${ref}`);
}
function validateRegisteredData(root: string, chatIds: string[]): ChatRecord[] {
  const store = new ChatStore(root), files = new SessionFiles(store); const chats: ChatRecord[] = [];
  for (const id of chatIds) {
    const chat = store.get(id); if (chat.id !== id) throw new Error('聊天快照身份与目录不一致');
    if (new Set((chat.attachments ?? []).map(item => item.id)).size !== (chat.attachments ?? []).length) throw new Error('附件身份重复');
    for (const attachment of chat.attachments ?? []) files.read(chat, attachment.id, true);
    if (new Set(chat.artifacts.map(item => item.id)).size !== chat.artifacts.length) throw new Error('产物身份重复');
    for (const artifact of chat.artifacts) {
      if (artifact.fileId) {
        const file = files.read(chat, artifact.fileId, true); const expected = `files/${file.metadata.source === 'upload' ? 'inputs' : 'outputs'}/${file.metadata.id}`;
        if (artifact.relativePath !== expected || artifact.bytes !== file.bytes.length || artifact.hash !== hashBytes(file.bytes)) throw new Error(`登记产物与文件不一致：${artifact.id}`);
      } else validateBlob(store, id, artifact.relativePath, artifact.bytes, artifact.hash);
    }
    for (const task of chat.tasks) if (task.resultRef) validateBlob(store, id, task.resultRef);
    for (const ticket of chat.tickets) if (ticket.resultRef) validateBlob(store, id, ticket.resultRef);
    for (const result of chat.toolResults ?? []) validateBlob(store, id, result.ref, result.bytes, result.hash);
    for (const invocation of chat.invocations) if (invocation.capabilitySnapshotRef) validateBlob(store, id, invocation.capabilitySnapshotRef, undefined, invocation.capabilitySnapshot);
    chats.push(chat);
  }
  return chats;
}
function stageFor(target: string) { return path.join(path.dirname(target), `.${path.basename(target)}.staging-${process.pid}-${randomUUID()}`); }
function removeStage(stage: string, target: string) {
  if (!existsSync(stage)) return;
  const parent = path.dirname(target), relative = path.relative(parent, stage);
  if (!relative || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`) || !path.basename(stage).startsWith(`.${path.basename(target)}.staging-`)) throw new Error('拒绝清理非预期staging目录');
  rmSync(stage, { recursive: true, force: true });
}
function publish(stage: string, target: string) { if (existsSync(target)) throw new Error('目标必须是尚不存在的新目录，不能覆盖既有数据'); renameSync(stage, target); }

/** No credentials, model proofs, source projects or app configuration are included. */
export function backupChats(dataRoot: string, output: string): BackupManifest {
  const { source, target } = distinct(dataRoot, output); const chatsRoot = path.join(source, 'chats');
  const chats = existsSync(chatsRoot) ? readdirSync(chatsRoot, { withFileTypes: true }).map(item => { if (item.isSymbolicLink() || !item.isDirectory() || !/^[A-Za-z0-9_-]+$/.test(item.name)) throw new Error('聊天目录包含非法或链接节点'); return item.name; }) : [];
  const store = new ChatStore(source), before = new Map<string, string>();
  for (const id of chats) {
    const chat = store.get(id);
    if (chat.invocations.some(invocation => invocation.status === 'running') || chat.tickets.some(ticket => ticket.type === 'tool' && ticket.processStatus === 'running')) throw new Error('聊天仍有运行中的模型或工具，请先结束再备份');
    before.set(id, hash(path.join(chatsRoot, id, 'chat.json')));
  }
  validateRegisteredData(source, chats);
  const names = chats.flatMap(id => filesUnder(path.join(chatsRoot, id)).map(file => path.join('chats', id, file)));
  if (names.length > 100_000) throw new Error('备份文件数超过100000，需要分批备份');
  mkdirSync(path.dirname(target), { recursive: true }); assertNoLinkedExistingPath(path.dirname(target));
  const stage = stageFor(target); mkdirSync(stage); const entries: BackupEntry[] = [];
  try {
    for (const name of names) {
      const relative = name.split(path.sep).join('/'); validateRelative(relative);
      const from = path.join(source, name), to = path.join(stage, name); mkdirSync(path.dirname(to), { recursive: true }); copyFileSync(from, to);
      const digest = hash(to); if (digest !== hash(from)) throw new Error('备份期间文件发生变化，本次目录不能作为有效备份');
      entries.push({ path: relative, bytes: lstatSync(to).size, sha256: digest });
    }
    for (const [id, digest] of before) if (hash(path.join(chatsRoot, id, 'chat.json')) !== digest) throw new Error('备份期间聊天发生变化，未生成有效清单');
    for (const entry of entries) {
      const current = path.join(source, ...entry.path.split('/')), info = lstatSync(current);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.bytes || hash(current) !== entry.sha256) throw new Error('备份期间源文件发生变化，未生成有效备份');
    }
    const manifest: BackupManifest = { version: 1, createdAt: new Date().toISOString(), chatIds: chats, files: entries, scope: 'chat-data-only' };
    writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    validateBackupDirectory(stage); validateRegisteredData(stage, chats); validateBackupDirectory(stage); publish(stage, target); return manifest;
  } catch (error) { removeStage(stage, target); throw error; }
}
export function restoreChats(backupRoot: string, output: string): ChatRecord[] {
  const { source, target } = distinct(backupRoot, output); const manifest = validateBackupDirectory(source);
  mkdirSync(path.dirname(target), { recursive: true }); assertNoLinkedExistingPath(path.dirname(target));
  const stage = stageFor(target); mkdirSync(stage);
  try {
    for (const file of manifest.files) { const to = path.join(stage, ...file.path.split('/')); mkdirSync(path.dirname(to), { recursive: true }); copyFileSync(path.join(source, ...file.path.split('/')), to); }
    const chats = validateRegisteredData(stage, manifest.chatIds); publish(stage, target); return chats;
  } catch (error) { removeStage(stage, target); throw error; }
}
