/**
 * 文档模型：PRD 与架构手册先组装成与格式无关的“块”，再渲染成 Markdown、网页片段或可打印的独立 HTML。
 * - 所有文字都在渲染时转义；块里不允许出现原始 HTML（SVG 例外：只来自 diagram.ts 的确定性生成）。
 * - 独立 HTML 不含脚本、不引用外部资源：浏览器“打印 → 另存为 PDF”即可发给老板和用户方。
 */

export type Tone = 'info' | 'warn' | 'danger';

export type Block =
  | { t: 'h'; level: 2 | 3 | 4; text: string }
  /** sources = undefined：程序生成的段落（不显示来源）；[]：模型段落但没有来源编号（显示“无来源”） */
  | { t: 'p'; text: string; sources?: string[]; label?: string }
  | { t: 'kv'; rows: [string, string][] }
  | { t: 'table'; head: string[]; rows: string[][]; note?: string }
  | { t: 'list'; items: string[]; ordered?: boolean }
  | { t: 'callout'; tone: Tone; text: string }
  | { t: 'diagram'; svg: string; mermaid: string; caption: string }
  | { t: 'checklist'; title: string; items: { ok: boolean; text: string; note: string }[] };

export interface DocModel {
  title: string;
  subtitle: string;
  banners: { tone: Tone; text: string }[];
  blocks: Block[];
  footer: string;
}

// ------------------------------------------------------------------ 工具
export function html(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function htmlMultiline(text: string): string {
  return html(text).replace(/\r?\n/g, '<br>');
}

function sourcesText(sources: string[]): string {
  return sources.length ? `来源：${sources.join('、')}` : '无来源编号，请核对';
}

// ------------------------------------------------------------------ Markdown
/**
 * 模型或用户写的文字：转义 Markdown 行内语法，并把换行变成 <br>。
 * 这样文字里的“## 6 ……”“**结论**：通过”之类不会在导出的 Markdown 里伪造章节或格式。
 */
function mdEscape(text: string): string {
  return text.replace(/([\\`*_[\]<>#|~])/g, '\\$1').replace(/\r?\n/g, '<br>');
}

/** 不转义（给 AI 读的开发文档）：保留原样，只处理会破坏表格的竖线和换行 */
function rawText(text: string): string {
  return text;
}
function rawCell(text: string): string {
  return text ? text.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>') : '—';
}

export function renderMarkdown(doc: DocModel, opts: { escape?: boolean } = {}): string {
  const raw = opts.escape === false;
  const md = raw ? rawText : mdEscape;
  const mdCell = (text: string) => (raw ? rawCell(text) : text ? mdEscape(text) : '—');
  const mdTable = (head: string[], rows: string[][]): string[] => {
    const out = [`| ${head.map(mdCell).join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`];
    for (const r of rows) out.push(`| ${head.map((_, i) => mdCell(r[i] ?? '')).join(' | ')} |`);
    return out;
  };
  const L: string[] = [`# ${md(doc.title)}`, '', `_${md(doc.subtitle)}_`, ''];
  for (const b of doc.banners) L.push(`> ${b.tone === 'info' ? 'ℹ️' : '⚠️'} **${md(b.text)}**`, '');
  for (const b of doc.blocks) {
    switch (b.t) {
      case 'h':
        L.push(`${'#'.repeat(b.level)} ${md(b.text)}`, '');
        break;
      case 'p': {
        const label = b.label ? `**${md(b.label)}**${b.text ? '：' : ''}` : '';
        const src = b.sources ? ` 〔${md(sourcesText(b.sources))}〕` : '';
        L.push(`${label}${md(b.text)}${src}`, '');
        break;
      }
      case 'kv':
        L.push(...mdTable(['项目', '内容'], b.rows.map(([k, v]) => [k, v])), '');
        break;
      case 'table':
        if (b.rows.length === 0) L.push('（无）', '');
        else L.push(...mdTable(b.head, b.rows), '');
        if (b.note) L.push(`_${md(b.note)}_`, '');
        break;
      case 'list':
        if (b.items.length === 0) L.push('- （无）');
        b.items.forEach((x, i) => L.push(`${b.ordered ? `${i + 1}.` : '-'} ${md(x)}`));
        L.push('');
        break;
      case 'callout':
        L.push(`> ${b.tone === 'info' ? 'ℹ️' : '⚠️'} ${md(b.text)}`, '');
        break;
      case 'diagram':
        L.push('```mermaid', b.mermaid.replace(/`/g, "'"), '```', '', `_${md(b.caption)}_`, '');
        break;
      case 'checklist':
        L.push(`**${md(b.title)}**`, '');
        for (const it of b.items) L.push(`- ${it.ok ? '☑' : '☐'} ${md(it.text)}${it.note ? `（${md(it.note)}）` : ''}`);
        L.push('');
        break;
    }
  }
  L.push('---', '', `_${md(doc.footer)}_`, '');
  return L.join('\n');
}

// ------------------------------------------------------------------ HTML
export const DOC_CSS = `
.dmw-doc{font-family:'Microsoft YaHei','PingFang SC','Noto Sans CJK SC',system-ui,sans-serif;color:#0f172a;line-height:1.7;font-size:14px;max-width:980px;margin:0 auto}
.dmw-doc h1{font-size:24px;margin:0 0 4px}
.dmw-doc .sub{color:#475569;margin:0 0 16px}
.dmw-doc h2{font-size:19px;border-bottom:2px solid #0f172a;padding-bottom:4px;margin:28px 0 12px;break-after:avoid}
.dmw-doc h3{font-size:16px;margin:20px 0 8px;break-after:avoid}
.dmw-doc h4{font-size:14px;margin:16px 0 6px;break-after:avoid}
.dmw-doc p{margin:6px 0 10px}
.dmw-doc .lbl{font-weight:600}
.dmw-doc .src{color:#64748b;font-size:12px;margin-left:6px;display:inline-block;max-width:100%;overflow-wrap:anywhere}
.dmw-doc .src.none{color:#b45309}
.dmw-doc table{border-collapse:collapse;width:100%;margin:8px 0 12px;font-size:13px}
.dmw-doc th,.dmw-doc td{border:1px solid #cbd5e1;padding:6px 8px;vertical-align:top;text-align:left;min-width:3.2em;overflow-wrap:anywhere}
.dmw-doc th{background:#f1f5f9;font-weight:600}
.dmw-doc tr{break-inside:avoid}
.dmw-doc table.kv th{width:22%;white-space:nowrap}
.dmw-doc .note{color:#64748b;font-size:12px;margin-top:-6px}
.dmw-doc .banner,.dmw-doc .callout{border-radius:6px;padding:8px 12px;margin:8px 0}
.dmw-doc .info{background:#eff6ff;border:1px solid #93c5fd}
.dmw-doc .warn{background:#fffbeb;border:1px solid #fcd34d}
.dmw-doc .danger{background:#fef2f2;border:1px solid #fca5a5}
.dmw-doc .banner{font-weight:600}
.dmw-doc figure{margin:10px 0 14px;break-inside:avoid;overflow-x:auto}
.dmw-doc figure svg{max-width:100%;height:auto}
.dmw-doc figcaption{color:#475569;font-size:12px}
.dmw-doc ul.check{list-style:none;padding-left:4px}
.dmw-doc ul.check li{margin:2px 0;break-inside:avoid}
.dmw-doc ul.check .ck-note{display:block;color:#64748b;font-size:12px;margin-left:1.6em;overflow-wrap:anywhere}
.dmw-doc ul.check .ck-note.none{color:#b45309}
.dmw-doc .ok{color:#15803d}
.dmw-doc .no{color:#b45309}
.dmw-doc footer{margin-top:28px;border-top:1px solid #cbd5e1;padding-top:8px;color:#64748b;font-size:12px;break-before:avoid}
`;

const PRINT_CSS = `
@page{size:A4;margin:16mm 14mm}
html,body{background:#fff;margin:0}
body{padding:24px}
@media print{body{padding:0}.dmw-doc{max-width:none}.dmw-doc a{color:inherit;text-decoration:none}}
`;

function htmlTable(head: string[], rows: string[][], cls = ''): string {
  const th = head.map((h) => `<th>${html(h)}</th>`).join('');
  const body = rows.map((r) => `<tr>${head.map((_, i) => `<td>${htmlMultiline(r[i] ?? '') || '—'}</td>`).join('')}</tr>`).join('');
  return `<table${cls ? ` class="${cls}"` : ''}><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}

export function renderHtmlFragment(doc: DocModel): string {
  const H: string[] = ['<article class="dmw-doc">', `<h1>${html(doc.title)}</h1>`, `<p class="sub">${html(doc.subtitle)}</p>`];
  for (const b of doc.banners) H.push(`<div class="banner ${b.tone}">${html(b.text)}</div>`);
  for (const b of doc.blocks) {
    switch (b.t) {
      case 'h':
        H.push(`<h${b.level}>${html(b.text)}</h${b.level}>`);
        break;
      case 'p': {
        const label = b.label ? `<span class="lbl">${html(b.label)}${b.text ? '：' : ''}</span>` : '';
        const src = b.sources ? `<span class="src${b.sources.length ? '' : ' none'}">〔${html(sourcesText(b.sources))}〕</span>` : '';
        H.push(`<p>${label}${htmlMultiline(b.text)}${src}</p>`);
        break;
      }
      case 'kv':
        H.push(`<table class="kv"><tbody>${b.rows.map(([k, v]) => `<tr><th>${html(k)}</th><td>${htmlMultiline(v) || '—'}</td></tr>`).join('')}</tbody></table>`);
        break;
      case 'table':
        H.push(b.rows.length ? htmlTable(b.head, b.rows) : '<p>（无）</p>');
        if (b.note) H.push(`<p class="note">${html(b.note)}</p>`);
        break;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        H.push(`<${tag}>${(b.items.length ? b.items : ['（无）']).map((x) => `<li>${htmlMultiline(x)}</li>`).join('')}</${tag}>`);
        break;
      }
      case 'callout':
        H.push(`<div class="callout ${b.tone}">${htmlMultiline(b.text)}</div>`);
        break;
      case 'diagram':
        H.push(`<figure>${b.svg}<figcaption>${html(b.caption)}</figcaption></figure>`);
        break;
      case 'checklist':
        H.push(`<p class="lbl">${html(b.title)}</p><ul class="check">${b.items
          .map((it) => `<li><span class="${it.ok ? 'ok' : 'no'}">${it.ok ? '☑' : '☐'}</span> ${html(it.text)}${it.note ? `<span class="ck-note${it.ok ? '' : ' none'}">（${html(it.note)}）</span>` : ''}</li>`)
          .join('')}</ul>`);
        break;
    }
  }
  H.push(`<footer>${html(doc.footer)}</footer>`, '</article>');
  return H.join('\n');
}

/** 独立 HTML：内联样式和 SVG，无脚本、无外部资源 */
export function renderStandaloneHtml(doc: DocModel): string {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${html(doc.title)}</title>`,
    `<style>${PRINT_CSS}${DOC_CSS}</style>`,
    '</head>',
    '<body>',
    renderHtmlFragment(doc),
    '</body>',
    '</html>',
  ].join('\n');
}

/** 文档预览与下载用的 CSP：禁止脚本与一切外部请求 */
export const DOC_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";
