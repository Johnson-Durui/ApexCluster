import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { ReferenceDocumentList } from './ReferenceDocumentList';

test('旧快照没有文档时保持兼容；参考正文和文件名均按文本展示', () => {
  expect(renderToStaticMarkup(<ReferenceDocumentList />)).toBe('');
  const html = renderToStaticMarkup(<ReferenceDocumentList documents={[{ name: '<img src=x>.md', content: '<script>alert(1)</script>\n{{变量}}' }]} />);
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(html).toContain('&lt;img src=x&gt;.md');
  expect(html).toContain('{{变量}}');
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('<img');
});

test('ZIP 清单展示原包和限制，文件名按纯文本显示', () => {
  const html = renderToStaticMarkup(<ReferenceDocumentList archives={[{
    id: 'a'.repeat(64), name: '项目.zip', size: 100, files: [{ name: '<img src=x>.png', path: 'files/0001.png', size: 42 }], notes: ['嵌套 ZIP 保留原件'],
  }]} />);
  expect(html).toContain('原包已保留');
  expect(html).toContain('&lt;img src=x&gt;.png');
  expect(html).toContain('嵌套 ZIP 保留原件');
  expect(html).not.toContain('<img');
});
