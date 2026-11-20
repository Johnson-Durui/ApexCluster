import { describe, expect, it } from 'vitest';
import { bytesToBase64, mergeReferenceArchives, mergeReferenceDocuments, validateUpload, type ReferenceLimits } from './referenceDocuments';

const limits: ReferenceLimits = {
  maxDocuments: 2,
  maxDocumentChars: 10,
  maxTotalChars: 15,
  maxFileBytes: 5,
  maxZipBytes: null,
  maxArchiveEntries: 200,
  maxArchives: 1,
  maxEntryBytes: 10,
  maxExpandedBytes: 15,
};

describe('参考文档助手', () => {
  it('限制普通文本文件大小，但允许 ZIP 流式上传而不设字节上限', () => {
    expect(validateUpload({ name: 'a.md', size: 5 }, limits)).toBeNull();
    expect(validateUpload({ name: 'a.txt', size: 6 }, limits)).toContain('超过');
    expect(validateUpload({ name: 'a.zip', size: 20 * 1024 * 1024 + 1 }, limits)).toBeNull();
    expect(validateUpload({ name: 'huge.zip', size: Number.MAX_SAFE_INTEGER }, limits)).toBeNull();
    expect(validateUpload({ name: 'a.pdf', size: 1 }, limits)).toContain('仅支持');
  });

  it('原子合并文档并拒绝不区分大小写的重名', () => {
    const current = [{ name: 'Guide.md', content: 'abc' }];
    expect(() => mergeReferenceDocuments(current, [{ name: 'guide.MD', content: 'def' }], limits)).toThrow('名称重复');
    expect(current).toHaveLength(1);
  });

  it('按 NFC 规范化名称并拒绝路径或控制字符', () => {
    const current = [{ name: 'café.md', content: 'abc' }];
    expect(() => mergeReferenceDocuments(current, [{ name: 'cafe\u0301.MD', content: 'def' }], limits)).toThrow('名称重复');
    expect(() => mergeReferenceDocuments([], [{ name: '../secret.txt', content: 'abc' }], limits)).toThrow('路径');
    expect(() => mergeReferenceDocuments([], [{ name: 'safe.txt', content: 'a\u0000b' }], limits)).toThrow('控制字符');
  });

  it('合并前校验单份、总字符数和总数量', () => {
    expect(() => mergeReferenceDocuments([], [{ name: 'a.txt', content: '12345678901' }], limits)).toThrow('正文超过');
    expect(() => mergeReferenceDocuments([{ name: 'a.txt', content: '12345678' }], [{ name: 'b.txt', content: '12345678' }], limits)).toThrow('正文合计');
    expect(() => mergeReferenceDocuments([{ name: 'a.txt', content: 'a' }], [{ name: 'b.txt', content: 'b' }, { name: 'c.md', content: 'c' }], limits)).toThrow('最多 2 份');
  });

  it('对 Unicode 文本的 UTF-8 字节生成稳定 base64', () => {
    expect(bytesToBase64(new TextEncoder().encode('需求：离线'))).toBe('6ZyA5rGC77ya56a757q/');
  });

  it('原子合并 ZIP 资料包并校验编号、名称与展开限制', () => {
    const archive = { id: 'zip-1', name: 'project.zip', size: 10, files: [{ name: 'a.bin', path: 'assets/a.bin', size: 8 }], notes: [] };
    expect(mergeReferenceArchives([], [archive], limits)).toEqual([archive]);
    expect(mergeReferenceArchives([], [{ ...archive, size: 20 * 1024 * 1024 + 1 }], limits)).toHaveLength(1);
    expect(() => mergeReferenceArchives([archive], [{ ...archive, name: 'other.zip' }], limits)).toThrow('编号重复');
    expect(() => mergeReferenceArchives([archive], [{ ...archive, id: 'zip-2', name: 'PROJECT.ZIP' }], { ...limits, maxArchives: 2 })).toThrow('名称重复');
    expect(() => mergeReferenceArchives([], [{ ...archive, files: [{ name: 'large.bin', path: 'large.bin', size: 11 }] }], limits)).toThrow('包内存在');
  });
});
