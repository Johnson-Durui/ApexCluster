// README media for the online demo: clean screenshots (no demo pill) and an animated walkthrough GIF.
//
// Usage (from the repository root, after `npm --prefix web run build:demo`):
//   node web/demo/scripts/capture-media.mjs [outDir] [--dist <dir>] [--no-gif]
//
//   outDir   where the images are written (default: docs/images)
//   --dist   the built demo (default: web/dist-demo)
//   --no-gif skip the GIF
// Environment:
//   CDP_PORT          DevTools port for headless Edge (default 9641)
//   EDGE_PATH         browser executable (default: Microsoft Edge in Program Files (x86))
//   EDGE_PROFILE_DIR  --user-data-dir (default: <os tmp>/mawb-media-edge-<CDP_PORT>)
//   FFMPEG            ffmpeg executable for the GIF (default: ffmpeg on PATH)
//
// Every page is loaded with ?shots=1 (the demo hides its pill) and the scripted runs play at ?speed=4.
// All data shown is the demo's synthetic preset data; nothing here talks to a backend or a model.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const args = process.argv.slice(2);
const flag = name => { const index = args.indexOf(name); return index >= 0 ? args.splice(index, 2)[1] : undefined; };
const noGif = args.includes('--no-gif') ? (args.splice(args.indexOf('--no-gif'), 1), true) : false;
const dist = path.resolve(flag('--dist') ?? path.join(repo, 'web/dist-demo'));
const outDir = path.resolve(args[0] ?? path.join(repo, 'docs/images'));
const port = Number(process.env.CDP_PORT ?? 9641);
const edge = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = process.env.EDGE_PROFILE_DIR ?? path.join(os.tmpdir(), `mawb-media-edge-${port}`);
const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';
const BASE = '/ApexCluster/';
const SAMPLE = 'chat-r7d3k9m2p5xa';
const RUN_COMPLETED = 'r-20261114-3c9e51';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

if (!existsSync(path.join(dist, 'index.html'))) throw new Error(`no build at ${dist}; run npm --prefix web run build:demo first`);
mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------- static server (same layout as GitHub Pages)
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.zip': 'application/zip' };
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://x');
  if (!url.pathname.startsWith(BASE)) { response.writeHead(404).end(); return; }
  let file = path.join(dist, decodeURIComponent(url.pathname.slice(BASE.length)));
  if (!file.startsWith(dist)) { response.writeHead(403).end(); return; }
  if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!existsSync(file)) { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// ---------------------------------------------------------------- browser
rmSync(profile, { recursive: true, force: true });
const browser = spawn(edge, ['--headless=new', '--no-first-run', '--hide-scrollbars', '--force-color-profile=srgb', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank'], { stdio: 'ignore' });
async function target() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try { const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(item => item.type === 'page'); if (page) return page.webSocketDebuggerUrl; } catch { /* starting */ }
    await sleep(200);
  }
  throw new Error('no DevTools target');
}
const socket = new WebSocket(await target());
await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
let nextId = 0;
const pending = new Map();
socket.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); } });
const send = (method, params = {}) => new Promise(resolve => { const key = ++nextId; pending.set(key, resolve); socket.send(JSON.stringify({ id: key, method, params })); });
await send('Page.enable');
await send('Runtime.enable');

const PRELUDE = `
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (fn, timeout = 60000, every = 150) => { const end = Date.now() + timeout; while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(every); } return null; };
const need = (value, message) => { if (!value) throw new Error(message); return value; };
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const byText = (selector, wanted) => $$(selector).find(node => node.textContent.trim() === wanted) ?? $$(selector).find(node => node.textContent.includes(wanted));
const chatId = () => new URLSearchParams(location.hash.split('?')[1] ?? '').get('chat');
const stageNow = () => $('.pipe-rail .pnode.now, .pipe-rail .pnode.you')?.dataset.stage ?? null;
const reveal = async node => {
  let parent = node.parentElement;
  while (parent && !(/(auto|scroll)/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight)) parent = parent.parentElement;
  if (parent) { const box = node.getBoundingClientRect(); const outer = parent.getBoundingClientRect(); parent.scrollTop += box.top - outer.top - Math.max(8, (outer.height - box.height) / 2); }
  await sleep(500);
};
const toBottom = async () => { const log = $('.chat-messages'); if (log) { log.scrollTop = log.scrollHeight; await sleep(600); } };
`;

async function viewport(width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
}
async function load(route, { query = 'shots=1', page = '' } = {}) {
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(200);
  await send('Page.navigate', { url: `${origin}${BASE}${page}${query ? `?${query}` : ''}${route === null ? '' : `#${route}`}` });
  await sleep(2200);
}
async function run(body) {
  const result = await send('Runtime.evaluate', { expression: `(async () => { ${PRELUDE}\n${body} })()`, awaitPromise: true, returnByValue: true });
  const failure = result.result?.exceptionDetails;
  if (failure) throw new Error(failure.exception?.description ?? failure.text);
  return result.result?.result?.value;
}
async function shot(name) {
  // Transient notices (for example the product's completion toast) would cover part of a still image.
  await run(`const close = $$('.toasts .toast > button.icon-btn'); close.forEach(button => button.click()); if (close.length) await sleep(450); return close.length;`);
  const result = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(result.result.data, 'base64'));
  console.log('saved', `${name}.png`);
}

const START_PLAY = `
const input = need(await until(() => $('form.chat-compose textarea')?.value ? $('form.chat-compose textarea') : null, 10000), 'composer not prefilled');
need($('form.chat-compose button.compose-send'), 'no send button').click();
need(await until(() => stageNow() === 'architecture', 10000), 'architecture did not start');
return 'started';`;

try {
  // ------------------------------------------------------------ screenshots at 1600 x 1000
  await viewport(1600, 1000);

  // A live scripted run: gate A, then implementation.
  await load('/?new=1&demo=play', { query: 'shots=1&speed=4' });
  await run(START_PLAY);
  await run(`const card = need(await until(() => $('.gate-wrap[data-gate="A"]'), 90000), 'no gate A'); await sleep(900); await reveal(card); return 1;`);
  await shot('gate-a');
  await run(`need($('.gate-wrap[data-gate="A"] [data-gate-confirm]'), 'gate A already decided').click(); need(await until(() => stageNow() === 'implementation', 10000), 'implementation did not start'); return 1;`);
  await run(`await until(() => $$('.map-stage .seat-card, .obs-seat').length > 0, 3000); await sleep(4200); return 1;`);
  await shot('live-implementation');

  // The completed sample chat: deliverables, the maximised map and its tabs.
  await load(`/?chat=${SAMPLE}`);
  await run(`await until(() => $$('.chat-message').length > 3, 10000); await toBottom(); await sleep(800); return 1;`);
  await shot('delivered');
  await run(`need($('button[aria-keyshortcuts="Alt+A"][aria-pressed]'), 'no 架构视图 toggle').click(); need(await until(() => $('.map-camera'), 5000), 'map not maximised'); await sleep(1500); return 1;`);
  await shot('architecture-view');
  await run(`need(byText('.map-tabs [role=tab]', '决策管道'), 'no 决策管道 tab').click(); await sleep(1600); return 1;`);
  await shot('decision-pipeline');

  // Task history and a review run.
  await load('/history');
  await run(`const row = need(await until(() => $('[role="option"][data-id="${RUN_COMPLETED}"]'), 10000), 'no history row'); row.click(); await until(() => ($('.hist-insp')?.innerText ?? '').includes('总模型分钟'), 8000); await sleep(700); return 1;`);
  await shot('history');
  await load(`/runs/${RUN_COMPLETED}`);
  await run(`need(await until(() => $('#tab-decision'), 10000), 'no decision tab').click(); await sleep(1500); return 1;`);
  await shot('run-decision');

  await load('/environment');
  await run(`await sleep(1500); return 1;`);
  await shot('environment');

  await load(null, { query: '', page: 'demo-project/index.html' });
  await run(`await until(() => $$('#floor-tabs > *').length, 8000); await sleep(600); return 1;`);
  await shot('roomdesk-app');

  // ------------------------------------------------------------ animated walkthrough (1280 x 800 -> 960 px GIF)
  if (!noGif) {
    const probe = spawnSync(ffmpeg, ['-version'], { encoding: 'utf8' });
    if (probe.status !== 0) throw new Error(`ffmpeg not found (${ffmpeg}); set FFMPEG or pass --no-gif`);
    const frames = path.join(os.tmpdir(), `mawb-media-frames-${port}`);
    rmSync(frames, { recursive: true, force: true });
    mkdirSync(frames, { recursive: true });
    await viewport(1280, 800);
    await load('/?new=1&demo=play', { query: 'shots=1&speed=4' });
    const times = [];
    let recording = true;
    const recorder = (async () => {
      while (recording) {
        const started = Date.now();
        const result = await send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
        writeFileSync(path.join(frames, `f${String(times.length).padStart(5, '0')}.jpg`), Buffer.from(result.result.data, 'base64'));
        times.push(started);
        await sleep(Math.max(0, 90 - (Date.now() - started)));
      }
    })();
    await sleep(1200);
    await run(START_PLAY);
    await run(`const card = need(await until(() => $('.gate-wrap[data-gate="A"]'), 90000), 'no gate A'); await sleep(1500); await reveal(card); await sleep(1400); return 1;`);
    await run(`need($('.gate-wrap[data-gate="A"] [data-gate-confirm]'), 'gate A already decided').click(); await sleep(9000); return 1;`);
    recording = false;
    await recorder;
    times.push(Date.now());
    const list = times.slice(0, -1).map((time, index) => `file 'f${String(index).padStart(5, '0')}.jpg'\nduration ${((times[index + 1] - time) / 1000).toFixed(3)}`).join('\n');
    writeFileSync(path.join(frames, 'list.txt'), `${list}\nfile 'f${String(times.length - 2).padStart(5, '0')}.jpg'\n`);
    const gif = path.join(outDir, 'walkthrough.gif');
    const filter = 'fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle';
    const encode = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(frames, 'list.txt'), '-filter_complex', filter, '-loop', '0', gif], { cwd: frames, encoding: 'utf8' });
    if (encode.status !== 0) throw new Error(`ffmpeg failed: ${encode.stderr}`);
    console.log('saved walkthrough.gif', `${(statSync(gif).size / 1024 / 1024).toFixed(1)} MB`, `${times.length - 1} frames`);
    rmSync(frames, { recursive: true, force: true });
  }
} finally {
  socket.close();
  browser.kill();
  server.close();
}
