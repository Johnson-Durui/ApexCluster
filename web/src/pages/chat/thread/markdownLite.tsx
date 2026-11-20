// A safe Markdown subset for final answers (BUILD-SPEC-B §4.3.5). No innerHTML: every piece is a React text node.
// Supported: # / ## / ### headings, -/* and 1. lists, fenced code, inline code and paragraphs. Everything else is text.
import { Fragment, type ReactNode } from 'react';

export type MarkdownBlock =
  | { kind: 'heading'; level: 3 | 4; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'code'; text: string }
  | { kind: 'paragraph'; lines: string[] };

const HEADING = /^(#{1,3})\s+(.+?)\s*#*\s*$/;
const BULLET = /^\s{0,3}[-*]\s+(.*)$/;
const ORDERED = /^\s{0,3}\d{1,3}[.)]\s+(.*)$/;
const FENCE = /^\s{0,3}(```|~~~)/;

/** Splits text into blocks. Pure, so tests can check the structure without rendering. */
export function parseMarkdownLite(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', lines: paragraph });
    if (list) blocks.push({ kind: 'list', ...list });
    paragraph = [];
    list = null;
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      index++;
      while (index < lines.length && !lines[index].trimStart().startsWith(fence[1])) body.push(lines[index++]);
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', level: heading[1].length === 3 ? 4 : 3, text: heading[2] });
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    const item = bullet ?? ordered;
    if (item) {
      const isOrdered = Boolean(ordered);
      if (paragraph.length) { blocks.push({ kind: 'paragraph', lines: paragraph }); paragraph = []; }
      if (list && list.ordered !== isOrdered) { blocks.push({ kind: 'list', ...list }); list = null; }
      list ??= { ordered: isOrdered, items: [] };
      list.items.push(item[1]);
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += `\n${line.trim()}`; continue; }
    if (list) { blocks.push({ kind: 'list', ...list }); list = null; }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

/** Inline code spans (`code`); the rest stays plain text. */
export function inlineNodes(text: string): ReactNode[] {
  const parts = text.split(/(`[^`\n]+`)/g);
  return parts.filter(Boolean).map((part, index) => part.length > 2 && part.startsWith('`') && part.endsWith('`')
    ? <code key={index}>{part.slice(1, -1)}</code>
    : <Fragment key={index}>{part}</Fragment>);
}

function lineNodes(lines: string[]): ReactNode[] {
  return lines.flatMap((line, index): ReactNode[] => index ? [<br key={`br-${index}`} />, ...inlineNodes(line).map((node, inner) => <Fragment key={`${index}-${inner}`}>{node}</Fragment>)] : inlineNodes(line));
}

export function MarkdownLite({ text }: { text: string }) {
  const blocks = parseMarkdownLite(text);
  return <>{blocks.map((block, index) => {
    if (block.kind === 'heading') return block.level === 3 ? <h3 key={index}>{inlineNodes(block.text)}</h3> : <h4 key={index}>{inlineNodes(block.text)}</h4>;
    if (block.kind === 'code') return <pre key={index}><code>{block.text}</code></pre>;
    if (block.kind === 'list') {
      const items = block.items.map((item, inner) => <li key={inner}>{lineNodes(item.split('\n'))}</li>);
      return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
    }
    return <p key={index}>{lineNodes(block.lines)}</p>;
  })}</>;
}
