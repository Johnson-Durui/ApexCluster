import { expect, test } from 'vitest';
import { draftKey, readTaskDraft } from './taskDraft';

test('标签页草稿恢复正文与成功导入附件，损坏字段不影响其余草稿', () => {
  const draft = readTaskDraft({ getItem: key => key === draftKey ? JSON.stringify({ title: '目标', prompt: '验收', coreFlows: 1, referenceDocuments: [{ name: 'a.md', content: '资料' }, null], referenceArchives: null }) : null });
  expect(draft.title).toBe('目标');
  expect(draft.prompt).toBe('验收');
  expect(draft.coreFlows).toBe('');
  expect(draft.referenceDocuments).toEqual([{ name: 'a.md', content: '资料' }]);
  expect(draft.referenceArchives).toEqual([]);
  expect(readTaskDraft({ getItem: () => '{broken' }).title).toBe('');
});

test('损坏ZIP成员与超过当前限制的附件被丢弃，正文继续可用', () => {
  const good = { id: 'zip-good', name: '资料.zip', size: 50, files: [{ name: 'a.txt', path: 'safe/a.txt', size: 10 }], notes: ['本地资料'] };
  const value = { title: '保留目标', referenceArchives: [good, { ...good, id: 'bad-1', files: [null] }, { ...good, id: 'bad-2', size: -2 }, { ...good, id: 'bad-3', notes: [null] }] };
  const storage = { getItem: () => JSON.stringify(value) };
  expect(readTaskDraft(storage)).toMatchObject({ title: '保留目标', referenceArchives: [good], discardedAttachments: 3 });
  const limits = { maxDocuments: 2, maxDocumentChars: 20, maxTotalChars: 30, maxFileBytes: 100, maxZipBytes: null, maxArchives: 2, maxArchiveEntries: 2, maxEntryBytes: 5, maxExpandedBytes: 20 };
  expect(readTaskDraft(storage, limits).referenceArchives).toHaveLength(0);
});
