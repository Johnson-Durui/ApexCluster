// Navigation-type /api/ URLs that the fetch shim cannot see (README.md "Mock contract").
//
// 1. Links: an /api/ href is never written to an <a> either. The anchor keeps the path in data-demo-href and gets the
//    in-scope placeholder '#', so "Open link in new tab", "Save link as…", dragging the link or a long press can never
//    ask the host for /api/… (on GitHub Pages that is outside the project path and answers with a 404 page). As soon
//    as a context menu could open (pointer over the link, focus, pointer down, touch start, contextmenu, drag), the
//    href becomes a blob: URL of the router's answer, so those paths get the real file.
//    A capture-phase click (and middle-click) listener cancels the default navigation and sends the request through
//    the mock router instead. A 2xx answer is saved as a Blob download. A JSON answer is downloaded only for an export
//    path, or when the link carries a `download` attribute; any other JSON answer and every failure show a toast
//    through the demo pill.
// 2. <iframe src="/api/...">: the src is never written (setAttribute and the src setter are intercepted while the
//    element is still detached) and the router's text answer is shown through srcdoc.
// 3. <img src="/api/...">: the same interception; the image gets a blob: URL of the router's answer.
// A MutationObserver handles any /api/ src that still reaches the document another way.
// The product never needs to know: its markup is unchanged, only the requests are answered locally.

import { mockFetch, mockedUrl } from './router';

function toast(text: string): void {
  if (window.__mawbDemo) window.__mawbDemo.toast(text);
  else console.info('[demo]', text);
}

async function errorText(response: Response, fallback: string): Promise<string> {
  try {
    const data = JSON.parse(await response.text()) as { error?: unknown };
    if (typeof data.error === 'string' && data.error) return data.error;
  } catch { /* not JSON */ }
  return fallback;
}

/** Name from the RFC 6266 Content-Disposition header (filename* first), or null. */
function dispositionName(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)?'[^']*'([^;]+)/.exec(header);
  if (star) {
    try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch { /* fall through */ }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/.exec(header);
  if (plain) return (plain[2] ?? plain[1]).trim();
  return null;
}

function lastSegment(url: URL): string {
  const segment = url.pathname.split('/').filter(Boolean).at(-1) ?? 'download';
  try { return decodeURIComponent(segment); } catch { return segment; }
}

function isJson(response: Response): boolean {
  return /\bjson\b/i.test(response.headers.get('Content-Type') ?? '');
}

function save(blob: Blob, name: string): void {
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = name;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

async function download(anchor: HTMLAnchorElement, url: URL): Promise<void> {
  let response: Response;
  try {
    response = await mockFetch(url);
  } catch (error) {
    toast(`下载失败：${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!response.ok) {
    toast(await errorText(response, `下载失败（${response.status}）`));
    return;
  }
  const attribute = anchor.getAttribute('download');
  const exportPath = /\/export$/.test(url.pathname);
  if (isJson(response) && !exportPath && attribute === null) {
    toast('在线演示中，这个链接没有可下载的文件。');
    return;
  }
  const name = (attribute && attribute.trim()) || dispositionName(response.headers.get('Content-Disposition')) || lastSegment(url);
  const type = response.headers.get('Content-Type') ?? 'application/octet-stream';
  const blob = new Blob([await response.arrayBuffer()], { type });
  save(blob, name);
}

function onClick(event: MouseEvent): void {
  if (event.defaultPrevented) return;
  if (event.type === 'auxclick' && event.button !== 1) return;
  const target = event.target instanceof Element ? event.target : null;
  const anchor = target?.closest('a[href]');
  if (!(anchor instanceof HTMLAnchorElement)) return;
  const href = anchor.getAttribute('data-demo-href') ?? anchor.getAttribute('href') ?? '';
  if (!href.startsWith('/api/')) return;
  const url = mockedUrl(href);
  if (!url) return;
  event.preventDefault();
  void download(anchor, url);
}

// ---------------------------------------------------------------- link hrefs

/** The href an /api/ link carries until its blob: URL is ready (a same-page fragment: never a request). */
const LINK_PLACEHOLDER = '#';
/** How long a prepared blob: URL is reused before the router is asked again (a running run's export changes). */
const LINK_REUSE_MS = 30_000;
const anchorBlobs = new WeakMap<HTMLAnchorElement, { api: string; blob: string; at: number }>();
let writeAttribute: (element: Element, name: string, value: string) => void = (element, name, value) => element.setAttribute(name, value);

/** Records an /api/ link path without writing it as the href. */
function adoptLink(anchor: HTMLAnchorElement, api: string): void {
  writeAttribute(anchor, 'data-demo-href', api);
  const current = anchorBlobs.get(anchor);
  if (current && current.api !== api) {
    if (current.blob) URL.revokeObjectURL(current.blob);
    anchorBlobs.delete(anchor);
  }
  writeAttribute(anchor, 'href', anchorBlobs.get(anchor)?.blob || LINK_PLACEHOLDER);
}

/** Gives the link a blob: URL of the router's answer (an error answer becomes a short text file). */
async function prepareLink(anchor: HTMLAnchorElement): Promise<void> {
  const api = anchor.getAttribute('data-demo-href');
  if (!api) return;
  const current = anchorBlobs.get(anchor);
  if (current && current.api === api && Date.now() - current.at < LINK_REUSE_MS) return;
  anchorBlobs.set(anchor, { api, blob: current?.api === api ? current.blob : '', at: Date.now() });
  const url = mockedUrl(api);
  if (!url) return;
  let blob: Blob;
  try {
    const response = await mockFetch(url);
    blob = response.ok
      ? new Blob([await response.arrayBuffer()], { type: response.headers.get('Content-Type') ?? 'application/octet-stream' })
      : new Blob([await errorText(response, `下载失败（${response.status}）`)], { type: 'text/plain;charset=utf-8' });
  } catch (error) {
    blob = new Blob([`下载失败：${error instanceof Error ? error.message : String(error)}`], { type: 'text/plain;charset=utf-8' });
  }
  if (anchor.getAttribute('data-demo-href') !== api) return;
  const href = URL.createObjectURL(blob);
  const previous = anchorBlobs.get(anchor)?.blob;
  anchorBlobs.set(anchor, { api, blob: href, at: Date.now() });
  writeAttribute(anchor, 'href', href);
  if (previous && previous !== href) setTimeout(() => URL.revokeObjectURL(previous), 10_000);
}

function onLinkIntent(event: Event): void {
  const target = event.target instanceof Element ? event.target : null;
  const anchor = target?.closest('a[data-demo-href]');
  if (anchor instanceof HTMLAnchorElement) void prepareLink(anchor);
}

// ---------------------------------------------------------------- iframe and img

const frameSources = new WeakMap<HTMLIFrameElement, string>();
const imageSources = new WeakMap<HTMLImageElement, { api: string; blob: string }>();

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);

function noticeDocument(text: string): string {
  return `<!doctype html><meta charset="utf-8"><body style="margin:0;padding:16px;font:13px/1.6 'Segoe UI','Microsoft YaHei UI',system-ui,sans-serif;color:#475674;background:#fcfbf8">${escapeHtml(text)}</body>`;
}

async function rewriteFrame(frame: HTMLIFrameElement, src: string): Promise<void> {
  frameSources.set(frame, src);
  frame.removeAttribute('src');
  frame.srcdoc = noticeDocument('正在载入预览…');
  const url = mockedUrl(src);
  if (!url) return;
  let html: string;
  try {
    const response = await mockFetch(url);
    html = response.ok ? await response.text() : noticeDocument(await errorText(response, `预览载入失败（${response.status}）`));
  } catch (error) {
    html = noticeDocument(`预览载入失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (frameSources.get(frame) === src) frame.srcdoc = html;
}

async function rewriteImage(image: HTMLImageElement, src: string): Promise<void> {
  const previous = imageSources.get(image);
  if (previous?.api === src && image.getAttribute('src') === previous.blob) return;
  imageSources.set(image, { api: src, blob: '' });
  image.removeAttribute('src');
  const url = mockedUrl(src);
  if (!url) return;
  try {
    const response = await mockFetch(url);
    if (!response.ok) return;
    const blob = URL.createObjectURL(await response.blob());
    const current = imageSources.get(image);
    if (current?.api !== src) { URL.revokeObjectURL(blob); return; }
    if (previous?.blob) URL.revokeObjectURL(previous.blob);
    imageSources.set(image, { api: src, blob });
    image.src = blob;
  } catch { /* the image stays empty */ }
}

/** True when setting `src` on this element to `value` should be answered by the router instead of the network. */
function isApiSource(element: Element, name: string, value: unknown): element is HTMLIFrameElement | HTMLImageElement {
  return (element instanceof HTMLIFrameElement || element instanceof HTMLImageElement)
    && name.toLowerCase() === 'src'
    && typeof value === 'string'
    && value.startsWith('/api/');
}

/** True when setting `href` on this link to `value` would point it at /api/. */
function isApiLink(element: Element, name: string, value: unknown): element is HTMLAnchorElement {
  return element instanceof HTMLAnchorElement && name.toLowerCase() === 'href' && typeof value === 'string' && value.startsWith('/api/');
}

/**
 * Catches an /api/ src while it is being set, before the element is inserted into the document. React sets `src`
 * with setAttribute on the detached element, so without this the browser would already have sent the request (for an
 * <img> as soon as src is set, for an <iframe> on insertion) by the time the MutationObserver runs. The attribute is
 * never written; `data-demo-src` records the path for inspection, and the element is filled from the router.
 */
function interceptSourceSetters(): void {
  const setAttribute = Element.prototype.setAttribute;
  writeAttribute = (element, name, value) => setAttribute.call(element, name, value);
  Element.prototype.setAttribute = function (this: Element, name: string, value: string): void {
    if (isApiLink(this, name, value)) {
      adoptLink(this, value);
      return;
    }
    if (!isApiSource(this, name, value)) {
      setAttribute.call(this, name, value);
      return;
    }
    setAttribute.call(this, 'data-demo-src', value);
    if (this instanceof HTMLIFrameElement) void rewriteFrame(this, value);
    else void rewriteImage(this, value);
  };
  for (const prototype of [HTMLIFrameElement.prototype, HTMLImageElement.prototype]) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'src');
    if (!descriptor?.set || !descriptor.get) continue;
    const set = descriptor.set;
    Object.defineProperty(prototype, 'src', {
      ...descriptor,
      set(this: HTMLIFrameElement | HTMLImageElement, value: string) {
        if (isApiSource(this, 'src', value)) this.setAttribute('src', value);
        else set.call(this, value);
      },
    });
  }
  const hrefDescriptor = Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, 'href');
  if (hrefDescriptor?.set && hrefDescriptor.get) {
    const set = hrefDescriptor.set;
    Object.defineProperty(HTMLAnchorElement.prototype, 'href', {
      ...hrefDescriptor,
      set(this: HTMLAnchorElement, value: string) {
        if (isApiLink(this, 'href', value)) adoptLink(this, value);
        else set.call(this, value);
      },
    });
  }
}

function visit(element: Element): void {
  if (element instanceof HTMLAnchorElement) {
    const href = element.getAttribute('href');
    if (href?.startsWith('/api/')) adoptLink(element, href);
    return;
  }
  const src = element.getAttribute('src');
  if (!src || !src.startsWith('/api/')) return;
  if (element instanceof HTMLIFrameElement) void rewriteFrame(element, src);
  else if (element instanceof HTMLImageElement) void rewriteImage(element, src);
}

function scan(root: Element | Document): void {
  root.querySelectorAll('iframe[src^="/api/"], img[src^="/api/"], a[href^="/api/"]').forEach(visit);
}

let installed = false;

/** Installs the link interceptor and the iframe/img rewriter. Safe to call more than once. */
export function installNavigation(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('click', onClick, true);
  document.addEventListener('auxclick', onClick, true);
  for (const type of ['pointerover', 'focusin', 'pointerdown', 'touchstart', 'contextmenu', 'dragstart']) {
    document.addEventListener(type, onLinkIntent, { capture: true, passive: true });
  }
  interceptSourceSetters();
  // The observer stays as a fallback for markup that arrives without setAttribute (for example innerHTML).
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.target instanceof Element) visit(record.target);
        continue;
      }
      record.addedNodes.forEach(node => {
        if (!(node instanceof Element)) return;
        visit(node);
        scan(node);
      });
    }
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'href'] });
  scan(document);
}
