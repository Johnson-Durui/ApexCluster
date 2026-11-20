// Verifier for the built online demo (web/demo/README.md "Verification"). The built-in step list is the full tour in
// ./tour.mjs.
//
// Usage (from the repository root, after `npm --prefix web run build:demo`):
//   node web/demo/scripts/verify-demo.mjs <outDir> [--dist <dir>] [--steps <steps.json>] [--only <name,name>] [--url <base>]
//   node web/demo/scripts/verify-demo.mjs <outDir> --scan-only [--dist <dir>]     (step 1 only: no browser; used by CI)
//
//   <outDir>        where the PNG per step, downloads/ and summary.json are written (created if missing). Paths in
//                   summary.json are relative (to the repository or to <outDir>). Keep <outDir> outside the published
//                   tree anyway: only PNGs may be copied from it into docs/, never summary.json or downloads/.
//   --dist <dir>    the built demo to check (default: web/dist-demo next to this script)
//   --steps <file>  a JSON array of steps that replaces the built-in tour (STEPS in ./tour.mjs)
//   --only <names>  run only the steps with these names (comma separated)
//   --url <base>    drive an already running server instead (e.g. http://127.0.0.1:5180/ for npm run dev:demo);
//                   the base must end with '/'. The dist scan still runs on --dist.
//   --private-words <file>  extra private literals to scan for, one per line ('#' starts a comment). Keep this file
//                   outside the published tree (and outside the repository's tracked files).
//   --scan-only     run only the dist scan, write summary.json and exit 1 on any hit (no server, no browser)
// Environment:
//   CDP_PORT          DevTools port for headless Edge (default 9611)
//   EDGE_PATH         browser executable (default: Microsoft Edge in Program Files (x86))
//   EDGE_PROFILE_DIR  --user-data-dir for the browser (default: <os tmp>/mawb-demo-edge-<CDP_PORT>)
//
// What it does:
// 1. Scans every file under the dist directory (and every entry inside .zip files) for the forbidden strings of the
//    hard rules (README.md "Hard rules") and for private paths and e-mail hosts; fails on any hit, and when a
//    fixed-demo/ directory exists in the output. A private match is reported by its pattern name; the matched
//    text itself is masked in the reported context.
// 2. Serves the dist directory under /ApexCluster/ with a small node:http static server on a free port.
//    Any other path, /api/ included, gets 404 (the demo must never reach a backend).
// 3. Drives headless Edge over the DevTools protocol through STEPS. Per step it collects console errors and
//    uncaught exceptions, '[demo] unmocked' warnings, failed requests (status >= 400, or a network failure, for
//    non-/api/ URLs), requests that reached the network for /api/ URLs (reported, not failed), the PageBoundary
//    text 页面需要重新加载, forbidden strings in document.body.innerText and document.title, text that a step
//    expects but is missing, and whether #root has mounted. It saves a PNG per step.
// 4. Prints a JSON summary (also written to <outDir>/summary.json) and exits 1 on any problem.
//
// 5. Per step it also checks that the demo pill overlaps none of the protected product controls (composer, send and
//    stop buttons, gate cards, question cards, map controls, status cells) and stays inside the viewport, and records
//    every phrase about model calls in the page text (MODEL_WORDING) so a reviewer can read them; the phrases in
//    MODEL_CLAIMS (a claim that a model call happened) fail the step.
//
// Step fields (all optional except name):
//   name       file-safe name, used for the PNG
//   route      the hash route, e.g. '/', '/history', '/?new=1&demo=play'. When present the page is (re)loaded.
//   path       a page under the served base instead of the app, e.g. 'demo-project/index.html' (also reloads)
//   query      location.search without '?', e.g. 'shots=1&speed=4' (only used together with route or path)
//   width, height   viewport (default 1280 x 720)
//   mobile     true: emulate a phone or tablet browser (mobile viewport rules, touch, deviceScaleFactor default 2)
//   deviceScaleFactor  device pixel ratio (default 1, or 2 with mobile)
//   Every step also fails when the page's layout viewport (innerWidth) is not the emulated width.
//   wait       ms to wait after load / before the checks (default 1800)
//   waitFor    CSS selector to wait for (up to timeout ms, default 10000) before click/eval
//   click      CSS selector to click (after waitFor)
//   eval       body of an async function evaluated in the page (after click); its return value is reported, and an
//              exception it throws is a step error (the screenshot is still taken)
//   after      ms to wait after click/eval (default 800)
//   expectText array of strings that must appear in document.body.innerText
//   expectDownloads  array of { name: string | RegExp, sameAs?: path relative to web/demo }: files that must land in
//              <outDir>/downloads during the step (and, with sameAs, have exactly the bytes of that source file)
//   mountSelector  selector that proves the page mounted (default: #root with children)
//   allowConsole  array of substrings; console errors containing one of them are reported but do not fail
//   crop       { x, y, width, height, scale? } also saves <name>-crop.png of that viewport region (scale default 2)
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { STEPS } from './tour.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEMO_ROOT = path.resolve(here, '..');
const BASE_PATH = '/ApexCluster/';

/** Phrases about model calls that are recorded per step for review. */
const MODEL_WORDING = /真实调用|已调用模型|调用了模型|调用模型|模型调用|消耗模型额度|消耗额度|真实探测/g;
/** Phrases that claim a model call happened; any of them in the page text fails the step. */
const MODEL_CLAIMS = ['已调用模型', '调用了模型', '已真实调用'];
/** Product controls the demo pill must never cover. */
const PROTECTED = ['form.chat-compose', '.compose-foot', '.compose-send', '.compose-stop', '.gate-wrap', '[data-gate-confirm]', '.chat-question', '.map-head-tools', '.map-camera', '.map-icon', '.app-status .sb-cell', '.workspace-open'];

/** Strings from the product's built-in fixed-demo path that must never leak into the static online demo build. */
const FORBIDDEN = ['fixed-demo-roomdesk-', 'roomdesk-v1', '/fixed-demo/'];
/**
 * Private data patterns. This file is published with the demo, so it names no real person, path or machine: the
 * current OS user name is added at run time, but only as a home-directory path (C:\Users\<name>, /home/<name>,
 * /Users/<name>), because a bare user name such as runner, root or node also occurs in ordinary code. Further literals
 * (for example a private drive folder or the bare user name) come from a local, unpublished file passed with
 * --private-words.
 */
const PRIVATE = [
  { name: 'windows user path', regex: /\b[A-Za-z]:(?:\\{1,2}|\/)+Users(?:\\{1,2}|\/)/i },
  { name: '@outlook', regex: /@outlook\b/i },
  { name: '@gmail', regex: /@gmail\b/i },
];

/** A case-insensitive regex for a private literal; '\' and '/' in it also match '\\' and the other separator. */
function literalPattern(word) {
  const source = word.split(/[\\/]+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(?:\\\\{1,2}|/)+');
  return { name: 'private word from --private-words', regex: new RegExp(source, 'i') };
}

/** The OS user name as a home-directory path component (any separator, any case). */
function homePathPattern(user) {
  const escaped = user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { name: 'OS user home path', regex: new RegExp(`(?:^|[^A-Za-z0-9_])(?:Users|home)(?:\\\\{1,2}|/)+${escaped}(?![A-Za-z0-9._-])`, 'i') };
}

function addPrivateWords(file) {
  const words = file ? readFileSync(file, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')) : [];
  for (const word of new Set(words)) PRIVATE.push(literalPattern(word));
  let user = '';
  try { user = os.userInfo().username; } catch { /* no user info */ }
  if (user) PRIVATE.push(homePathPattern(user));
  return words.length;
}
const BOUNDARY_TEXT = '页面需要重新加载';

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const options = { outDir: '', dist: path.resolve(here, '../../dist-demo'), steps: null, only: null, url: null, privateWords: '', scanOnly: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--dist') options.dist = path.resolve(argv[++index] ?? '');
    else if (arg === '--private-words') options.privateWords = path.resolve(argv[++index] ?? '');
    else if (arg === '--steps') options.steps = JSON.parse(readFileSync(path.resolve(argv[++index] ?? ''), 'utf8'));
    else if (arg === '--url') options.url = new URL(argv[++index] ?? '');
    else if (arg === '--only') options.only = new Set(String(argv[++index] ?? '').split(',').filter(Boolean));
    else if (arg === '--scan-only') options.scanOnly = true;
    else if (!options.outDir) options.outDir = path.resolve(arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.outDir) throw new Error('usage: node web/demo/scripts/verify-demo.mjs <outDir> [--dist <dir>] [--steps <file>] [--only <names>] [--url <base>] [--private-words <file>] [--scan-only]');
  return options;
}

// ---------------------------------------------------------------- 1. static scan

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

function escapedForms(text) {
  if (/^[\x00-\x7f]*$/.test(text)) return [];
  const upper = [...text].map(char => char.charCodeAt(0) > 0x7f ? `\\u${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}` : char).join('');
  return [upper, upper.toLowerCase()];
}

/** A reported context with every private match masked (summary.json and the console must not repeat private text).
 * The rest of the token after a masked part (for example the folders after a user-home prefix) is masked too. */
function maskPrivate(text) {
  let out = text;
  for (const pattern of PRIVATE) out = out.replace(new RegExp(pattern.regex.source, pattern.regex.flags.replace('g', '') + 'g'), '[private]');
  return out.replace(/\[private\][^\s"'`]*/g, '[private]');
}

/** Hits of forbidden strings and private patterns in one buffer. */
function scanBuffer(buffer) {
  const hits = [];
  for (const word of FORBIDDEN) {
    for (const form of [word, ...escapedForms(word)]) {
      const at = buffer.indexOf(Buffer.from(form, 'utf8'));
      if (at >= 0) hits.push({ match: form, at, context: maskPrivate(buffer.subarray(Math.max(0, at - 40), at + form.length + 40).toString('utf8')) });
    }
  }
  // Each private pattern runs on one decoding at a time; the context is cut from the decoding that matched.
  const decoded = [buffer.toString('utf8'), buffer.toString('latin1')];
  for (const pattern of PRIVATE) {
    for (const source of decoded) {
      const found = pattern.regex.exec(source);
      if (!found) continue;
      const end = found.index + found[0].length;
      hits.push({ match: pattern.name, at: found.index, context: maskPrivate(`${source.slice(Math.max(0, found.index - 40), found.index)}[private]${source.slice(end, end + 40)}`) });
      break;
    }
  }
  return hits;
}

/** Entries of a zip archive (stored or deflated), read through the central directory. */
function zipEntries(buffer) {
  const entries = [];
  let end = -1;
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 65557); at--) {
    if (buffer.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) throw new Error('zip end-of-central-directory record not found');
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('bad zip central directory entry');
    const method = buffer.readUInt16LE(at + 10);
    const compressed = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const localNameLength = buffer.readUInt16LE(local + 26);
    const localExtraLength = buffer.readUInt16LE(local + 28);
    const start = local + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(start, start + compressed);
    let data = null;
    if (method === 0) data = raw;
    else if (method === 8) data = inflateRawSync(raw);
    entries.push({ name, method, data });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function scanDist(dist) {
  const problems = [];
  let files = 0;
  if (!existsSync(dist) || !statSync(dist).isDirectory()) return { files, problems: [{ file: dist, match: 'dist directory missing' }] };
  if (existsSync(path.join(dist, 'fixed-demo'))) problems.push({ file: 'fixed-demo/', match: 'fixed-demo directory in the output' });
  for (const file of walk(dist)) {
    files += 1;
    const relative = path.relative(dist, file).split(path.sep).join('/');
    for (const hit of scanBuffer(Buffer.from(relative, 'utf8'))) problems.push({ file: relative, where: 'file name', ...hit });
    const buffer = readFileSync(file);
    for (const hit of scanBuffer(buffer)) problems.push({ file: relative, ...hit });
    if (/\.zip$/i.test(file)) {
      try {
        for (const entry of zipEntries(buffer)) {
          for (const hit of scanBuffer(Buffer.from(entry.name, 'utf8'))) problems.push({ file: `${relative}!${entry.name}`, where: 'zip entry name', ...hit });
          if (entry.data === null) { problems.push({ file: `${relative}!${entry.name}`, match: `unsupported zip method ${entry.method}` }); continue; }
          for (const hit of scanBuffer(entry.data)) problems.push({ file: `${relative}!${entry.name}`, ...hit });
        }
      } catch (error) {
        problems.push({ file: relative, match: `zip not readable: ${error.message}` });
      }
    }
  }
  return { files, problems };
}

// ---------------------------------------------------------------- 2. static server

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.png': 'image/png', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.zip': 'application/zip', '.woff2': 'font/woff2',
};

function serve(dist) {
  const root = path.resolve(dist);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === BASE_PATH.slice(0, -1)) { response.writeHead(301, { Location: BASE_PATH }); response.end(); return; }
    if (!url.pathname.startsWith(BASE_PATH)) { response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('not found'); return; }
    let relative;
    try { relative = decodeURIComponent(url.pathname.slice(BASE_PATH.length)); } catch { response.writeHead(400); response.end(); return; }
    let file = path.resolve(root, relative);
    if (file !== root && !file.startsWith(root + path.sep)) { response.writeHead(403); response.end(); return; }
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!existsSync(file) || !statSync(file).isFile()) { response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('not found'); return; }
    response.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(readFileSync(file));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---------------------------------------------------------------- 3. browser

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function browserPath() {
  const candidates = [
    process.env.EDGE_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const found = candidates.find(candidate => existsSync(candidate));
  if (!found) throw new Error('no Edge or Chromium executable found; set EDGE_PATH');
  return found;
}

async function devtoolsTarget(port) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = pages.find(item => item.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* the browser is starting */ }
    await sleep(200);
  }
  throw new Error(`no DevTools page target on port ${port}`);
}

function connect(url) {
  const socket = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
      else resolve(message.result ?? {});
      return;
    }
    if (message.method) for (const listener of listeners) listener(message.method, message.params ?? {});
  });
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('DevTools socket error')), { once: true });
  });
  return {
    opened,
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const key = ++id;
        pending.set(key, { resolve, reject });
        socket.send(JSON.stringify({ id: key, method, params }));
      });
    },
    on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() { socket.close(); },
  };
}

function consoleText(params) {
  return (params.args ?? []).map(arg => arg.value !== undefined ? (typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value)) : arg.description ?? arg.type).join(' ');
}

function isApiUrl(raw) {
  try { return new URL(raw).pathname.startsWith('/api/'); } catch { return false; }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result?.value;
}

/** Where the demo pill is and which protected controls it covers (empty when there is no pill). */
const PILL_CHECK = `(() => {
  const pill = document.querySelector('.mawb-demo-pill');
  if (!pill) return { present: false, overlaps: [] };
  const box = pill.getBoundingClientRect();
  if (!box.width || !box.height) return { present: false, overlaps: [] };
  const overlaps = [];
  if (box.left < 0 || box.top < 0 || box.right > innerWidth + 0.5 || box.bottom > innerHeight + 0.5) overlaps.push('outside the viewport');
  for (const selector of ${JSON.stringify(PROTECTED)}) {
    for (const node of document.querySelectorAll(selector)) {
      if (pill.contains(node)) continue;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const other = node.getBoundingClientRect();
      const width = Math.min(box.right, other.right) - Math.max(box.left, other.left);
      const height = Math.min(box.bottom, other.bottom) - Math.max(box.top, other.top);
      if (width > 0.5 && height > 0.5) overlaps.push(selector + ' (' + Math.round(width) + 'x' + Math.round(height) + ' px, "' + (node.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 30) + '")');
    }
  }
  return { present: true, rect: [box.left, box.top, box.width, box.height].map(Math.round), text: pill.innerText.replace(/\\s+/g, ' ').trim().slice(0, 140), overlaps };
})()`;

/** Waits until a downloaded file matching `name` exists in `dir` (not a partial download). */
async function waitForDownload(dir, name, timeout = 10000) {
  const matches = file => (name instanceof RegExp ? name.test(file) : file === name);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = readdirSync(dir).find(file => matches(file) && !/\.crdownload$|\.tmp$/i.test(file));
    if (found) return found;
    await sleep(200);
  }
  return null;
}

async function waitForSelector(cdp, selector, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, `Boolean(document.querySelector(${JSON.stringify(selector)}))`)) return true;
    await sleep(150);
  }
  return false;
}

const REPO_ROOT = path.resolve(DEMO_ROOT, '../..');

/** A path for summary.json: relative to the repository (forward slashes), never an absolute path with a user name. */
function reportPath(target) {
  const relative = path.relative(REPO_ROOT, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return `<outside the repository>/${path.basename(target)}`;
  return relative.split(path.sep).join('/');
}

/** Error text for summary.json with the repository and home paths replaced. */
function scrub(text) {
  let out = String(text);
  for (const [from, to] of [[REPO_ROOT, '<repo>'], [os.homedir(), '~']]) {
    if (!from) continue;
    for (const form of new Set([from, from.split(path.sep).join('/'), from.split('/').join('\\')])) out = out.split(form).join(to);
  }
  return out;
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const outRelative = path.relative(REPO_ROOT, options.outDir);
  if (!outRelative.startsWith('..') && !path.isAbsolute(outRelative) && !/^work(?:[\\/]|$)/.test(outRelative)) {
    console.warn(`[verify] ${outRelative.split(path.sep).join('/')} is inside the repository: copy only PNGs from it, never summary.json or downloads/.`);
  }
  mkdirSync(options.outDir, { recursive: true });
  const summary = { ok: false, dist: reportPath(options.dist), scan: null, server: '', steps: [], stray: { consoleErrors: [], unmocked: [], warnings: [], failedRequests: [], apiLeaks: [], downloads: [] } };

  // Only the count is recorded: summary.json must not repeat the private words themselves.
  summary.privateWords = addPrivateWords(options.privateWords);
  summary.scan = scanDist(options.dist);
  if (options.scanOnly) {
    summary.ok = summary.scan.problems.length === 0;
    summary.counts = { scannedFiles: summary.scan.files, scanProblems: summary.scan.problems.length };
    writeFileSync(path.join(options.outDir, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(`dist scan: ${summary.scan.files} files, ${summary.scan.problems.length} problems`);
    for (const problem of summary.scan.problems) console.log(`FAIL ${problem.file}${problem.where ? ` (${problem.where})` : ''}: ${problem.match}`);
    process.exitCode = summary.ok ? 0 : 1;
    return;
  }
  const downloads = path.join(options.outDir, 'downloads');
  rmSync(downloads, { recursive: true, force: true });
  mkdirSync(downloads, { recursive: true });

  const server = options.url ? null : await serve(options.dist);
  const base = options.url ? options.url.href : `http://127.0.0.1:${server.address().port}${BASE_PATH}`;
  summary.server = base;

  const port = Number(process.env.CDP_PORT ?? 9611);
  const profile = process.env.EDGE_PROFILE_DIR ? path.resolve(process.env.EDGE_PROFILE_DIR) : path.join(os.tmpdir(), `mawb-demo-edge-${port}`);
  const browser = spawn(browserPath(), [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--disable-extensions',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--mute-audio',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank',
  ], { stdio: 'ignore' });
  let cdp = null;
  try {
    cdp = connect(await devtoolsTarget(port));
    await cdp.opened;
    let current = null;
    const requests = new Map();
    cdp.on((method, params) => {
      // Events that arrive between steps are kept in summary.stray and fail the run like step events.
      const bucket = current ?? summary.stray;
      if (method === 'Runtime.consoleAPICalled') {
        const text = consoleText(params);
        if (params.type === 'error' || params.type === 'assert') bucket.consoleErrors.push(text);
        else if (params.type === 'warning' && text.startsWith('[demo] unmocked')) bucket.unmocked.push(text);
        else if (params.type === 'warning') bucket.warnings.push(text);
      } else if (method === 'Runtime.exceptionThrown') {
        const details = params.exceptionDetails ?? {};
        bucket.consoleErrors.push(`uncaught: ${details.exception?.description ?? details.text ?? 'exception'}`);
      } else if (method === 'Log.entryAdded') {
        const entry = params.entry ?? {};
        if (entry.level === 'error' && entry.source !== 'network') bucket.consoleErrors.push(`${entry.source}: ${entry.text}`);
      } else if (method === 'Network.requestWillBeSent') {
        requests.set(params.requestId, params.request?.url ?? '');
        if (isApiUrl(params.request?.url ?? '')) bucket.apiLeaks.push(`${params.request.method} ${params.request.url}`);
      } else if (method === 'Network.responseReceived') {
        const url = params.response?.url ?? requests.get(params.requestId) ?? '';
        const status = params.response?.status ?? 0;
        if (status >= 400 && !isApiUrl(url) && !/^(blob|data):/.test(url)) bucket.failedRequests.push(`${status} ${url}`);
      } else if (method === 'Network.loadingFailed') {
        const url = requests.get(params.requestId) ?? '';
        if (!params.canceled && !isApiUrl(url) && !/^(blob|data):/.test(url)) bucket.failedRequests.push(`${params.errorText} ${url}`);
      } else if (method === 'Browser.downloadWillBegin') {
        bucket.downloads.push(params.suggestedFilename);
      }
    });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    try { await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true }); } catch { /* older browsers */ }

    const steps = (options.steps ?? STEPS).filter(step => !options.only || options.only.has(step.name));
    let index = 0;
    for (const step of steps) {
      index += 1;
      const record = { name: step.name, url: '', viewport: `${step.width ?? 1280}x${step.height ?? 720}${step.mobile ? ' mobile' : ''}`, layoutViewport: '', ms: 0, consoleErrors: [], allowedConsole: [], unmocked: [], warnings: [], failedRequests: [], apiLeaks: [], downloads: [], downloadProblems: [], boundary: false, forbiddenInDom: [], missingText: [], modelWording: [], modelClaims: [], pill: null, mounted: false, waitForMissing: false, evalResult: undefined, error: '', screenshot: '' };
      const started = Date.now();
      current = record;
      try {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: step.width ?? 1280, height: step.height ?? 720, deviceScaleFactor: step.deviceScaleFactor ?? (step.mobile ? 2 : 1), mobile: Boolean(step.mobile) });
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: Boolean(step.mobile), ...(step.mobile ? { maxTouchPoints: 5 } : {}) });
        if (step.route != null || step.path != null) {
          const search = step.query ? `?${step.query}` : '';
          record.url = step.path != null ? `${base}${step.path}${search}` : `${base}${search}#${step.route}`;
          await cdp.send('Page.navigate', { url: 'about:blank' });
          await sleep(150);
          let stopListening = () => {};
          const loaded = new Promise(resolve => {
            const timer = setTimeout(resolve, 15000);
            stopListening = cdp.on(method => { if (method === 'Page.loadEventFired') { clearTimeout(timer); resolve(); } });
          });
          await cdp.send('Page.navigate', { url: record.url });
          await loaded;
          stopListening();
        } else {
          record.url = await evaluate(cdp, 'location.href');
        }
        await sleep(step.wait ?? 1800);
        if (step.waitFor) record.waitForMissing = !(await waitForSelector(cdp, step.waitFor, step.timeout ?? 10000));
        if (step.click) {
          const clicked = await evaluate(cdp, `(() => { const node = document.querySelector(${JSON.stringify(step.click)}); if (!node) return false; node.click(); return true; })()`);
          if (!clicked) record.error = `click target not found: ${step.click}`;
        }
        if (step.eval) {
          try {
            record.evalResult = await evaluate(cdp, `(async () => { ${step.eval} })()`);
          } catch (error) {
            record.error = `eval: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
          }
        }
        if (step.click || step.eval) await sleep(step.after ?? 800);
        const mountCheck = step.mountSelector
          ? `Boolean(document.querySelector(${JSON.stringify(step.mountSelector)}))`
          : `Boolean(document.querySelector('#root') && document.querySelector('#root').childElementCount > 0)`;
        const page = await evaluate(cdp, `({ text: document.body ? document.body.innerText : '', title: document.title, mounted: ${mountCheck}, innerWidth, innerHeight })`);
        record.mounted = page.mounted;
        record.layoutViewport = `${page.innerWidth}x${page.innerHeight}`;
        record.boundary = page.text.includes(BOUNDARY_TEXT);
        for (const word of FORBIDDEN) if (page.text.includes(word) || page.title.includes(word)) record.forbiddenInDom.push(word);
        for (const pattern of PRIVATE) if (pattern.regex.test(page.text)) record.forbiddenInDom.push(pattern.name);
        for (const text of step.expectText ?? []) if (!page.text.includes(text)) record.missingText.push(text);
        const wording = new Set();
        for (const match of page.text.matchAll(MODEL_WORDING)) {
          const line = page.text.slice(Math.max(0, page.text.lastIndexOf('\n', match.index) + 1), match.index + match[0].length + 40).split('\n')[0];
          wording.add(line.replace(/\s+/g, ' ').trim().slice(0, 90));
        }
        record.modelWording = [...wording];
        record.modelClaims = MODEL_CLAIMS.filter(word => page.text.includes(word));
        record.pill = await evaluate(cdp, PILL_CHECK);
        for (const expected of step.expectDownloads ?? []) {
          const found = await waitForDownload(downloads, expected.name);
          if (!found) { record.downloadProblems.push(`download missing: ${expected.name}`); continue; }
          if (expected.sameAs) {
            const source = path.join(DEMO_ROOT, expected.sameAs);
            if (!readFileSync(path.join(downloads, found)).equals(readFileSync(source))) record.downloadProblems.push(`download ${found} differs from ${expected.sameAs}`);
          }
        }
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        record.screenshot = `${String(index).padStart(2, '0')}-${step.name}.png`;
        writeFileSync(path.join(options.outDir, record.screenshot), Buffer.from(shot.data, 'base64'));
        if (step.crop) {
          const { x, y, width, height, scale = 2 } = step.crop;
          const zoomed = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x, y, width, height, scale } });
          writeFileSync(path.join(options.outDir, `${String(index).padStart(2, '0')}-${step.name}-crop.png`), Buffer.from(zoomed.data, 'base64'));
        }
      } catch (error) {
        record.error = [record.error, error instanceof Error ? error.message : String(error)].filter(Boolean).join('; ');
      }
      record.ms = Date.now() - started;
      record.error = scrub(record.error);
      const allow = step.allowConsole ?? [];
      record.allowedConsole = record.consoleErrors.filter(text => allow.some(part => text.includes(part)));
      record.consoleErrors = record.consoleErrors.filter(text => !allow.some(part => text.includes(part)));
      record.problems = [
        ...record.consoleErrors.map(text => `console error: ${text}`),
        ...record.unmocked.map(text => `unmocked: ${text}`),
        ...record.failedRequests.map(text => `failed request: ${text}`),
        ...(record.boundary ? [`page boundary: ${BOUNDARY_TEXT}`] : []),
        ...record.forbiddenInDom.map(text => `forbidden in DOM: ${text}`),
        ...record.missingText.map(text => `missing text: ${text}`),
        ...record.downloadProblems,
        ...record.modelClaims.map(text => `model-call claim in DOM: ${text}`),
        ...(record.pill?.overlaps ?? []).map(text => `pill overlaps ${text}`),
        ...(record.layoutViewport && record.layoutViewport.split('x')[0] !== String(step.width ?? 1280) ? [`layout viewport is ${record.layoutViewport}, expected width ${step.width ?? 1280}`] : []),
        ...(record.mounted ? [] : [`page did not mount (${step.mountSelector ?? '#root is empty'})`]),
        ...(record.waitForMissing ? [`waitFor selector not found: ${step.waitFor}`] : []),
        ...(record.error ? [`step error: ${record.error}`] : []),
      ];
      summary.steps.push(record);
      current = null;
    }
  } finally {
    try { await cdp?.send('Browser.close'); } catch { /* already gone */ }
    cdp?.close();
    browser.kill();
    server?.close();
  }

  const scanProblems = summary.scan.problems.length;
  const stepProblems = summary.steps.reduce((total, step) => total + step.problems.length, 0);
  const strayProblems = summary.stray.consoleErrors.length + summary.stray.unmocked.length + summary.stray.failedRequests.length;
  summary.ok = scanProblems === 0 && stepProblems === 0 && strayProblems === 0;
  const total = key => summary.steps.reduce((sum, step) => sum + step[key].length, 0);
  summary.counts = {
    scannedFiles: summary.scan.files, scanProblems, steps: summary.steps.length, stepProblems, strayProblems,
    consoleErrors: total('consoleErrors'), unmocked: total('unmocked'), failedRequests: total('failedRequests'),
    apiLeaks: total('apiLeaks'), warnings: total('warnings'), boundary: summary.steps.filter(step => step.boundary).length,
    downloads: total('downloads'), seconds: Math.round(summary.steps.reduce((sum, step) => sum + step.ms, 0) / 1000),
  };
  writeFileSync(path.join(options.outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  // The console gets a compact view; summary.json has every field.
  console.log(JSON.stringify({ ok: summary.ok, server: summary.server, counts: summary.counts, scanProblems: summary.scan.problems, stray: summary.stray }, null, 2));
  for (const step of summary.steps) console.log(`${step.problems.length ? 'FAIL' : 'ok  '} ${step.name} (${step.viewport}, ${step.ms} ms)${step.problems.length ? `\n     ${step.problems.join('\n     ')}` : ''}`);
  process.exitCode = summary.ok ? 0 : 1;
}

run().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
