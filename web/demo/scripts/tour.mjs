// The full-tour step list for verify-demo.mjs (README.md "Verification").
//
// Each step is a plain object (fields documented at the top of verify-demo.mjs). A step with `route` reloads the page;
// a step without one continues in the same page, so the live RoomDesk run keeps its in-memory state across steps.
// `eval` is the body of an async function run in the page. It throws (`need(...)`) when the page does not reach the
// state the step is about, which the verifier reports as a step error. Every eval starts with the helpers in PRELUDE.

const PRELUDE = String.raw`
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (fn, timeout = 30000, every = 150) => { const end = Date.now() + timeout; while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(every); } return null; };
const need = (value, message) => { if (!value) throw new Error(message); return value; };
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const flat = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const text = () => document.body.innerText;
const byText = (selector, wanted) => $$(selector).find(node => node.textContent.trim() === wanted) ?? $$(selector).find(node => node.textContent.includes(wanted));
const chatId = () => new URLSearchParams(location.hash.split('?')[1] ?? '').get('chat');
const snapshot = async (id = chatId()) => (await fetch('/api/chats/' + id)).json();
const setValue = (node, value) => { const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value'); descriptor.set.call(node, value); node.dispatchEvent(new Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
const pill = () => flat($('.mawb-demo-pill')?.innerText);
const stageNow = () => $('.pipe-rail .pnode.now, .pipe-rail .pnode.you')?.dataset.stage ?? null;
const progress = () => flat($('.chat-progress summary')?.innerText);
const state = () => ({ hash: location.hash, stage: stageNow(), pill: pill(), progress: progress() });
const toBottom = async () => { const log = $('.chat-messages'); if (log) { log.scrollTop = log.scrollHeight; await sleep(600); } };
const reveal = async (node, where = 'center') => {
  // Scrolls only the node's own scroll container; scrollIntoView would also shift overflow-hidden ancestors.
  let parent = node.parentElement;
  while (parent && !(/(auto|scroll)/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight)) parent = parent.parentElement;
  if (parent) { const box = node.getBoundingClientRect(); const outer = parent.getBoundingClientRect(); parent.scrollTop += where === 'start' ? box.top - outer.top - 8 : box.top - outer.top - (outer.height - box.height) / 2; }
  await sleep(400);
};
const closeDialogs = async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(200); for (const button of $$('[role=dialog] button[aria-label*="关闭"], dialog button[aria-label*="关闭"]')) button.click(); await sleep(250); };
`;

/** A step that continues in the current page. */
const at = (name, body, extra = {}) => ({ name, wait: 0, after: 200, eval: PRELUDE + body, ...extra });
/** A step that loads a route first. */
const open = (name, route, body, extra = {}) => ({ name, route, wait: 2200, after: 300, ...(body ? { eval: PRELUDE + body } : {}), ...extra });

const PROMPT = '帮我做一个团队会议室预约小工具：先出 PRD 和技术架构，再完成可运行的 Web 应用和自动化测试。需要支持按楼层筛选、冲突检测和 iCal 导出。';
const LIVE = { query: 'speed=4' };
const BIG = { width: 1600, height: 1000 };
const SMALL = { width: 1280, height: 720 };

export const SAMPLE_CHATS = { roomdesk: 'chat-r7d3k9m2p5xa', weekly: 'chat-w4n8q2t6y1kc', readme: 'chat-e5b9h3v7u2ld' };
export const RUNS = { completed: 'r-20261114-3c9e51', waiting: 'r-20261120-a74d02', blocked: 'r-20261117-e2b6f8', running: 'r-20261120-5b81c3' };
const RUN_TABS = ['workspace', 'live', 'questions', 'proposals', 'compare', 'decision', 'documents', 'validation', 'deliverables', 'records'];
const RUN_ERROR_WORDS = ['读取失败', '读取文档列表失败', '读取文档详情失败', '交付成果读取失败', '运行度量读取失败', '预填规格读取失败', '在线演示未提供此接口', '在线演示内部错误', '请求失败', '预览载入失败', '架构图无法渲染'];
const READ_ONLY = '在线演示使用预设数据，此操作不可用。';

// ---------------------------------------------------------------- 1. welcome and the pill

const welcome = [
  open('welcome-1280', '/', String.raw`return { pill: pill() };`, { ...SMALL, expectText: ['播放完整演示 · 会议室预约工具 · 约 3 分钟 →', '在线演示'], crop: { x: 520, y: 690, width: 760, height: 30 } }),
  open('welcome-1600', '/', String.raw`return { pill: pill() };`, { ...BIG, expectText: ['播放完整演示 · 会议室预约工具 · 约 3 分钟 →', '在线演示 · 预设数据，不调用任何模型', '交付成品 ↗', 'GitHub ↗'], crop: { x: 700, y: 970, width: 900, height: 30 } }),
  open('shots-mode', '/', String.raw`need(!$('.mawb-demo-pill'), 'the pill is rendered in shots mode'); need(window.__mawbDemo, 'window.__mawbDemo is missing in shots mode'); return 'no pill, API present';`, { ...SMALL, query: 'shots=1' }),
  open('delivered-app', null, String.raw`await until(() => $$('#floor-tabs button, #floor-tabs [role=tab]').length); return { title: document.title, floors: $$('#floor-tabs [role=tab], #floor-tabs button').map(node => flat(node.textContent)) };`,
    { ...SMALL, path: 'demo-project/index.html', mountSelector: '#floor-tabs > *', expectText: ['RoomDesk', '示例数据'] }),
];

// ---------------------------------------------------------------- 2. the scripted RoomDesk run at speed 4 (1280 x 720)

const liveRun = [
  open('play-prefill', '/?new=1&demo=play', String.raw`
    const input = need(await until(() => $('form.chat-compose textarea')?.value ? $('form.chat-compose textarea') : null, 8000), 'the composer was not prefilled');
    need(input.value === ${JSON.stringify(PROMPT)}, 'the prefilled prompt differs: ' + input.value);
    const send = need($('form.chat-compose button.compose-send'), 'no send button');
    need(!send.disabled, 'the send button is disabled');
    return { foot: flat($('.compose-foot')?.innerText), pill: pill() };`,
    { ...SMALL, ...LIVE, expectText: ['固定提示词演示 · 不消耗模型额度 · 不写入已授权项目目录'] }),
  at('play-architecture-start', String.raw`
    $('form.chat-compose button.compose-send').click();
    need(await until(() => chatId(), 8000), 'sending did not open the new chat');
    need(await until(() => stageNow() === 'architecture', 8000), 'the architecture stage did not start');
    await sleep(3000);
    return state();`, { ...SMALL, expectText: ['我了解：正式版发送会消耗模型额度，在线演示不会'] }),
  at('play-architecture-fanout', String.raw`
    await until(() => /任务 ([5-9]|1\d) \//.test(progress()), 30000);
    await sleep(800);
    return state();`, { ...SMALL }),
  at('play-gate-a-1280', String.raw`
    const card = need(await until(() => $('.gate-wrap[data-gate="A"]'), 90000), 'gate A card did not appear');
    await sleep(700);
    need(/关卡 A 等待你确认 · \d+ 秒后自动确认/.test(pill()), 'the pill shows no gate A countdown: ' + pill());
    need(flat(card.innerText).includes('本关卡交付 7 项'), 'gate A card does not list 7 deliverables');
    need(!text().includes('已保存到项目'), 'the visitor run claims files were saved to a project');
    need(flat($('.compose-toolbar')?.innerText).includes('仅对话'), 'the composer is no longer 仅对话: ' + flat($('.compose-toolbar')?.innerText));
    need(!(await snapshot()).chat.workspaceId, 'the visitor run is bound to a workspace');
    return { card: flat(card.innerText).slice(0, 220), ...state() };`, { ...SMALL, expectText: ['关卡 A', '确认继续'], crop: { x: 520, y: 690, width: 760, height: 30 } }),
  at('play-gate-a-1600', String.raw`
    await sleep(350);
    need($('.gate-wrap[data-gate="A"] [data-gate-confirm]'), 'gate A was already decided before the 1600 check');
    return state();`, { ...BIG }),
  at('play-gate-a-confirm', String.raw`
    const button = need($('.gate-wrap[data-gate="A"] [data-gate-confirm]'), 'gate A confirm button is gone (auto-confirmed before the click?)');
    button.click();
    const receipt = need(await until(() => $$('.chat-message.receipt').find(node => node.innerText.includes('关卡 A')), 8000), 'no gate A receipt');
    need(receipt.innerText.includes('由你决定'), 'gate A receipt is not 由你决定: ' + flat(receipt.innerText));
    need(await until(() => stageNow() === 'implementation', 8000), 'the implementation stage did not start');
    await sleep(1500);
    return { receipt: flat(receipt.innerText), ...state() };`, { ...SMALL }),
  at('play-implementation', String.raw`
    await sleep(6000);
    need(stageNow() === 'implementation', 'expected the implementation stage, got ' + stageNow());
    return state();`, { ...SMALL }),
  at('play-acceptance', String.raw`
    need(await until(() => stageNow() === 'acceptance', 90000), 'the acceptance stage did not start');
    await sleep(2500);
    return state();`, { ...SMALL }),
  at('play-gate-b-1280', String.raw`
    const card = need(await until(() => $('.gate-wrap[data-gate="B"]'), 90000), 'gate B card did not appear');
    await sleep(700);
    need(/关卡 B 等待你确认 · \d+ 秒后自动确认/.test(pill()), 'the pill shows no gate B countdown: ' + pill());
    return { card: flat(card.innerText).slice(0, 220), ...state() };`, { ...SMALL, expectText: ['关卡 B', '确认继续'] }),
  at('play-gate-b-auto', String.raw`
    const receipt = need(await until(() => $$('.chat-message.receipt').find(node => node.innerText.includes('关卡 B')), 30000), 'gate B was not decided');
    need(receipt.innerText.includes('由系统自动通过'), 'gate B receipt is not the automatic one: ' + flat(receipt.innerText));
    const done = need(await until(async () => (await snapshot()).chat.pipeline?.stage === 'completed', 30000), 'the pipeline did not reach completed');
    await sleep(2500);
    const snap = await snapshot();
    need(snap.chat.tasks.every(task => task.status === 'completed'), 'not every task completed');
    need(snap.chat.artifacts.length === 14, 'expected 14 artifacts, got ' + snap.chat.artifacts.length);
    need(!/关卡 [AB] 等待你确认/.test(pill()), 'the pill still shows a gate countdown');
    return { receipt: flat(receipt.innerText), stage: snap.chat.pipeline.stage, tasks: snap.chat.tasks.length, artifacts: snap.chat.artifacts.length, todos: snap.chat.todos.map(todo => todo.status).join(','), usage: snap.chat.apiUsage, ...state() };`,
    { ...SMALL, expectText: ['关卡 A · 已确认继续', '由你决定', '关卡 B · 已确认继续', '由系统自动通过'] }),
  at('play-completed-deliverables', String.raw`
    await toBottom();
    const cards = $$('.chat-delivery .deliv-card');
    need(cards.length === 14, 'expected 14 delivery cards, got ' + cards.length);
    const prd = need(cards.find(card => card.querySelector('b')?.textContent === 'PRD.md'), 'no PRD.md card');
    need(prd.querySelector('a[download]'), 'no download link on PRD.md').click();
    need(!text().includes('已保存到项目'), 'the visitor run claims files were saved to a project');
    // The M-API workspace diff carries package.json (its check runs npm test); the hand-back diff only README.md.
    const snap = await snapshot();
    const diffs = await Promise.all(snap.chat.artifacts.filter(item => item.kind === 'diff').map(async item => ({ name: item.name, body: await (await fetch('/api/chats/' + chatId() + '/artifacts/' + item.id)).text() })));
    const api = need(diffs.find(item => item.body.includes('+++ b/src/roomdesk-core.mjs')), 'no M-API diff');
    need(api.body.includes('+++ b/package.json'), 'the M-API diff has no package.json');
    need(!diffs.some(item => item !== api && item.body.includes('+++ b/package.json')), 'package.json appears in a later diff too');
    return { header: flat($('.chat-delivery h2')?.innerText), names: cards.map(card => card.querySelector('b')?.textContent), diffs: diffs.map(item => item.name) };`,
    { ...SMALL, after: 1500, expectText: ['交付文件'], expectDownloads: [{ name: 'PRD.md', sameAs: 'scenario/content/prd.md' }] }),
  at('play-completed-summary', String.raw`
    // The lead's last answer (the delivery summary), with the gate B receipt below it.
    const answer = need($$('.chat-message.assistant').at(-1), 'no assistant answer');
    await reveal(answer, 'start');
    return flat(answer.innerText).slice(0, 200);`, { ...SMALL }),
  at('map-maximised-topology', String.raw`
    const toggle = need($('button[aria-keyshortcuts="Alt+A"][aria-pressed]'), 'no 架构视图 toggle');
    toggle.click();
    need(await until(() => $('.map-camera'), 4000), 'the maximised map has no camera controls');
    await sleep(1200);
    return { pressed: toggle.getAttribute('aria-pressed'), tabs: $$('.map-tabs [role=tab]').map(node => flat(node.textContent)) };`, { ...SMALL, expectText: ['协作拓扑', '决策管道', '上下文'] }),
  at('map-maximised-1600', String.raw`await sleep(600); return 'resized';`, { ...BIG }),
  at('map-maximised-pipeline', String.raw`need(byText('.map-tabs [role=tab]', '决策管道'), 'no 决策管道 tab').click(); await sleep(1300); return 'ok';`, { ...SMALL }),
  at('map-maximised-context', String.raw`need(byText('.map-tabs [role=tab]', '上下文'), 'no 上下文 tab').click(); await sleep(1300); return 'ok';`, { ...SMALL }),
  at('inspector-seats', String.raw`
    byText('.map-tabs [role=tab]', '协作拓扑')?.click();
    await sleep(300);
    const toggle = $('button[aria-keyshortcuts="Alt+A"][aria-pressed]');
    if (toggle?.getAttribute('aria-pressed') === 'true') toggle.click();
    need(await until(() => !$('.map-camera'), 4000), 'the map did not return from the maximised view');
    await sleep(600);
    need($('#chat-inspector-toggle'), 'no inspector toggle').click();
    need(await until(() => $('.insp-tab'), 5000), 'the inspector did not open');
    need(byText('.insp-tab', '席位'), 'no 席位 tab').click();
    await sleep(900);
    return $$('.insp-tab').map(node => flat(node.textContent));`, { ...SMALL }),
  at('inspector-tasks', String.raw`need(byText('.insp-tab', '任务'), 'no 任务 tab').click(); await sleep(1000); return flat($('.inspector-page-tasks')?.innerText).slice(0, 160);`, { ...SMALL }),
  at('inspector-files', String.raw`need(byText('.insp-tab', '文件'), 'no 文件 tab').click(); await sleep(1000); return flat($('.inspector-page-files')?.innerText).slice(0, 160);`, { ...SMALL }),
  at('inspector-file-preview', String.raw`
    const button = need($$('.inspector-page-files button').find(node => node.textContent.includes('安全预览')), 'no 安全预览 button');
    button.click();
    const pre = need(await until(() => $('.artifact-preview pre'), 6000), 'the preview did not open');
    await sleep(400);
    need(pre.innerText.includes('RoomDesk'), 'the preview does not show the PRD');
    need(pre.innerText.includes('随需求契约第 1 版冻结') && !pre.innerText.includes('关卡 A 确认'), 'the PRD status line is not the stage-neutral one');
    return pre.innerText.slice(0, 80);`, { ...SMALL }),
  at('inspector-context', String.raw`await closeDialogs(); need(byText('.insp-tab', '上下文'), 'no 上下文 tab').click(); await sleep(1000); return flat($('.inspector-page-context')?.innerText).slice(0, 160);`, { ...SMALL }),
  at('inspector-settings', String.raw`need(byText('.insp-tab', '设置'), 'no 设置 tab').click(); await sleep(1200); return flat($('.inspector-page-settings')?.innerText).slice(0, 200);`,
    { ...SMALL, expectText: ['Docker 执行沙箱', '本聊天席位'] }),
];

// ---------------------------------------------------------------- 3. pre-baked chats and a plain chat

const samples = [
  open('sample-roomdesk-1600', `/?chat=${SAMPLE_CHATS.roomdesk}`, String.raw`return state();`,
    { ...BIG, expectText: ['会议室预约工具 RoomDesk', '关卡 A · 已确认继续', '关卡 B · 已确认继续'] }),
  at('sample-roomdesk-zip', String.raw`
    await toBottom();
    const card = need($$('.chat-delivery .deliv-card').find(node => node.querySelector('b')?.textContent === 'roomdesk.zip'), 'no roomdesk.zip card');
    await reveal(card);
    card.querySelector('a[download]').click();
    return { saved: flat($('.deliv-saved')?.innerText) };`,
    { ...BIG, after: 2000, expectText: ['交付文件', '已保存到项目'], expectDownloads: [{ name: 'roomdesk.zip', sameAs: 'public/demo-project/roomdesk.zip' }] }),
  open('sample-roomdesk-1280-menu', `/?chat=${SAMPLE_CHATS.roomdesk}`, String.raw`
    const more = $('.mawb-demo-pill .mdp-more');
    if (more && !more.hidden) { more.click(); await sleep(400); }
    return { pill: pill(), menuOpen: Boolean($('.mawb-demo-pill .mdp-menu:not([hidden])')) };`, { ...SMALL }),
  open('sample-weekly', `/?chat=${SAMPLE_CHATS.weekly}`, String.raw`await toBottom(); return state();`, { ...SMALL, expectText: ['整理一份周报模板', '周报模板.md'] }),
  open('sample-readme-question', `/?chat=${SAMPLE_CHATS.readme}`, String.raw`
    const question = need(await until(() => $('.chat-question'), 6000), 'no question card');
    await reveal(question);
    return { question: flat(question.innerText).slice(0, 200), ...state() };`, { ...SMALL, ...LIVE, expectText: ['README 中英对照', '需要你的回答'] }),
  at('sample-readme-answered', String.raw`
    need($$('.question-options button')[1], 'no second option').click();
    need(await until(() => text().includes('已拆成两个文件'), 30000), 'the scripted reply did not arrive');
    await sleep(1500);
    await toBottom();
    return { files: $$('.chat-delivery .deliv-card b').map(node => node.textContent), ...state() };`, { ...SMALL, expectText: ['README.en.md'] }),
  at('sample-readme-preview', String.raw`
    const card = need($$('.chat-delivery .deliv-card').find(node => node.innerText.includes('README.en.md')), 'no README.en.md card');
    card.querySelector('button').click();
    const pre = need(await until(() => $('.artifact-preview pre'), 6000), 'the preview did not open');
    await sleep(300);
    return pre.innerText.slice(0, 100);`, { ...SMALL }),
  open('plain-hello', '/?new=1', String.raw`
    const input = need(await until(() => $('form.chat-compose textarea'), 6000), 'no composer');
    setValue(input, '你好');
    await sleep(200);
    $('.cost-confirm input')?.click();
    await sleep(200);
    const send = need($('form.chat-compose button.compose-send'), 'no send button');
    need(!send.disabled, 'send is disabled');
    send.click();
    need(await until(() => text().includes('这是一个静态在线演示'), 30000), 'the canned answer did not arrive');
    need(await until(() => progress().includes('已完成'), 15000), 'the plain turn did not complete');
    await sleep(800);
    return state();`, { ...SMALL, ...LIVE, expectText: ['你好', '这是一个静态在线演示', '没有连接任何模型', '播放完整演示', '已确认 · 在线演示不调用模型，不消耗额度'] }),
];

// ---------------------------------------------------------------- 4. review runs

const historySteps = [
  open('history', '/history', String.raw`
    await until(() => $$('[role="option"][data-id]').length === 4, 8000);
    return { ids: $$('[role="option"][data-id]').map(node => node.dataset.id), kpis: $$('.kpi').map(node => flat(node.innerText)) };`,
    { ...SMALL, expectText: ['全部运行', '等你决定', '进行中', '已结束', '为博客评论选择存储方案', '移动端离线同步策略评审', '支付回调幂等性改造', '日志采集管线成本评估'] }),
  ...Object.entries(RUNS).map(([kind, id]) => at(`history-select-${kind}`, String.raw`
    need($('[role="option"][data-id="${id}"]'), 'no history row ${id}').click();
    const inspector = need(await until(() => { const node = $('.hist-insp'); return node && node.innerText.includes('${id}') && node.innerText.includes('总模型分钟') ? node : null; }, 8000), 'the inspector did not show the metrics of ${id}');
    need(!inspector.innerText.includes('指标读取失败'), 'metrics failed to load');
    return flat(inspector.innerText).slice(0, 160);`, { ...SMALL })),
  open('history-1600', '/history', null, { ...BIG }),
];

function runSteps(kind, id) {
  return RUN_TABS.map((tab, index) => {
    const body = String.raw`
      need(await until(() => $('#tab-${tab}'), 10000), 'no tab ${tab}').click();
      await sleep(${tab === 'documents' ? 2000 : 1100});
      const panel = need($('#run-panel-${tab}'), 'no panel ${tab}');
      const errors = ${JSON.stringify(RUN_ERROR_WORDS)}.filter(word => panel.innerText.includes(word));
      need(!errors.length, 'error words in the panel: ' + errors.join(', '));
      need(!$('.run-error'), 'run error banner: ' + flat($('.run-error')?.innerText));
      return { conn: flat($('.run-conn')?.innerText), panel: flat(panel.innerText).slice(0, 120) };`;
    return index === 0
      ? open(`run-${kind}-${tab}`, `/runs/${id}`, body, { ...SMALL, wait: 1500 })
      : at(`run-${kind}-${tab}`, body, { ...SMALL });
  });
}

const runChecks = [
  open('run-completed-doc-devdoc', `/runs/${RUNS.completed}`, String.raw`
    need(await until(() => $('#tab-documents'), 10000), 'no documents tab').click();
    await sleep(1500);
    need(byText('.doc-kind-tabs button', '开发文档'), 'no 开发文档 tab').click();
    const frame = need(await until(() => { const node = $('iframe.doc-preview'); return node && node.srcdoc.length > 500 ? node : null; }, 8000), 'the document preview did not load');
    need(frame.getAttribute('src') === null && frame.getAttribute('sandbox') === '', 'the preview iframe is not a sandboxed srcdoc');
    await sleep(600);
    return { srcdoc: frame.srcdoc.length };`, { ...SMALL }),
  at('run-completed-doc-prd', String.raw`
    need(byText('.doc-kind-tabs button', '产品需求文档'), 'no 产品需求文档 tab').click();
    await sleep(1800);
    const evidence = flat($('.prd-evidence')?.innerText);
    need(evidence.includes('评审前检查'), 'the PRD checklist is missing');
    need([...document.querySelectorAll('.doc-toolbar a')].find(node => node.innerText.includes('下载 Markdown')), 'no 下载 Markdown link').click();
    return evidence.slice(0, 120);`, { ...SMALL, after: 1500, expectDownloads: [{ name: /^PRD-.*-v1\.md$/ }] }),
  at('run-completed-downloads', String.raw`
    $('#tab-deliverables').click();
    await sleep(1500);
    need($('a[data-demo-href$="/export"]'), 'no export link').click();
    await sleep(700);
    need($$('a[data-demo-href*="/artifact?path="]').find(node => node.getAttribute('data-demo-href').endsWith('path=README.md')), 'no README.md artifact link').click();
    await sleep(700);
    need($('a[data-demo-href$="/archive"]'), 'no archive link').click();
    return 'clicked export, README.md and archive';`,
    { ...SMALL, after: 2000, expectDownloads: [{ name: 'decision-r-20261114-3c9e51.md' }, { name: 'README.md' }, { name: 'delivery-r-20261114-3c9e51-j-C1-1.zip' }] }),
  open('run-waiting-diagram', `/runs/${RUNS.waiting}`, String.raw`
    need(await until(() => $('#tab-proposals'), 10000), 'no proposals tab').click();
    await sleep(900);
    need($$('#run-panel-proposals button').find(node => node.innerText.includes('查看架构图')), 'no 查看架构图 button').click();
    const svg = need(await until(() => $('#run-panel-proposals .diagram svg'), 15000), 'the diagram did not render');
    await reveal(svg);
    return 'rendered';`, { ...SMALL }),
  at('run-waiting-gate-readonly', String.raw`
    $('#tab-decision').click();
    await sleep(1600);
    const button = need($$('#run-panel-decision button.gate').find(node => node.innerText.includes('确认框架并进入 MVP 验证')), 'no G2 confirm button');
    need(!button.disabled, 'the G2 confirm button is disabled');
    button.click();
    const banner = need(await until(() => $('.run-error'), 5000), 'no read-only banner');
    need(banner.innerText.includes(${JSON.stringify(READ_ONLY)}), 'unexpected banner: ' + flat(banner.innerText));
    return flat(banner.innerText);`, { ...SMALL, expectText: [READ_ONLY] }),
  open('run-blocked-retry-readonly', `/runs/${RUNS.blocked}`, String.raw`
    const bar = need(await until(() => $('.blocked-bar'), 10000), 'no blocked bar');
    need($$('button', bar).find(node => node.innerText.includes('重试失败的任务')), 'no retry button').click();
    const banner = need(await until(() => $('.run-error'), 5000), 'no read-only banner');
    need(banner.innerText.includes(${JSON.stringify(READ_ONLY)}), 'unexpected banner: ' + flat(banner.innerText));
    return flat(banner.innerText);`, { ...SMALL, expectText: [READ_ONLY] }),
  open('run-running-live-feed', `/runs/${RUNS.running}`, String.raw`
    need(await until(() => $('#tab-live'), 10000), 'no live tab').click();
    await sleep(1200);
    const before = $$('.lp-log li').length;
    await sleep(6000);
    const after = $$('.lp-log li').length;
    need(after >= before + 4, 'the live feed did not advance: ' + before + ' -> ' + after);
    return { before, after };`, { ...SMALL, ...LIVE }),
  open('run-completed-1600', `/runs/${RUNS.completed}`, null, { ...BIG }),
];

const runs = [
  ...historySteps,
  ...Object.entries(RUNS).flatMap(([kind, id]) => runSteps(kind, id)),
  ...runChecks,
];

// ---------------------------------------------------------------- 5. new review, environment and settings

const system = [
  open('new-review-1280', '/new', String.raw`
    await until(() => $$('.weight-row').length === 5, 8000);
    return { models: $$('.model-setting input.mono').map(node => node.value), total: flat($('.weight-total strong')?.textContent) };`,
    { ...SMALL, expectText: ['需求适配', '在线演示不连接本机 Cursor', '已读取'] }),
  at('new-review-launch-readonly', String.raw`
    setValue(need($('#new-title'), 'no title field'), '演示：新建评审');
    setValue(need($('#new-prompt'), 'no prompt field'), '在线演示里尝试新建一次评审。');
    const ack = $$('input[type=checkbox]').find(node => (node.closest('label')?.innerText ?? '').includes('额度'));
    if (ack && !ack.checked) ack.click();
    await sleep(500);
    const launch = need($$('button').find(node => node.innerText.includes('启动评审')), 'no 启动评审 button');
    need(!launch.disabled, '启动评审 is disabled');
    launch.click();
    const confirm = need(await until(() => $$('button').find(node => node.innerText.trim() === '确认并启动'), 5000), 'no 确认并启动 button');
    confirm.click();
    need(await until(() => text().includes(${JSON.stringify(READ_ONLY)}), 6000), 'no read-only message');
    need(location.hash === '#/new', 'navigated away from #/new: ' + location.hash);
    return 'refused with the read-only message';`, { ...SMALL, after: 600 }),
  open('new-review-1600', '/new', null, { ...BIG, expectText: ['执行沙箱 Docker · 已就绪', '需求适配'] }),
  open('environment-1280', '/environment', String.raw`
    await until(() => $$('#env-findings .finding').length && $$('.api-preset').length, 8000);
    return { kpis: $$('.kpi').map(node => flat(node.innerText)) };`,
    { ...SMALL, expectText: ['检查结果', '命令行工具', '运行状态', 'API 名册与预设', 'flagship', 'single-provider', '完整流水线需要 Sol 与 Opus 来自不同厂商家族', '没有未保存的更改'] }),
  at('environment-api-presets', String.raw`await reveal(document.getElementById('env-api'), 'start'); return flat($('#env-api').innerText).slice(0, 160);`, { ...SMALL }),
  at('environment-services', String.raw`await reveal(document.getElementById('env-docworker'), 'start'); return flat($('#env-mcp').innerText).slice(0, 160);`, { ...SMALL }),
  open('settings-1600', '/environment', String.raw`await until(() => $$('#env-findings .finding').length, 8000); return 'ok';`,
    { ...BIG, expectText: ['执行沙箱 Docker · 已就绪', '没有未保存的更改'] }),
  at('settings-save', String.raw`
    await reveal(document.getElementById('env-docworker'), 'start');
    setValue(need($('#env-docworker input.mono'), 'no document worker URL field'), 'http://127.0.0.1:18782');
    need(await until(() => flat($('.settings-save-state b')?.textContent).includes('1 项'), 5000), 'the save bar did not show 1 unsaved change');
    need(byText('.settings-save-actions button', '保存设置'), 'no 保存设置 button').click();
    const notice = need(await until(() => $('.settings-notice')?.textContent.includes('配置已保存') ? flat($('.settings-notice').textContent) : null, 6000), 'no saved notice');
    const echoed = await (await fetch('/api/chat-settings')).json();
    need(echoed.documentWorker?.url === 'http://127.0.0.1:18782', 'the saved URL was not echoed');
    return notice;`, { ...BIG, after: 600, expectText: ['配置已保存并重新加载运行状态。'] }),
  open('settings-live-probe-refused', '/environment', String.raw`
    need(await until(() => $('.target-grid input'), 8000), 'no live probe targets');
    await reveal(document.getElementById('env-live'), 'start');
    $$('.target-grid input')[0].click();
    $('.live-actions .check-label input').click();
    await sleep(200);
    need(byText('.live-actions button', '运行所选真实探测'), 'no live probe button').click();
    need(await until(() => byText('button', '确认并运行'), 5000), 'no confirm button').click();
    return need(await until(() => $('.live-error') && flat($('.live-error').innerText), 6000), 'no refusal message');`,
    { ...SMALL, after: 600, expectText: ['真实探测未完成：在线演示不调用模型。'] }),
];

// ---------------------------------------------------------------- 6. a second scripted run with nobody at the gates

const unattended = [
  open('play-unattended-both-gates-auto', '/?new=1&demo=play', String.raw`
    const send = need(await until(() => { const node = $('form.chat-compose button.compose-send'); return node && !node.disabled ? node : null; }, 8000), 'send is not available');
    send.click();
    need(await until(() => chatId(), 8000), 'sending did not open the new chat');
    need(await until(async () => (await snapshot()).chat.pipeline?.stage === 'completed', 180000, 500), 'the unattended run did not reach completed');
    await sleep(2000);
    const snap = await snapshot();
    const gates = snap.messages.filter(message => message.pipelineGate).map(message => message.pipelineGate.id + ':' + (message.auto ? 'auto' : 'user'));
    need(gates.join(',') === 'A:auto,B:auto', 'expected both gates decided automatically, got ' + gates.join(','));
    need(snap.chat.tasks.every(task => task.status === 'completed') && snap.chat.artifacts.length === 14, 'the unattended run is incomplete');
    const answer = $$('.chat-message.receipt').at(-1);
    if (answer) await reveal(answer, 'start');
    return { gates, tasks: snap.chat.tasks.length, artifacts: snap.chat.artifacts.length, ...state() };`,
    { ...SMALL, ...LIVE, expectText: ['由系统自动通过'] }),
];

// ---------------------------------------------------------------- 7. review-round regressions (2026-11-20)

/** Layout stability of the pill: the layout viewport keeps the emulated width, nothing scrolls sideways, and the pill
 * is not restyled while nothing changes (the old docked pill widened mobile pages and relaid itself every frame). */
const STABLE = (width, place) => String.raw`
    const node = need($('.mawb-demo-pill'), 'no pill');
    let writes = 0;
    const watch = new MutationObserver(list => { writes += list.length; });
    watch.observe(node, { attributes: true, attributeFilter: ['style', 'data-place'] });
    const widths = new Set();
    for (let index = 0; index < 10; index++) { widths.add(innerWidth); await sleep(200); }
    watch.disconnect();
    need(widths.size === 1 && widths.has(${width}), 'the layout viewport width changed: ' + [...widths].join(','));
    need(writes === 0, 'the pill was restyled ' + writes + ' times in 2 s without a change');
    need(document.documentElement.scrollWidth <= innerWidth, 'the page scrolls sideways: ' + document.documentElement.scrollWidth + ' > ' + innerWidth);
    need(node.dataset.place === '${place}', 'the pill is ' + node.dataset.place + ', expected ${place}');
    if ('${place}' === 'banner') need(Math.round($('.app').getBoundingClientRect().top) === 26, 'the app frame did not move below the banner');
    return { innerWidth, scrollWidth: document.documentElement.scrollWidth, place: node.dataset.place, pill: pill() };`;
const PHONE = { width: 375, height: 812, mobile: true };
const TABLET = { width: 768, height: 1024, mobile: true };
const GATE_LINE = String.raw`
    need($('.gate-wrap[data-gate="A"] [data-gate-confirm]'), 'gate A was decided before this check');
    need(/关卡 A( 等待你确认)? · (\d+ 秒|确认中|正在自动确认)/.test(pill()), 'the pill shows no gate A countdown: ' + pill());`;
const NO_RUNNING_TOOL = String.raw`
    const running = $$('table.acts tbody tr.kind-tool').filter(row => row.innerText.includes('正在调用')).map(row => flat(row.innerText));
    need(!running.length, 'tool rows still 正在调用 after stop: ' + running.join(' | '));
    const open = new Map();
    for (const event of (await snapshot()).recentEvents) {
      const id = event.data && event.data.toolCallId;
      if (!id) continue;
      if (event.type === 'tool_started') open.set(id, event.data.name);
      else if (event.type === 'tool_result' || event.type === 'tool_error') open.delete(id);
    }
    need(!open.size, 'tool calls without a result or error: ' + [...open.values()].join(', '));`;
/** Reloads the page shortly after the step's eval returns; the next step runs on the reloaded page. */
const RELOAD = String.raw`setTimeout(() => location.reload(), 100); return 'reloading';`;
const CLEAR_SPEED = String.raw`try { sessionStorage.removeItem('mawb-demo:speed'); } catch {}`;

const review = [
  // R1: phones and tablets in mobile emulation, plus a narrow desktop window.
  open('rr-phone-375', '/', STABLE(375, 'banner'), { ...PHONE }),
  open('rr-phone-414', '/', STABLE(414, 'banner'), { width: 414, height: 896, mobile: true }),
  open('rr-tablet-768', '/', STABLE(768, 'banner'), { ...TABLET }),
  open('rr-tablet-810', '/', STABLE(810, 'banner'), { width: 810, height: 1080, mobile: true }),
  open('rr-tablet-1024', '/', STABLE(1024, 'docked'), { width: 1024, height: 768, mobile: true }),
  open('rr-desktop-375', '/', STABLE(375, 'banner'), { width: 375, height: 812 }),
  open('rr-history-768', '/history', STABLE(768, 'banner'), { ...TABLET }),
  // R2: a run while it streams (no gate) at 1024 and 768, then gate A at common laptop sizes and on a tablet.
  open('rr-run-1024', '/?new=1&demo=play', String.raw`
    const send = need(await until(() => { const node = $('form.chat-compose button.compose-send'); return node && !node.disabled ? node : null; }, 8000), 'send is not available');
    send.click();
    need(await until(() => chatId(), 8000), 'sending did not open the new chat');
    need(await until(() => stageNow() === 'architecture', 8000), 'the architecture stage did not start');
    await sleep(2500);` + STABLE(1024, 'docked'), { width: 1024, height: 768, ...LIVE }),
  at('rr-run-768', String.raw`await sleep(800);` + STABLE(768, 'banner'), { ...TABLET }),
  at('rr-gate-a-1366', String.raw`
    need(await until(() => $('.gate-wrap[data-gate="A"] [data-gate-confirm]'), 90000), 'gate A card did not appear');
    window.__mawbDemo.setSpeed(1);
    await sleep(700);` + GATE_LINE + String.raw`
    need($('.mawb-demo-pill').dataset.place === 'docked', 'the pill is not docked at 1366');
    return { pill: pill(), ...state() };`, { width: 1366, height: 768 }),
  // R3: after a reload at the gate, the pill shows the countdown again (it is installed before the chat mock).
  at('rr-gate-a-reload', RELOAD, { width: 1366, height: 768, after: 4000 }),
  at('rr-gate-a-after-reload', String.raw`
    need(await until(() => $('.gate-wrap[data-gate="A"] [data-gate-confirm]'), 10000), 'gate A card is gone after the reload');
    need(await until(() => $('.mawb-demo-pill .mdp-gate:not([hidden])'), 4000), 'the gate countdown is hidden after the reload');` + GATE_LINE + String.raw`
    return { pill: pill(), ...state() };`, { width: 1366, height: 768 }),
  at('rr-gate-a-1440', String.raw`await sleep(600);` + GATE_LINE + String.raw` return pill();`, { width: 1440, height: 900 }),
  at('rr-gate-a-1024', String.raw`await sleep(600);` + GATE_LINE + String.raw` return pill();`, { width: 1024, height: 768 }),
  at('rr-gate-a-768', String.raw`await sleep(600);` + GATE_LINE + String.raw`
    need($('.mawb-demo-pill').dataset.place === 'banner', 'the pill is not the banner at 768');
    return pill();`, { ...TABLET }),
  // R6: stopping while a tool call is in flight settles that call, also after a reload.
  at('rr-stop-mid-tool', String.raw`
    window.__mawbDemo.setSpeed(4);
    need($('.gate-wrap[data-gate="A"] [data-gate-confirm]'), 'gate A was decided before the stop test').click();
    need(await until(() => stageNow() === 'implementation', 10000), 'the implementation stage did not start');
    need(await until(() => $$('table.acts tbody tr.kind-tool').find(row => row.innerText.includes('正在调用')), 30000, 50), 'no tool call in flight');
    need($('.compose-stop'), 'no stop button').click();
    need(await until(async () => (await snapshot()).chat.tasks.every(task => task.status !== 'running' && task.status !== 'queued'), 8000), 'the run did not stop');
    await sleep(1500);` + NO_RUNNING_TOOL + String.raw`
    return state();`, { ...SMALL }),
  at('rr-stop-reload', RELOAD, { ...SMALL, after: 4000 }),
  at('rr-stop-after-reload', String.raw`
    need(await until(() => $('table.acts tbody tr.kind-tool'), 8000), 'no tool rows after the reload');
    await sleep(800);` + NO_RUNNING_TOOL + String.raw`
    ` + CLEAR_SPEED + String.raw`
    return state();`, { ...SMALL }),
  // R4: two runs at once. The pill shows only the gate of the run on screen.
  open('rr-two-runs', '/?new=1&demo=play', String.raw`
    const gates = new Map();
    window.addEventListener('mawb-demo:gate', event => { if (event.detail.gate) gates.set(event.detail.chatId, event.detail.gate); else gates.delete(event.detail.chatId); });
    const first = need(await until(() => { const node = $('form.chat-compose button.compose-send'); return node && !node.disabled ? node : null; }, 8000), 'send is not available');
    first.click();
    const one = need(await until(() => chatId(), 8000), 'the first run did not open');
    await sleep(3000);
    need($('.mawb-demo-pill .mdp-play'), 'no ▶ in the pill').click();
    const second = need(await until(() => { const node = $('form.chat-compose button.compose-send'); return !chatId() && node && !node.disabled && $('form.chat-compose textarea').value ? node : null; }, 8000), 'the second run was not prefilled');
    second.click();
    const two = need(await until(() => chatId() && chatId() !== one ? chatId() : null, 8000), 'the second run did not open');
    // The pill follows engine events at once and the rail follows them a render later, so a mismatch counts only when
    // two samples 200 ms apart both show it.
    const seen = { otherGateWhileViewedRuns: 0, viewedGateAfterOtherDecided: 0 };
    const wrong = [];
    const end = Date.now() + 70000;
    let viewedGateSeen = false;
    let previousBad = null;
    while (Date.now() < end) {
      const stage = stageNow() ?? '';
      const shown = pill();
      const confirm = Boolean($('.gate-wrap[data-gate="A"] [data-gate-confirm]'));
      let bad = null;
      if (!/^gate-/.test(stage)) {
        if (/关卡 [AB]/.test(shown)) bad = stage + ' with a countdown: ' + shown;
        if (gates.has(one)) seen.otherGateWhileViewedRuns += 1;
      } else if (stage === 'gate-a' && confirm) {
        viewedGateSeen = true;
        if (!/关卡 A/.test(shown)) bad = 'gate-a without a countdown: ' + shown;
        if (!gates.has(one)) seen.viewedGateAfterOtherDecided += 1;
      }
      if (bad && previousBad) wrong.push(bad);
      previousBad = bad;
      if (viewedGateSeen && stage === 'implementation') break;
      await sleep(200);
    }
    need(!wrong.length, 'the pill showed the wrong gate: ' + wrong.slice(0, 3).join(' / '));
    need(viewedGateSeen, 'the viewed run never reached gate A');
    need(seen.otherGateWhileViewedRuns + seen.viewedGateAfterOtherDecided > 0, 'the two runs never overlapped at a gate');
    return { one, two, ...seen };`, { ...SMALL, ...LIVE }),
  // R7: a reload keeps the creation time and the speed chosen on the pill.
  open('rr-speed-before-reload', '/?new=1&demo=play', String.raw`
    const send = need(await until(() => { const node = $('form.chat-compose button.compose-send'); return node && !node.disabled ? node : null; }, 8000), 'send is not available');
    send.click();
    need(await until(() => chatId(), 8000), 'sending did not open the run');
    need($('.mawb-demo-pill [data-speed="4"]'), 'no 4× button').click();
    await sleep(8000);
    const snap = await snapshot();
    sessionStorage.setItem('rr-before', JSON.stringify({ id: chatId(), createdAt: snap.chat.createdAt, first: snap.messages[0].createdAt, seq: snap.chat.seq }));
    ` + RELOAD, { ...SMALL, after: 4000 }),
  at('rr-speed-after-reload', String.raw`
    const before = JSON.parse(sessionStorage.getItem('rr-before'));
    need(chatId() === before.id, 'the reload opened another chat');
    const snap = await snapshot();
    need(snap.chat.createdAt === before.createdAt, 'createdAt moved: ' + before.createdAt + ' -> ' + snap.chat.createdAt);
    need(snap.messages[0].createdAt === before.first, 'the first message time moved: ' + before.first + ' -> ' + snap.messages[0].createdAt);
    need($('.mawb-demo-pill [data-speed="4"]').getAttribute('aria-pressed') === 'true', 'the speed is not 4× after the reload');
    ` + CLEAR_SPEED + String.raw`
    sessionStorage.removeItem('rr-before');
    return { before, after: { createdAt: snap.chat.createdAt, seq: snap.chat.seq } };`, { ...SMALL }),
  // R8: a layout pass keeps keyboard focus in the pill.
  open('rr-focus', '/', String.raw`
    const two = need($('.mawb-demo-pill [data-speed="2"]'), 'no 2× button');
    two.focus();
    window.dispatchEvent(new CustomEvent('mawb-demo:gate', { detail: { chatId: 'focus-check', gate: 'A', autoAt: Date.now() + 20000 } }));
    window.dispatchEvent(new Event('resize'));
    await sleep(600);
    need(document.activeElement === two, 'focus left 2× after a layout pass: ' + (document.activeElement?.className || document.activeElement?.tagName));
    window.dispatchEvent(new CustomEvent('mawb-demo:gate', { detail: { chatId: 'focus-check', gate: null } }));
    const play = $('.mawb-demo-pill .mdp-play');
    play.focus();
    play.click();
    await sleep(900);
    need(document.activeElement === play || document.activeElement === $('.mawb-demo-pill .mdp-more'), 'focus left the pill after ▶: ' + (document.activeElement?.className || document.activeElement?.tagName));
    return 'focus kept';`, { ...SMALL }),
  at('rr-focus-resized', String.raw`
    await sleep(600);
    const active = document.activeElement;
    need(active && $('.mawb-demo-pill').contains(active), 'focus left the pill after the viewport changed: ' + (active?.className || active?.tagName));
    return active.className;`, { width: 1320, height: 720 }),
  // R5: an unknown chat explains the demo instead of claiming a damaged record.
  open('rr-unknown-chat', '/?chat=chat-doesnotexist', String.raw`
    need(await until(() => text().includes('只保存在开始它的那个浏览器标签页里'), 8000), 'no demo explanation for an unknown chat');
    need(!text().includes('记录损坏'), 'the page still says 记录损坏');
    return flat($('[role=alert]')?.innerText ?? '').slice(0, 160);`, { ...SMALL }),
  // R9: an unknown run shows the disconnected state, not 实时同步.
  open('rr-unknown-run', '/runs/nope', String.raw`
    need(await until(() => text().includes('不存在'), 8000), 'no not-found message');
    await sleep(1200);
    const conn = flat($('.run-conn')?.innerText);
    need(!conn.includes('实时同步') && !flat($('.run-sb')?.innerText).includes('实时同步'), 'an unknown run reads 实时同步');
    return conn;`, { ...SMALL }),
  // L5: no download link carries an /api/ href; before a context menu its href becomes a blob: URL of the file.
  open('rr-run-links', `/runs/${RUNS.completed}`, String.raw`
    need(await until(() => $('#tab-deliverables'), 10000), 'no deliverables tab').click();
    await sleep(1500);
    const leaking = $$('a[href]').filter(node => new URL(node.href, location.href).pathname.includes('/api/'));
    need(!leaking.length, 'links that would request /api/: ' + leaking.map(node => node.getAttribute('href')).join(', '));
    const exportLink = need($('a[data-demo-href$="/export"]'), 'no export link');
    exportLink.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    need(await until(() => exportLink.href.startsWith('blob:'), 4000), 'the export link has no blob: URL before a context menu');
    const body = await (await fetch(exportLink.href)).text();
    need(body.length > 200, 'the export blob is empty');
    return { links: $$('a[data-demo-href]').length, exportBytes: body.length };`, { ...SMALL }),
  // C3, C4, C8 in the delivered RoomDesk app.
  open('rr-roomdesk-default-slot', null, String.raw`
    await until(() => $$('#floor-tabs [role=tab]').length);
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    const today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    const date = $('#f-date').value;
    const [h, m] = $('#f-start').value.split(':').map(Number);
    need(date > today || h * 60 + m >= minutes, 'the default slot is in the past: ' + date + ' ' + $('#f-start').value);
    need(!$('#check').classList.contains('is-conflict'), 'the default slot opens in conflict');
    const weekend = now.getDay() === 0 || now.getDay() === 6;
    const mine = flat($('#mine-list')?.innerText);
    if (!weekend) need(!/周六|周日/.test(mine), 'a sample booking falls on a weekend: ' + mine);
    localStorage.setItem('roomdesk:v1:state', '{"version":1,"bookings":[{"id":"x1","roomId":"r203"');
    setTimeout(() => location.reload(), 100);
    return { date, start: $('#f-start').value, mine: mine.slice(0, 160) };`, { ...SMALL, path: 'demo-project/index.html', mountSelector: '#floor-tabs > *', after: 3000 }),
  at('rr-roomdesk-damaged-storage', String.raw`
    await until(() => $$('#floor-tabs [role=tab]').length);
    need(flat($('#storage-note').innerText).includes('无法读取'), 'no notice for damaged storage: ' + flat($('#storage-note').innerText));
    $$('#floor-tabs [role=tab]')[1].click();
    await sleep(300);
    need(localStorage.getItem('roomdesk:v1:state') === '{"version":1,"bookings":[{"id":"x1","roomId":"r203"', 'a floor-tab click overwrote the stored data');
    localStorage.removeItem('roomdesk:v1:state');
    localStorage.removeItem('roomdesk:v1:prefs');
    return flat($('#storage-note').innerText);`, { ...SMALL, mountSelector: '#floor-tabs > *' }),
  // C7: answering the README question with option 3 translates two sections, not five.
  open('rr-readme-reset', `/?chat=${SAMPLE_CHATS.readme}`, String.raw`
    // The chat mock saves every chat on pagehide; this listener runs after it, so the reload rebuilds the sample unanswered.
    window.addEventListener('pagehide', () => sessionStorage.removeItem('mawb-demo:chats:v1'));
    ` + RELOAD, { ...SMALL, ...LIVE, after: 4000 }),
  at('rr-readme-partial', String.raw`
    const option = need(await until(() => $$('.question-options button')[2], 8000), 'no third option');
    option.click();
    need(await until(() => text().includes('其余章节保持中文'), 30000), 'the scripted reply did not arrive');
    const snap = await snapshot();
    const hydrogen = need(snap.chat.tasks.find(task => task.role === 'hydrogen'), 'no Hydrogen task');
    need(hydrogen.result.includes('已翻译 2 节') && !hydrogen.result.includes('5 节'), 'Hydrogen reports the wrong section count: ' + hydrogen.result);
    return hydrogen.result;`, { ...SMALL, ...LIVE }),
];

export const STEPS = [...welcome, ...liveRun, ...samples, ...runs, ...system, ...unattended, ...review];
