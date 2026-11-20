/**
 * 架构图：由方案记录（modules + flows）确定性生成。
 * - Mermaid 文本：给网页界面（mermaid 本地打包渲染）和 Markdown 导出用；
 * - SVG：给 PRD / 架构手册的独立 HTML（打印成 PDF 时不依赖任何脚本或外部资源）。
 * 图与文字来自同一条记录 —— 不让模型直接写图，避免图文不一致。
 */
import type { ProposalOut } from './schemas.js';

type DiagramInput = Pick<ProposalOut, 'modules' | 'flows'>;

function esc(text: string): string {
  return text
    .replace(/"/g, '#quot;')
    .replace(/</g, '#lt;')
    .replace(/>/g, '#gt;')
    .replace(/`/g, "'")
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

function edgeLabel(text: string): string {
  return esc(text).replace(/\|/g, '/').slice(0, 60);
}

export function proposalToMermaid(p: DiagramInput, direction: 'LR' | 'TB' = 'LR'): string {
  const lines: string[] = [`flowchart ${direction}`];
  const nodeId = new Map<string, string>();
  p.modules.forEach((m, i) => {
    const nid = `n${i + 1}`;
    nodeId.set(m.id, nid);
    const label = m.tech ? `${esc(m.name)}<br/><small>${esc(m.tech)}</small>` : esc(m.name);
    lines.push(`  ${nid}["${label}"]`);
  });
  let missing = 0;
  const ensure = (id: string): string => {
    const existing = nodeId.get(id);
    if (existing) return existing;
    const nid = `x${++missing}`;
    nodeId.set(id, nid);
    lines.push(`  ${nid}["未定义模块：${esc(id)}"]:::missing`);
    return nid;
  };
  for (const f of p.flows) {
    const a = ensure(f.from);
    const b = ensure(f.to);
    const arrow = f.kind === 'data' ? '-.->' : f.kind === 'event' ? '==>' : '-->';
    lines.push(f.label.trim() ? `  ${a} ${arrow}|"${edgeLabel(f.label)}"| ${b}` : `  ${a} ${arrow} ${b}`);
  }
  if (missing) lines.push('  classDef missing stroke-dasharray: 5 5,stroke:#c00;');
  return lines.join('\n');
}

// =====================================================================================
// SVG（分层布局）
// =====================================================================================

/** 粗略估算文字宽度（像素）：中日韩及全角字符按 1em，其余按 0.55em 左右 */
export function textWidth(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x2e80 || (code >= 0x1100 && code <= 0x115f)) w += fontSize;
    else if (ch === ' ') w += fontSize * 0.32;
    else if (/[A-Z0-9MWmw@%&]/.test(ch)) w += fontSize * 0.64;
    else w += fontSize * 0.52;
  }
  return Math.ceil(w);
}

function truncate(text: string, fontSize: number, maxWidth: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (textWidth(clean, fontSize) <= maxWidth) return clean;
  let out = '';
  for (const ch of clean) {
    if (textWidth(`${out}${ch}…`, fontSize) > maxWidth) break;
    out += ch;
  }
  return `${out}…`;
}

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export interface DiagramNode {
  id: string;
  name: string;
  tech: string | null;
  missing: boolean;
  layer: number;
  order: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DiagramEdge {
  /** 图上的编号（从 1 开始，与流程表一致） */
  n: number;
  from: string;
  to: string;
  kind: 'call' | 'data' | 'event';
  label: string;
  /**
   * forward：相邻两层之间的普通连线；
   * over：反向或同层的边，从节点上方绕行；
   * under：跨过中间层的边，从节点下方绕行（避免穿过中间的模块）；
   * self：模块指向自己。
   */
  route: 'forward' | 'over' | 'under' | 'self';
}

export interface DiagramLayout {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  width: number;
  height: number;
}

const NAME_FONT = 13;
const TECH_FONT = 11;
const NODE_MIN_W = 96;
const NODE_MAX_TEXT_W = 190;
const PAD_X = 14;
const GAP_X = 96;
const GAP_Y = 22;
const MARGIN = 24;
const ARC_SPACE = 30;
const LEGEND_H = 30;

/** 分层：先用 DFS 找出回边（打破环），再在剩下的有向无环图上按最长路径分层 */
function assignLayers(ids: string[], edges: { from: string; to: string }[]): { layer: Map<string, number>; back: Set<number> } {
  const adj = new Map<string, { to: string; i: number }[]>(ids.map((id) => [id, []]));
  edges.forEach((e, i) => {
    if (e.from !== e.to) adj.get(e.from)?.push({ to: e.to, i });
  });
  const state = new Map<string, 1 | 2>();
  const back = new Set<number>();
  const visit = (u: string): void => {
    state.set(u, 1);
    for (const { to, i } of adj.get(u) ?? []) {
      const s = state.get(to);
      if (s === 1) back.add(i);
      else if (!s) visit(to);
    }
    state.set(u, 2);
  };
  for (const id of ids) if (!state.has(id)) visit(id);
  edges.forEach((e, i) => {
    if (e.from === e.to) back.add(i);
  });

  const layer = new Map<string, number>(ids.map((id) => [id, 0]));
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  edges.forEach((e, i) => {
    if (!back.has(i)) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  });
  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  while (queue.length) {
    const u = queue.shift()!;
    edges.forEach((e, i) => {
      if (back.has(i) || e.from !== u) return;
      layer.set(e.to, Math.max(layer.get(e.to) ?? 0, (layer.get(u) ?? 0) + 1));
      indeg.set(e.to, (indeg.get(e.to) ?? 0) - 1);
      if (indeg.get(e.to) === 0) queue.push(e.to);
    });
  }
  return { layer, back };
}

export function layoutDiagram(p: DiagramInput): DiagramLayout {
  const known = new Set(p.modules.map((m) => m.id));
  const nodes: DiagramNode[] = p.modules.map((m) => ({ id: m.id, name: m.name, tech: m.tech, missing: false, layer: 0, order: 0, x: 0, y: 0, w: 0, h: 0 }));
  for (const f of p.flows) {
    for (const id of [f.from, f.to]) {
      if (!known.has(id)) {
        known.add(id);
        nodes.push({ id, name: `未定义模块：${id}`, tech: null, missing: true, layer: 0, order: 0, x: 0, y: 0, w: 0, h: 0 });
      }
    }
  }
  const ids = nodes.map((n) => n.id);
  const { layer, back } = assignLayers(ids, p.flows);
  for (const n of nodes) {
    n.layer = layer.get(n.id) ?? 0;
    const nameW = Math.min(textWidth(n.name, NAME_FONT), NODE_MAX_TEXT_W);
    const techW = n.tech ? Math.min(textWidth(n.tech, TECH_FONT), NODE_MAX_TEXT_W) : 0;
    n.w = Math.max(NODE_MIN_W, Math.max(nameW, techW) + PAD_X * 2);
    n.h = n.tech ? 50 : 36;
  }

  // 层内排序：初始按模块顺序，然后做两轮重心排序（减少交叉）
  const layerCount = Math.max(0, ...nodes.map((n) => n.layer)) + 1;
  const byLayer: DiagramNode[][] = Array.from({ length: layerCount }, () => []);
  for (const n of nodes) byLayer[n.layer]!.push(n);
  byLayer.forEach((l) => l.forEach((n, i) => (n.order = i)));
  const forward = p.flows.filter((_, i) => !back.has(i));
  const node = (id: string) => nodes.find((n) => n.id === id)!;
  for (let pass = 0; pass < 2; pass++) {
    for (let l = 1; l < layerCount; l++) {
      const bary = (n: DiagramNode) => {
        const preds = forward.filter((e) => e.to === n.id).map((e) => node(e.from)).filter((m) => m.layer === l - 1);
        return preds.length ? preds.reduce((a, m) => a + m.order, 0) / preds.length : n.order;
      };
      const sorted = [...byLayer[l]!].sort((a, b) => bary(a) - bary(b) || a.order - b.order);
      sorted.forEach((n, i) => (n.order = i));
      byLayer[l] = sorted;
    }
    for (let l = layerCount - 2; l >= 0; l--) {
      const bary = (n: DiagramNode) => {
        const succ = forward.filter((e) => e.from === n.id).map((e) => node(e.to)).filter((m) => m.layer === l + 1);
        return succ.length ? succ.reduce((a, m) => a + m.order, 0) / succ.length : n.order;
      };
      const sorted = [...byLayer[l]!].sort((a, b) => bary(a) - bary(b) || a.order - b.order);
      sorted.forEach((n, i) => (n.order = i));
      byLayer[l] = sorted;
    }
  }

  const edges: DiagramEdge[] = p.flows.map((f, i) => {
    const lf = layer.get(f.from) ?? 0;
    const lt = layer.get(f.to) ?? 0;
    const route: DiagramEdge['route'] = f.from === f.to ? 'self' : back.has(i) || lt <= lf ? 'over' : lt - lf > 1 ? 'under' : 'forward';
    return { n: i + 1, from: f.from, to: f.to, kind: f.kind, label: f.label, route };
  });
  const overs = edges.filter((e) => e.route === 'over' || e.route === 'self').length;
  const unders = edges.filter((e) => e.route === 'under').length;
  const top = MARGIN + (overs ? ARC_SPACE + Math.min(overs, 4) * 10 : 0);
  const bottomArcs = unders ? ARC_SPACE + Math.min(unders, 4) * 10 : 0;

  const colW = byLayer.map((l) => Math.max(0, ...l.map((n) => n.w)));
  const colH = byLayer.map((l) => l.reduce((a, n) => a + n.h, 0) + GAP_Y * Math.max(0, l.length - 1));
  const innerH = Math.max(0, ...colH);
  let x = MARGIN;
  byLayer.forEach((l, li) => {
    let y = top + (innerH - colH[li]!) / 2;
    for (const n of l) {
      n.x = x + (colW[li]! - n.w) / 2;
      n.y = y;
      y += n.h + GAP_Y;
    }
    x += colW[li]! + GAP_X;
  });
  const width = Math.ceil(x - GAP_X + MARGIN);
  const height = Math.ceil(top + innerH + bottomArcs + MARGIN + LEGEND_H);
  return { nodes, edges, width: Math.max(width, 320), height };
}

const EDGE_STYLE: Record<DiagramEdge['kind'], { color: string; width: number; dash: string | null; name: string }> = {
  call: { color: '#334155', width: 1.4, dash: null, name: '调用' },
  data: { color: '#0369a1', width: 1.4, dash: '6 4', name: '数据' },
  event: { color: '#b45309', width: 2.6, dash: null, name: '事件' },
};

function cubicMid(p0: number, p1: number, p2: number, p3: number): number {
  return (p0 + 3 * p1 + 3 * p2 + p3) / 8;
}

/**
 * 生成独立 SVG（无脚本、无外部资源）。连线只画编号，文字说明放在图下方的流程表里，
 * 这样中文标签不会互相遮挡，打印时也清楚。
 */
export function proposalToSvg(p: DiagramInput, opts: { idPrefix?: string; title?: string } = {}): string {
  const L = layoutDiagram(p);
  const pre = (opts.idPrefix ?? 'dmw').replace(/[^A-Za-z0-9_-]/g, '');
  const title = opts.title ?? '架构图';
  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${L.width} ${L.height}" width="${L.width}" height="${L.height}" role="img" aria-label="${xml(title)}" font-family="'Microsoft YaHei','PingFang SC','Noto Sans CJK SC',system-ui,sans-serif">`,
  );
  out.push(`<title>${xml(title)}</title>`);
  out.push('<defs>');
  for (const [kind, st] of Object.entries(EDGE_STYLE)) {
    out.push(`<marker id="${pre}-arrow-${kind}" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${st.color}"/></marker>`);
  }
  out.push('</defs>');
  out.push(`<rect x="0" y="0" width="${L.width}" height="${L.height}" fill="#ffffff"/>`);

  const byId = new Map(L.nodes.map((n) => [n.id, n]));
  const pairCount = new Map<string, number>();
  const badges: string[] = [];
  let overIndex = 0;
  let underIndex = 0;
  const inLayers = (a: number, b: number) => L.nodes.filter((n) => n.layer >= Math.min(a, b) && n.layer <= Math.max(a, b));
  const lowestBottom = (a: number, b: number) => Math.max(0, ...inLayers(a, b).map((n) => n.y + n.h));
  const highestTop = (a: number, b: number) => Math.min(L.height, ...inLayers(a, b).map((n) => n.y));
  for (const e of L.edges) {
    const a = byId.get(e.from)!;
    const b = byId.get(e.to)!;
    const st = EDGE_STYLE[e.kind];
    const key = `${e.from}->${e.to}`;
    const k = pairCount.get(key) ?? 0;
    pairCount.set(key, k + 1);
    // 同一对模块之间的多条边交替上下错开，并限制在节点高度内
    const off = Math.max(-12, Math.min(12, (k % 2 === 1 ? 1 : -1) * Math.ceil(k / 2) * 7));
    let d: string;
    let mx: number;
    let my: number;
    if (e.route === 'self') {
      // 画在节点左上角的小环，避开右侧的出边和上方中点的回边
      const x0 = a.x + 12 + off;
      const x3 = a.x + 40 + off;
      const lift = a.y - 30;
      d = `M${x0},${a.y} C${x0},${lift} ${x3},${lift} ${x3},${a.y - 2}`;
      mx = cubicMid(x0, x0, x3, x3);
      my = cubicMid(a.y, lift, lift, a.y - 2);
    } else if (e.route === 'forward') {
      const x0 = a.x + a.w;
      const y0 = a.y + a.h / 2 + off;
      const x3 = b.x - 2;
      const y3 = b.y + b.h / 2 + off;
      const dx = Math.max(36, (x3 - x0) / 2);
      d = `M${x0},${y0} C${x0 + dx},${y0} ${x3 - dx},${y3} ${x3},${y3}`;
      mx = cubicMid(x0, x0 + dx, x3 - dx, x3);
      my = cubicMid(y0, y0, y3, y3);
    } else if (e.route === 'under') {
      const x0 = a.x + a.w / 2 + off;
      const y0 = a.y + a.h;
      const x3 = b.x + b.w / 2 + off;
      const y3 = b.y + b.h + 2;
      const drop = lowestBottom(a.layer, b.layer) + 26 + (underIndex++ % 4) * 10;
      d = `M${x0},${y0} C${x0},${drop} ${x3},${drop} ${x3},${y3}`;
      mx = cubicMid(x0, x0, x3, x3);
      my = cubicMid(y0, drop, drop, y3);
    } else {
      const x0 = a.x + a.w / 2 + off;
      const y0 = a.y;
      const x3 = b.x + b.w / 2 + off;
      const y3 = b.y - 2;
      const lift = highestTop(a.layer, b.layer) - 18 - (overIndex++ % 4) * 10;
      d = `M${x0},${y0} C${x0},${lift} ${x3},${lift} ${x3},${y3}`;
      mx = cubicMid(x0, x0, x3, x3);
      my = cubicMid(y0, lift, lift, y3);
    }
    out.push(
      `<path d="${d}" fill="none" stroke="${st.color}" stroke-width="${st.width}"${st.dash ? ` stroke-dasharray="${st.dash}"` : ''} marker-end="url(#${pre}-arrow-${e.kind})"><title>${xml(`${e.n}. ${e.from} → ${e.to}（${st.name}）：${e.label}`)}</title></path>`,
    );
    badges.push(
      `<g><circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="9" fill="#ffffff" stroke="${st.color}" stroke-width="1.2"/><text x="${mx.toFixed(1)}" y="${(my + 3.8).toFixed(1)}" font-size="10.5" text-anchor="middle" fill="${st.color}">${e.n}</text></g>`,
    );
  }
  for (const n of L.nodes) {
    const stroke = n.missing ? '#be123c' : '#334155';
    const fill = n.missing ? '#fff1f2' : '#f8fafc';
    out.push(
      `<g><rect x="${n.x.toFixed(1)}" y="${n.y.toFixed(1)}" width="${n.w}" height="${n.h}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="1.3"${n.missing ? ' stroke-dasharray="5 4"' : ''}/>`,
    );
    const cx = (n.x + n.w / 2).toFixed(1);
    const name = truncate(n.name, NAME_FONT, NODE_MAX_TEXT_W);
    if (n.tech) {
      out.push(`<text x="${cx}" y="${(n.y + 21).toFixed(1)}" font-size="${NAME_FONT}" text-anchor="middle" fill="#0f172a">${xml(name)}</text>`);
      out.push(`<text x="${cx}" y="${(n.y + 38).toFixed(1)}" font-size="${TECH_FONT}" text-anchor="middle" fill="#475569">${xml(truncate(n.tech, TECH_FONT, NODE_MAX_TEXT_W))}</text></g>`);
    } else {
      out.push(`<text x="${cx}" y="${(n.y + 22.5).toFixed(1)}" font-size="${NAME_FONT}" text-anchor="middle" fill="${n.missing ? '#be123c' : '#0f172a'}">${xml(name)}</text></g>`);
    }
  }
  out.push(...badges);
  // 图例
  const ly = L.height - 14;
  let lx = MARGIN;
  for (const st of Object.values(EDGE_STYLE)) {
    out.push(`<line x1="${lx}" y1="${ly - 4}" x2="${lx + 30}" y2="${ly - 4}" stroke="${st.color}" stroke-width="${st.width}"${st.dash ? ` stroke-dasharray="${st.dash}"` : ''}/>`);
    out.push(`<text x="${lx + 36}" y="${ly}" font-size="11" fill="#475569">${st.name}</text>`);
    lx += 84;
  }
  out.push(`<text x="${lx + 4}" y="${ly}" font-size="11" fill="#475569">圆圈数字 = 下方流程表的编号</text>`);
  out.push('</svg>');
  return out.join('');
}
