import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownLite, parseMarkdownLite } from './markdownLite';

const render = (text: string) => renderToStaticMarkup(createElement(MarkdownLite, { text }));

describe('markdownLite', () => {
  it('never injects HTML: tags, attributes and entities stay text', () => {
    const html = render('<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n`<b>code</b>`');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('<code>&lt;b&gt;code&lt;/b&gt;</code>');
  });

  it('renders headings, bullet and ordered lists', () => {
    const html = render('# 结论\n\n### 细节\n- 功能一\n* 功能二\n\n1. 第一步\n2. 第二步');
    expect(html).toContain('<h3>结论</h3>');
    expect(html).toContain('<h4>细节</h4>');
    expect(html).toContain('<ul><li>功能一</li><li>功能二</li></ul>');
    expect(html).toContain('<ol><li>第一步</li><li>第二步</li></ol>');
  });

  it('keeps fenced code verbatim, including Markdown inside it', () => {
    const blocks = parseMarkdownLite('运行方式\n```bash\nnpm ci\n# not a heading\n- not a list\n```\n结束');
    expect(blocks).toEqual([
      { kind: 'paragraph', lines: ['运行方式'] },
      { kind: 'code', text: 'npm ci\n# not a heading\n- not a list' },
      { kind: 'paragraph', lines: ['结束'] },
    ]);
    expect(render('```\na < b\n```')).toBe('<pre><code>a &lt; b</code></pre>');
  });

  it('keeps paragraph line breaks and leaves unknown syntax as text', () => {
    const html = render('第一行\n第二行 **不加粗** [链接](http://x)');
    expect(html).toBe('<p>第一行<br/>第二行 **不加粗** [链接](http://x)</p>');
  });
});
