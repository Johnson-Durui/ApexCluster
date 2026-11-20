import { describe, expect, it } from 'vitest';
import { validateAttachmentFiles } from './ChatPage';

const file = (name: string, size: number) => ({ name, size }) as File;

describe('chat attachment selection', () => {
  it('keeps at most ten files in one batch', () => {
    const result = validateAttachmentFiles(Array.from({ length: 12 }, (_, index) => file(`${index}.txt`, 10)));
    expect(result.accepted).toHaveLength(10);
    expect(result.error).toContain('最多选择 10 个');
  });

  it('rejects files over 20 MiB while retaining valid files', () => {
    const result = validateAttachmentFiles([file('large.bin', 20 * 1024 * 1024 + 1), file('ok.md', 20)]);
    expect(result.accepted.map(item => item.name)).toEqual(['ok.md']);
    expect(result.error).toContain('超过 20 MiB');
  });

  it('still rejects oversized files when the batch also exceeds ten files', () => {
    const files = [file('large.bin', 20 * 1024 * 1024 + 1), ...Array.from({ length: 10 }, (_, index) => file(`${index}.txt`, 10))];
    const result = validateAttachmentFiles(files);
    expect(result.accepted).toHaveLength(9);
    expect(result.accepted.some(item => item.name === 'large.bin')).toBe(false);
    expect(result.error).toContain('最多选择 10 个');
    expect(result.error).toContain('超过 20 MiB');
  });
});
