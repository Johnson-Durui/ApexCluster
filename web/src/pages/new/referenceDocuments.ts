import type { ReferenceArchive, ReferenceDocument } from '../../lib/types';

export interface ReferenceLimits {
  maxDocuments: number;
  maxDocumentChars: number;
  maxTotalChars: number;
  maxFileBytes: number;
  maxZipBytes: null;
  maxArchiveEntries: number;
  maxArchives: number;
  maxEntryBytes: number;
  maxExpandedBytes: number;
}

export interface UploadLike { name: string; size: number }

const TEXT_EXTENSIONS = ['.md', '.txt'];
const INVALID_FILENAME = /[\\/:\u0000-\u001f\u007f]/;
const INVALID_TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export function normalizeReferenceName(name: string, fallback = '参考文档.txt'): string {
  const trimmed = name.trim().normalize('NFC');
  return trimmed || fallback;
}

export function canonicalReferenceName(name: string): string {
  return normalizeReferenceName(name).toLocaleLowerCase();
}

export function referenceExtension(name: string): '.md' | '.txt' | '.zip' | null {
  const lower = name.trim().toLocaleLowerCase();
  if (lower.endsWith('.md')) return '.md';
  if (lower.endsWith('.txt')) return '.txt';
  if (lower.endsWith('.zip')) return '.zip';
  return null;
}

export function validateUpload(file: UploadLike, limits: ReferenceLimits): string | null {
  const extension = referenceExtension(file.name);
  if (!extension) return `${file.name}：仅支持 .md、.txt 或 .zip`;
  if (extension !== '.zip' && file.size > limits.maxFileBytes) return `${file.name}：文件大小超过 ${formatBytes(limits.maxFileBytes)}`;
  return null;
}

export function validatePastedDocument(document: ReferenceDocument, limits: ReferenceLimits): string | null {
  const normalizedName = normalizeReferenceName(document.name);
  const extension = referenceExtension(normalizedName);
  if (normalizedName.length > 240) return '文档名称不能超过 240 个字符';
  if (normalizedName === '.' || normalizedName === '..' || INVALID_FILENAME.test(normalizedName)) return '文档名称不能包含路径、冒号或控制字符';
  if (!extension || !TEXT_EXTENSIONS.includes(extension)) return '文档名称必须以 .md 或 .txt 结尾';
  if (!document.content.trim()) return '请填写文档正文';
  if (INVALID_TEXT_CONTROL.test(document.content)) return `${normalizedName}：正文包含不支持的控制字符`;
  if (document.content.length > limits.maxDocumentChars) return `${document.name}：正文超过 ${formatCount(limits.maxDocumentChars)} 个字符`;
  return null;
}

export function mergeReferenceDocuments(
  current: ReferenceDocument[],
  incoming: ReferenceDocument[],
  limits: ReferenceLimits,
): ReferenceDocument[] {
  const names = new Set(current.map(item => canonicalReferenceName(item.name)));
  for (const document of incoming) {
    const key = canonicalReferenceName(document.name);
    if (names.has(key)) throw new Error(`文档名称重复：${document.name}。请先删除旧文档或改名后再添加。`);
    const issue = validatePastedDocument(document, limits);
    if (issue) throw new Error(issue);
    names.add(key);
  }
  const merged = [...current, ...incoming];
  if (merged.length > limits.maxDocuments) throw new Error(`参考文档最多 ${limits.maxDocuments} 份`);
  const totalChars = merged.reduce((sum, item) => sum + item.content.length, 0);
  if (totalChars > limits.maxTotalChars) throw new Error(`参考文档正文合计不能超过 ${formatCount(limits.maxTotalChars)} 个字符`);
  return merged;
}

export function mergeReferenceArchives(
  current: ReferenceArchive[],
  incoming: ReferenceArchive[],
  limits: ReferenceLimits,
): ReferenceArchive[] {
  const ids = new Set(current.map(item => item.id));
  const names = new Set(current.map(item => canonicalReferenceName(item.name)));
  for (const archive of incoming) {
    if (ids.has(archive.id)) throw new Error(`资料包编号重复：${archive.id}`);
    const key = canonicalReferenceName(archive.name);
    if (names.has(key)) throw new Error(`资料包名称重复：${archive.name}。请先删除旧资料包或改名后再添加。`);
    if (referenceExtension(archive.name) !== '.zip') throw new Error(`${archive.name}：资料包名称必须以 .zip 结尾`);
    if (archive.files.length > limits.maxArchiveEntries) throw new Error(`${archive.name}：包内文件超过 ${limits.maxArchiveEntries} 个`);
    if (archive.files.some(file => file.size > limits.maxEntryBytes)) throw new Error(`${archive.name}：包内存在超过 ${formatBytes(limits.maxEntryBytes)} 的文件`);
    const expandedBytes = archive.files.reduce((sum, file) => sum + file.size, 0);
    if (expandedBytes > limits.maxExpandedBytes) throw new Error(`${archive.name}：展开后超过 ${formatBytes(limits.maxExpandedBytes)}`);
    ids.add(archive.id);
    names.add(key);
  }
  const merged = [...current, ...incoming];
  if (merged.length > limits.maxArchives) throw new Error(`ZIP 资料包最多 ${limits.maxArchives} 个`);
  return merged;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const value = (first << 16) | (second << 8) | third;
    output += alphabet[(value >>> 18) & 63];
    output += alphabet[(value >>> 12) & 63];
    output += index + 1 < bytes.length ? alphabet[(value >>> 6) & 63] : '=';
    output += index + 2 < bytes.length ? alphabet[value & 63] : '=';
  }
  return output;
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}

export function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${value / (1024 * 1024)} MB`;
  return `${Math.ceil(value / 1024)} KB`;
}
