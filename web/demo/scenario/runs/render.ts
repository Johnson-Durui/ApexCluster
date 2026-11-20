// Small renderers for the run mock: a Markdown subset to HTML (for the document preview iframe and HTML downloads),
// a standalone light-styled HTML page, and a stored (uncompressed) zip writer for workspace downloads.
// The preview iframe is sandboxed by the product (sandbox=""), so the pages carry inline CSS and no scripts.

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());

/**
 * Converts the Markdown used in scenario/runs (headings, paragraphs, - and 1. lists, > quotes, | tables |, ``` fences)
 * to HTML. Anything else is shown as a paragraph.
 */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) { index += 1; continue; }
    if (line.startsWith('```')) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]!.startsWith('```')) body.push(lines[index++]!);
      index += 1;
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) { out.push(`<h${heading[1]!.length}>${inline(heading[2]!)}</h${heading[1]!.length}>`); index += 1; continue; }
    if (line.trim().startsWith('|') && lines[index + 1]?.trim().match(/^\|?\s*-{3,}/)) {
      const head = cells(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index]!.trim().startsWith('|')) rows.push(cells(lines[index++]!));
      out.push(`<table><thead><tr>${head.map(cell => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    const listMatch = /^(\s*)([-*]|\d+\.)\s+/.exec(line);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[2]!);
      const items: string[] = [];
      while (index < lines.length) {
        const item = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(lines[index]!);
        if (!item) break;
        items.push(`<li>${inline(item[1]!)}</li>`);
        index += 1;
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }
    if (line.startsWith('>')) {
      const quote: string[] = [];
      while (index < lines.length && lines[index]!.startsWith('>')) quote.push(lines[index++]!.replace(/^>\s?/, ''));
      out.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`);
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index]!.trim() && !/^(#{1,4}\s|```|>|\s*([-*]|\d+\.)\s|\|)/.test(lines[index]!)) paragraph.push(lines[index++]!);
    if (!paragraph.length) paragraph.push(lines[index++]!);
    out.push(`<p>${inline(paragraph.join(' '))}</p>`);
  }
  return out.join('\n');
}

/** A complete HTML document with light inline styles (warm paper background, slate ink, one indigo accent). */
export function standaloneHtml(title: string, meta: string, markdown: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
body{margin:0;background:#fbfaf6;color:#2c3443;font:14px/1.7 "Segoe UI","Microsoft YaHei UI","PingFang SC",system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:28px 32px 48px}
.meta{margin:0 0 20px;padding:8px 12px;border-left:3px solid #4f56c8;background:#f1f0fa;color:#4a5468;font-size:12px}
h1{font-size:22px;line-height:1.35;margin:0 0 12px;color:#1f2633}
h2{font-size:17px;margin:26px 0 8px;padding-bottom:4px;border-bottom:1px solid #e4e1d8}
h3{font-size:15px;margin:18px 0 6px}
table{border-collapse:collapse;width:100%;margin:10px 0;font-size:13px}
th,td{border:1px solid #e1ded4;padding:6px 9px;text-align:left;vertical-align:top}
th{background:#f3f1ea;font-weight:600}
code{font:12px/1.5 Consolas,"Cascadia Mono",monospace;background:#f1efe8;padding:1px 4px;border-radius:3px}
pre{background:#f4f2ec;border:1px solid #e4e1d8;border-radius:6px;padding:10px 12px;overflow:auto}
pre code{background:none;padding:0}
blockquote{margin:10px 0;padding:6px 12px;border-left:3px solid #c9c5b8;color:#566074}
ul,ol{padding-left:22px}
</style></head>
<body><main><p class="meta">${escapeHtml(meta)}</p>
${markdownToHtml(markdown)}
</main></body></html>`;
}

// ---------------------------------------------------------------- zip

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A zip archive with stored (method 0) entries and UTF-8 names. The DOS timestamp is fixed at 2026-11-14 00:00. */
export function zipStored(entries: { name: string; data: Uint8Array }[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const time = 0;
  const date = ((2026 - 1980) << 9) | (11 << 5) | 14;
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
    lv.setUint16(10, time, true); lv.setUint16(12, date, true); lv.setUint32(14, crc, true);
    lv.setUint32(18, entry.data.length, true); lv.setUint32(22, entry.data.length, true); lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true); cv.setUint16(14, date, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, entry.data.length, true); cv.setUint32(24, entry.data.length, true); cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, entry.data);
    centrals.push(central);
    offset += local.length + entry.data.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) { out.set(part, at); at += part.length; }
  return out;
}
