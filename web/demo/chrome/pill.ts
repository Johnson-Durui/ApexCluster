// The demo pill (README.md "Demo chrome"): a small floating label and control strip, vanilla DOM, outside the React
// tree. It says that everything is preset data, starts the scripted demo, sets the playback speed, links to the
// delivered RoomDesk app and the repository, and shows the gate countdown of the chat on screen.
//
// Placement (data-place on the pill). The pill is always position:fixed, so it never adds to the document's
// scrollable width (on a phone that would widen the layout viewport and start a resize loop).
// - docked: on the shell's 28px status bar, over its empty middle (`.sb-grow`), right-aligned against the usage
//   cells. That region holds no content, so the pill never covers the composer, the send button, the gate card, the
//   map controls or any status cell. When the gap is too narrow, lower-priority controls move into a "⋯" menu that
//   opens upwards (GitHub, then 交付成品, then the speed switch, then the label tail, then ▶ 播放), and a waiting
//   gate is shortened to "关卡 A · 18 秒" (the full text stays in the title and in the menu).
// - banner: below 900 px of viewport width, or when even the shortest docked pill does not fit the gap, the pill
//   becomes a 26px strip at the top of the viewport and the app frame moves down by 26px, so it covers nothing.
// - corner: before the shell has mounted, the pill waits in the bottom-right corner.
// A layout pass keeps keyboard focus: controls already in place are not moved, and a focused control that had to move
// is focused again (or the "⋯" button takes the focus when the control went into the closed menu).
//
// Interfaces for the other demo modules:
// - window.__mawbDemo = { toast(text), setSpeed(n) }.
// - window event 'mawb-demo:gate' (CustomEvent<MawbDemoGateDetail>): { chatId, gate, autoAt? }. gate null clears that
//   chat's countdown; autoAt is the wall-clock time (Date.now() scale) at which the engine confirms by itself. The pill
//   shows only the gate of the chat in location.hash (#/?chat=<id>). main.ts installs the pill before the chat mock,
//   so the announcements that rebuilt chats make while the mock installs are not lost.
// The pill is not rendered when location.search contains shots=1 (screenshot mode); the API still exists there,
// toast() does nothing and setSpeed() still changes the clock.
import './pill.css';
import { getSpeed, onSpeed, setSpeed, type Speed } from '../mock/clock';

const STORAGE_KEY = 'mawb-demo:pill';
const PLAY_HASH = '#/?new=1&demo=play';
const PRODUCT_URL = './demo-project/index.html';
const REPO_URL = 'https://github.com/Johnson-Durui/ApexCluster';
const LABEL_HEAD = '在线演示';
const LABEL_TAIL = ' · 预设数据，不调用任何模型';
const TOAST_MS = 4200;
const SPEEDS: readonly Speed[] = [1, 2, 4];
/** Space kept free between the pill and the status cells on either side. */
const GAP = 10;
const PILL_H = 22;
/** Below this viewport width the status bar has no usable gap, so the pill is a banner at the top. */
const BANNER_BELOW = 900;
/** Side padding of the banner (pill.css) plus a safety margin. */
const BANNER_INSET = 16;
/** Seconds shown while measuring, so a countdown that loses a digit never makes the pill wider than measured. */
const WIDEST_SECONDS = 20;

type Place = 'corner' | 'docked' | 'banner';

function readCollapsed(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) === 'collapsed'; } catch { return false; }
}

function writeCollapsed(collapsed: boolean): void {
  try { localStorage.setItem(STORAGE_KEY, collapsed ? 'collapsed' : 'open'); } catch { /* storage unavailable */ }
}

function isShotsMode(): boolean {
  try { return new URLSearchParams(location.search).get('shots') === '1'; } catch { return false; }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, text: string, title: string): HTMLButtonElement {
  const node = element('button', className, text);
  node.type = 'button';
  node.title = title;
  return node;
}

function link(text: string, href: string, title: string, rel: string): HTMLAnchorElement {
  const node = element('a', 'mdp-link', text);
  node.href = href;
  node.target = '_blank';
  node.rel = rel;
  node.title = title;
  return node;
}

interface Gate { gate: 'A' | 'B'; autoAt?: number }

/** Seconds until the engine confirms, or null when the gate has no deadline. */
function secondsLeft(gate: Gate): number | null {
  if (gate.autoAt === undefined || !Number.isFinite(gate.autoAt)) return null;
  return Math.ceil((gate.autoAt - Date.now()) / 1000);
}

/** The gate line. `widest` uses a two-digit countdown (for measuring). */
function gateText(gate: Gate, compact: boolean, widest = false): string {
  const seconds = widest && gate.autoAt !== undefined ? WIDEST_SECONDS : secondsLeft(gate);
  if (compact) {
    if (seconds === null) return `关卡 ${gate.gate} · 等你确认`;
    return seconds > 0 ? `关卡 ${gate.gate} · ${seconds} 秒` : `关卡 ${gate.gate} · 确认中`;
  }
  const head = `关卡 ${gate.gate} 等待你确认`;
  if (seconds === null) return head;
  return seconds > 0 ? `${head} · ${seconds} 秒后自动确认` : `${head} · 正在自动确认`;
}

/** The composer's send button when the product shows one that can be pressed. */
function sendButton(): HTMLButtonElement | null {
  const node = document.querySelector<HTMLButtonElement>('form.chat-compose button.compose-send');
  return node && !node.disabled ? node : null;
}

function composerHasText(): boolean {
  const input = document.querySelector<HTMLTextAreaElement>('form.chat-compose textarea');
  return Boolean(input && input.value.trim());
}

function hashParams(): URLSearchParams {
  return new URLSearchParams(location.hash.split('?')[1] ?? '');
}

function isPlayRoute(): boolean {
  const params = hashParams();
  return params.get('demo') === 'play' && !params.get('chat');
}

/** The chat on screen (#/?chat=<id>), or null on any other page. */
function viewedChatId(): string | null {
  return hashParams().get('chat');
}

/** Viewport width without a vertical scrollbar (the containing block of a fixed element). */
function viewportWidth(): number {
  return document.documentElement.clientWidth || window.innerWidth;
}

let installed = false;

/** Builds the pill and exposes window.__mawbDemo. Safe to call more than once. */
export function installPill(): void {
  if (installed) return;
  installed = true;
  let showToast: (text: string) => void = () => undefined;
  window.__mawbDemo = {
    toast: text => showToast(text),
    setSpeed: value => setSpeed(value),
  };
  if (isShotsMode()) return;

  // ---------------------------------------------------------------- DOM
  const root = element('aside', 'mawb-demo-pill');
  root.setAttribute('aria-label', '在线演示');
  root.dataset.collapsed = readCollapsed() ? 'true' : 'false';
  root.dataset.place = 'corner';

  const badge = element('span', 'mdp-badge');
  const dot = element('i', 'mdp-dot');
  dot.setAttribute('aria-hidden', 'true');
  // One inline label (not two flex items), so its text reads as one phrase to screen readers and innerText.
  const label = element('span', 'mdp-label');
  const labelHead = element('b', 'mdp-label-head', LABEL_HEAD);
  const labelTail = element('span', 'mdp-label-tail', LABEL_TAIL);
  label.append(labelHead, labelTail);
  badge.append(dot, label);

  const gateLine = element('span', 'mdp-gate');
  gateLine.setAttribute('role', 'status');
  gateLine.hidden = true;

  const play = button('mdp-btn mdp-play', '▶ 播放完整演示', '打开新聊天并填入预设需求，按发送即开始');
  const send = button('mdp-btn mdp-send', '发送 ↵', '发送已填入的预设需求');
  send.hidden = true;

  const speedGroup = element('span', 'mdp-speed');
  speedGroup.setAttribute('role', 'group');
  speedGroup.setAttribute('aria-label', '播放速度');
  const speedButtons = SPEEDS.map(value => {
    const node = button('mdp-speed-btn', `${value}×`, `${value} 倍速播放`);
    node.dataset.speed = String(value);
    node.addEventListener('click', () => setSpeed(value));
    speedGroup.append(node);
    return node;
  });

  const product = link('交付成品 ↗', PRODUCT_URL, '在新标签页打开演示交付的会议室预约工具', 'noopener');
  const repo = link('GitHub ↗', REPO_URL, '在新标签页打开项目仓库', 'noopener noreferrer');

  const body = element('span', 'mdp-body');
  /** Controls in display order. Each one leaves the strip for the menu when the gap is too narrow. */
  const movable: HTMLElement[] = [play, speedGroup, product, repo];
  /** Which movable controls leave first. */
  const dropOrder: HTMLElement[] = [repo, product, speedGroup, play];
  body.append(send, ...movable);

  const more = button('mdp-more', '⋯', '更多演示控制');
  more.setAttribute('aria-haspopup', 'true');
  more.setAttribute('aria-expanded', 'false');
  more.hidden = true;

  const toggle = button('mdp-toggle', '', '');
  const toggleGlyph = element('span', 'mdp-toggle-glyph');
  toggleGlyph.setAttribute('aria-hidden', 'true');
  toggle.append(toggleGlyph);

  const menu = element('div', 'mdp-menu');
  menu.setAttribute('role', 'group');
  menu.setAttribute('aria-label', '更多演示控制');
  menu.hidden = true;
  const menuHead = element('p', 'mdp-menu-head', `${LABEL_HEAD}${LABEL_TAIL}`);
  const menuGate = element('p', 'mdp-menu-gate');
  menuGate.hidden = true;
  const menuItems = element('div', 'mdp-menu-items');
  menu.append(menuHead, menuGate, menuItems);

  const bubble = element('div', 'mdp-toast');
  bubble.setAttribute('role', 'status');
  bubble.setAttribute('aria-live', 'polite');
  bubble.hidden = true;

  root.append(badge, gateLine, body, more, toggle, menu, bubble);
  /** The full-width background of the banner placement (the pill itself stays pill-sized, so it can be measured). */
  const strip = element('div', 'mawb-demo-strip');
  strip.setAttribute('aria-hidden', 'true');
  strip.hidden = true;

  // ---------------------------------------------------------------- gate state (rendered by renderGate below)
  /** Waiting gates by chat id; the pill shows the one of the chat on screen. */
  const gates = new Map<string, Gate>();
  /** Set by layout(): the gate line uses its short form. */
  let gateCompact = false;
  const currentGate = (): Gate | null => {
    const id = viewedChatId();
    return id ? gates.get(id) ?? null : null;
  };

  // ---------------------------------------------------------------- placement
  let grow: HTMLElement | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let frame = 0;
  const scheduleLayout = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; layout(); });
  };

  const findGrow = (): HTMLElement | null => document.querySelector<HTMLElement>('.app-status > .sb-grow');
  const attach = () => {
    const next = findGrow();
    if (next === grow) return;
    resizeObserver?.disconnect();
    grow = next;
    if (grow) {
      resizeObserver = new ResizeObserver(scheduleLayout);
      resizeObserver.observe(grow);
      const bar = grow.parentElement;
      if (bar) resizeObserver.observe(bar);
    }
    scheduleLayout();
  };

  const closeMenu = () => {
    menu.hidden = true;
    more.setAttribute('aria-expanded', 'false');
  };

  /** Puts every movable control back into the strip in display order, moving only the ones that are not in place. */
  const restoreAll = () => {
    let previous: Element = send;
    for (const node of movable) {
      if (node.parentElement !== body || node.previousElementSibling !== previous) previous.after(node);
      previous = node;
    }
    labelTail.hidden = root.dataset.collapsed === 'true';
  };

  /** Writes the gate line for the measuring pass (widest text) or for display. */
  const writeGate = (widest: boolean) => {
    const gate = currentGate();
    gateLine.hidden = !gate;
    root.dataset.gate = gate?.gate ?? '';
    if (!gate) {
      gateLine.textContent = '';
      gateLine.removeAttribute('title');
      menuGate.hidden = true;
      return;
    }
    const full = gateText(gate, false, widest);
    gateLine.textContent = gateCompact ? gateText(gate, true, widest) : full;
    gateLine.title = gateText(gate, false);
    gateLine.setAttribute('aria-label', gateText(gate, false));
    menuGate.textContent = gateText(gate, false);
    menuGate.hidden = !gateCompact;
  };

  /**
   * Moves controls into the menu (and shortens the gate line) until the pill is at most `available` px wide.
   * Returns the final width.
   */
  const fit = (available: number, collapsed: boolean): number => {
    gateCompact = false;
    writeGate(true);
    more.hidden = true;
    const dropped: HTMLElement[] = [];
    let width = root.offsetWidth;
    if (!collapsed) {
      for (const node of dropOrder) {
        if (width <= available) break;
        if (node === play && !labelTail.hidden) {
          // The label tail goes before ▶ 播放完整演示 (the menu head repeats the full label).
          labelTail.hidden = true;
          more.hidden = false;
          width = root.offsetWidth;
          if (width <= available) break;
        }
        dropped.push(node);
        node.remove();
        more.hidden = false;
        width = root.offsetWidth;
      }
    }
    if (width > available && !gateLine.hidden) {
      gateCompact = true;
      writeGate(true);
      if (!collapsed) more.hidden = false;
      width = root.offsetWidth;
    }
    for (const node of movable) if (dropped.includes(node)) menuItems.append(node);
    if (!menuItems.childElementCount && (labelTail.hidden || gateCompact) && !collapsed) more.hidden = false;
    return width;
  };

  const setPlace = (place: Place) => {
    root.dataset.place = place;
    strip.hidden = place !== 'banner';
    if (place === 'banner') document.documentElement.dataset.mawbBanner = 'true';
    else delete document.documentElement.dataset.mawbBanner;
  };

  const layout = () => {
    const active = document.activeElement;
    const focused = active instanceof HTMLElement && root.contains(active) ? active : null;
    if (!grow?.isConnected) attach();
    const collapsed = root.dataset.collapsed === 'true';
    const viewport = viewportWidth();
    restoreAll();
    body.hidden = collapsed;
    root.style.left = '';
    root.style.right = '';
    root.style.top = '';

    let place: Place = !grow ? 'corner' : viewport < BANNER_BELOW ? 'banner' : 'docked';
    if (place === 'docked' && grow) {
      setPlace('docked');
      const rect = grow.getBoundingClientRect();
      const bar = grow.parentElement?.getBoundingClientRect() ?? rect;
      const right = Math.min(rect.right - (rect.right >= bar.right - 1 ? GAP + 2 : GAP), viewport - GAP);
      const left = Math.max(rect.left + GAP, GAP);
      const available = Math.max(0, right - left);
      const width = fit(available, collapsed);
      if (width <= available) {
        root.style.right = `${Math.round(viewport - right)}px`;
        root.style.top = `${Math.round(bar.top + (bar.height - PILL_H) / 2)}px`;
      } else {
        place = 'banner';
        restoreAll();
      }
    }
    if (place !== 'docked') {
      setPlace(place);
      fit(Math.max(0, viewport - (place === 'banner' ? BANNER_INSET : 24)), collapsed);
    }
    writeGate(false);
    if (more.hidden) closeMenu();

    if (focused && document.activeElement !== focused) {
      const visible = focused.isConnected && !focused.closest('[hidden]');
      const target = visible ? focused : !more.hidden ? more : null;
      target?.focus({ preventScroll: true });
    }
  };

  // The status bar mounts with the React shell, after this runs; watch for it once, then keep checking it is
  // still the same element (it is not expected to remount).
  const mountWatch = new MutationObserver(() => {
    if (!findGrow()) return;
    mountWatch.disconnect();
    attach();
  });
  mountWatch.observe(document.body, { childList: true, subtree: true });
  setInterval(() => { if (!grow?.isConnected && findGrow()) attach(); }, 2000);
  window.addEventListener('resize', scheduleLayout);

  // ---------------------------------------------------------------- collapse and menu
  const renderCollapse = () => {
    const collapsed = root.dataset.collapsed === 'true';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? '展开演示控制' : '收起演示控制');
    toggle.title = collapsed ? '展开演示控制' : '收起演示控制';
    toggleGlyph.textContent = collapsed ? '‹' : '›';
    if (collapsed) closeMenu();
    scheduleLayout();
  };
  toggle.addEventListener('click', () => {
    const collapsed = root.dataset.collapsed !== 'true';
    root.dataset.collapsed = String(collapsed);
    writeCollapsed(collapsed);
    renderCollapse();
  });
  more.addEventListener('click', () => {
    const open = menu.hidden;
    menu.hidden = !open;
    more.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('pointerdown', event => {
    if (!menu.hidden && event.target instanceof Node && !root.contains(event.target)) closeMenu();
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !menu.hidden) { closeMenu(); more.focus(); }
  });
  renderCollapse();

  // ---------------------------------------------------------------- speed
  const renderSpeed = (current: Speed) => {
    for (const node of speedButtons) node.setAttribute('aria-pressed', String(Number(node.dataset.speed) === current));
  };
  onSpeed(renderSpeed);
  renderSpeed(getSpeed());

  // ---------------------------------------------------------------- play and the one-shot send offer
  let sendOffered = false;
  let sendTimer: ReturnType<typeof setInterval> | undefined;
  const renderSend = () => {
    if (sendOffered && !isPlayRoute()) sendOffered = false;
    const visible = sendOffered && composerHasText() && Boolean(sendButton());
    if (send.hidden === visible) {
      send.hidden = !visible;
      scheduleLayout();
    }
    if (!sendOffered && sendTimer !== undefined) {
      clearInterval(sendTimer);
      sendTimer = undefined;
    }
  };
  play.addEventListener('click', () => {
    closeMenu();
    sendOffered = true;
    if (location.hash === PLAY_HASH) {
      // Already on the prefilled route: the product's own Welcome link fills the composer again.
      document.querySelector<HTMLButtonElement>('.welcome-demo-link')?.click();
    } else {
      location.hash = PLAY_HASH;
    }
    if (sendTimer === undefined) sendTimer = setInterval(renderSend, 300);
    renderSend();
  });
  send.addEventListener('click', () => {
    const target = sendButton();
    sendOffered = false;
    renderSend();
    if (target) target.click();
    else showToast('请先在输入框中确认预设需求，再按发送。');
  });
  window.addEventListener('hashchange', renderSend);

  // ---------------------------------------------------------------- gate countdown
  let gateTimer: ReturnType<typeof setInterval> | undefined;
  const renderGate = () => {
    const wasHidden = gateLine.hidden;
    writeGate(false);
    if (!gates.size && gateTimer !== undefined) { clearInterval(gateTimer); gateTimer = undefined; }
    if (wasHidden !== gateLine.hidden) scheduleLayout();
  };
  window.addEventListener('mawb-demo:gate', event => {
    const detail = event.detail as MawbDemoGateDetail | undefined;
    if (!detail || typeof detail.chatId !== 'string') return;
    if (detail.gate === 'A' || detail.gate === 'B') gates.set(detail.chatId, { gate: detail.gate, autoAt: detail.autoAt });
    else gates.delete(detail.chatId);
    renderGate();
    scheduleLayout();
    if (gates.size && gateTimer === undefined) gateTimer = setInterval(renderGate, 250);
  });
  window.addEventListener('hashchange', () => { renderGate(); scheduleLayout(); });

  // ---------------------------------------------------------------- toast
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  showToast = (text: string) => {
    bubble.textContent = text;
    bubble.hidden = false;
    if (toastTimer !== undefined) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      bubble.hidden = true;
      toastTimer = undefined;
    }, TOAST_MS);
  };

  document.body.append(strip, root);
  attach();
}
