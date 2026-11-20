import type { ReferenceArchive, ReferenceDocument } from '../../lib/types';
import { mergeReferenceArchives, mergeReferenceDocuments, type ReferenceLimits } from './referenceDocuments';

export const draftKey = 'workbench:new-task-draft:v1';
const textKeys = ['title', 'prompt', 'coreFlows', 'existingStack', 'deployment', 'budget', 'acceptance', 'context'] as const;
export type TaskDraft = Record<typeof textKeys[number], string> & { referenceDocuments: ReferenceDocument[]; referenceArchives: ReferenceArchive[]; discardedAttachments: number };
function isArchive(value: unknown): value is ReferenceArchive {
  if (!value || typeof value !== 'object') return false;
  const archive = value as Partial<ReferenceArchive>;
  return typeof archive.id === 'string' && archive.id.length > 0 && typeof archive.name === 'string' && /\.zip$/i.test(archive.name)
    && Number.isSafeInteger(archive.size) && archive.size! >= 0 && Array.isArray(archive.notes) && archive.notes.every(note => typeof note === 'string')
    && Array.isArray(archive.files) && archive.files.every(file => file && typeof file === 'object' && typeof file.name === 'string' && typeof file.path === 'string' && Number.isSafeInteger(file.size) && file.size >= 0);
}
export function readTaskDraft(storage: Pick<Storage, 'getItem'>, limits?: ReferenceLimits): TaskDraft {
  let value: Partial<TaskDraft> = {};
  try { const parsed: unknown = JSON.parse(storage.getItem(draftKey) ?? '{}'); if (parsed && typeof parsed === 'object') value = parsed; } catch { /* 损坏草稿不阻止创建任务。 */ }
  const documents = Array.isArray(value.referenceDocuments) ? value.referenceDocuments : [];
  const archives = Array.isArray(value.referenceArchives) ? value.referenceArchives : [];
  let referenceDocuments: ReferenceDocument[] = []; let referenceArchives: ReferenceArchive[] = []; let discardedAttachments = 0;
  for (const document of documents) {
    if (!document || typeof document.name !== 'string' || typeof document.content !== 'string') { discardedAttachments++; continue; }
    try { referenceDocuments = limits ? mergeReferenceDocuments(referenceDocuments, [document], limits) : [...referenceDocuments, document]; } catch { discardedAttachments++; }
  }
  for (const archive of archives) {
    if (!isArchive(archive)) { discardedAttachments++; continue; }
    try { referenceArchives = limits ? mergeReferenceArchives(referenceArchives, [archive], limits) : [...referenceArchives, archive]; } catch { discardedAttachments++; }
  }
  return {
    ...Object.fromEntries(textKeys.map(key => [key, typeof value[key] === 'string' ? value[key] : ''])) as Record<typeof textKeys[number], string>,
    referenceDocuments, referenceArchives, discardedAttachments,
  };
}
