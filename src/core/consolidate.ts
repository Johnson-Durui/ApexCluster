/**
 * 候选整理：把两位评审都认为“实质相同”的提案合并为一个候选。
 * - 只有两位评审一致认为相同才合并（避免一方借“合并”吞掉对方方案）。
 * - 只有一方认为相同：不合并，标记 possibleDuplicateOf，界面提示你可以手动合并。
 * - 候选数量由内容决定：1 个、2 个、3 个都是正常结果，不凑数。
 */
import type { Candidate, DesignRole, Origin, Proposal } from './types.js';

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    const p = this.parent.get(x)!;
    if (p === x) return x;
    const r = this.find(p);
    this.parent.set(x, r);
    return r;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function pairsOf(groups: string[][]): Set<string> {
  const s = new Set<string>();
  for (const g of groups) {
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) s.add(pairKey(g[i]!, g[j]!));
  }
  return s;
}

/** 提案排序：Claude-1, Astra-1, Claude-2, Astra-2 …（交替，避免整体排在一方之后） */
export function proposalOrder(proposals: Proposal[]): Proposal[] {
  const idx = (p: Proposal) => proposals.filter((x) => x.author === p.author).indexOf(p);
  return [...proposals].sort((a, b) => idx(a) - idx(b) || (a.author === b.author ? 0 : a.author === 'claude' ? -1 : 1));
}

export function consolidate(
  proposals: Proposal[],
  /** 每位评审给出的等价分组（已从匿名编号映射回 proposalId） */
  groupsByJudge: Partial<Record<DesignRole, string[][]>>,
  judges: DesignRole[],
  manualMerges: string[][] = [],
): Candidate[] {
  const ordered = proposalOrder(proposals);
  const ids = new Set(ordered.map((p) => p.id));
  const judgePairs = judges.map((j) => pairsOf((groupsByJudge[j] ?? []).map((g) => g.filter((x) => ids.has(x)))));
  const uf = new UnionFind();
  ordered.forEach((p) => uf.find(p.id));

  const agreed = new Set<string>();
  const partial = new Set<string>();
  if (judgePairs.length >= 2) {
    const all = new Set(judgePairs.flatMap((s) => [...s]));
    for (const k of all) {
      if (judgePairs.every((s) => s.has(k))) agreed.add(k);
      else partial.add(k);
    }
  } else if (judgePairs.length === 1) {
    for (const k of judgePairs[0]!) partial.add(k);
  }
  for (const k of agreed) {
    const [a, b] = k.split('|') as [string, string];
    uf.union(a, b);
  }
  // 你在界面上手动合并的（例如“只有一方认为相同”的情况）
  for (const g of manualMerges) for (let i = 1; i < g.length; i++) if (ids.has(g[0]!) && ids.has(g[i]!)) uf.union(g[0]!, g[i]!);

  const comps = new Map<string, Proposal[]>();
  for (const p of ordered) {
    const r = uf.find(p.id);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r)!.push(p);
  }

  const candidates: Candidate[] = [];
  const memberToCand = new Map<string, string>();
  let n = 1;
  for (const members of comps.values()) {
    const id = `C${n++}`;
    const authors = new Set(members.map((m) => m.author));
    const origin: Origin = authors.size > 1 ? 'both' : [...authors][0]!;
    const rep = members.find((m) => m.author === 'claude') ?? members[0]!;
    members.forEach((m) => memberToCand.set(m.id, id));
    candidates.push({
      id,
      memberProposalIds: members.map((m) => m.id),
      origin,
      representativeProposalId: rep.id,
      possibleDuplicateOf: [],
      invalidatedAssumptions: [],
    });
  }
  for (const k of partial) {
    const [a, b] = k.split('|') as [string, string];
    const ca = memberToCand.get(a)!;
    const cb = memberToCand.get(b)!;
    if (ca === cb) continue;
    const A = candidates.find((c) => c.id === ca)!;
    const B = candidates.find((c) => c.id === cb)!;
    if (!A.possibleDuplicateOf.includes(cb)) A.possibleDuplicateOf.push(cb);
    if (!B.possibleDuplicateOf.includes(ca)) B.possibleDuplicateOf.push(ca);
  }
  return candidates;
}
