import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

// Read from disk: Vitest serves CSS imports as empty strings.
const css = readFileSync(new URL('./run-layout.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Bodies of every `@media <query>{…}` block (brace-matched). */
function media(query: string): string {
  const head = `@media ${query}{`;
  const bodies: string[] = [];
  for (let at = css.indexOf(head); at >= 0; at = css.indexOf(head, at + head.length)) {
    let depth = 1;
    let end = at + head.length;
    for (; end < css.length && depth; end++) depth += css[end] === '{' ? 1 : css[end] === '}' ? -1 : 0;
    bodies.push(css.slice(at + head.length, end - 1));
  }
  return bodies.join('\n');
}

describe('运行页标签条（窄窗口不截断）', () => {
  test('标签条横向溢出时保留可见的细滚动条（§3.7），不隐藏', () => {
    const strip = /\.run-tabs\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(strip).toMatch(/overflow-x:auto/);
    expect(strip).not.toMatch(/scrollbar-width:\s*none/);
    expect(strip).toMatch(/scrollbar-width:\s*thin/);
    expect(css).not.toMatch(/\.run-tabs::-webkit-scrollbar\{[^}]*display:\s*none/);
  });

  test('≤1099px 时工具按钮换到单独一行，标签占满整行；没有工具时不留空行', () => {
    const narrow = media('(max-width:1099px)');
    expect(narrow).toMatch(/\.run-toolbar\{[^}]*height:auto[^}]*flex-wrap:wrap/);
    expect(narrow).toMatch(/\.run-tabs\{[^}]*flex-basis:100%/);
    expect(narrow).toMatch(/\.run-tools\{[^}]*width:100%/);
    expect(narrow).toMatch(/\.run-tools:empty\{[^}]*display:none/);
  });
});
