import type { RunSummary } from '../../lib/types';
import { buildTrack } from '../run/header/trackModel';

export type RunFilter = 'all' | 'waiting' | 'active' | 'ended';
export type RunState = 'waiting' | 'active' | 'blocked' | 'ended';

export function runState(run: RunSummary): RunState {
  if (run.terminal) return 'ended';
  if (run.phaseStatus === 'waiting_user') return 'waiting';
  if (run.phaseStatus === 'blocked') return 'blocked';
  return 'active';
}

/** 旧服务返回的摘要缺少 v0.4 字段时，按“文档步骤开启、没有关卡记录”处理。 */
export function summaryTrack(run: RunSummary) {
  return buildTrack({ phase: run.phase, phaseStatus: run.phaseStatus, terminal: run.terminal, writeDocs: run.writeDocs ?? true, writePrd: run.writePrd ?? true, gates: run.gates ?? [] });
}

/** 运行列表只统计真实运行；移除模拟模式之前留下的模拟记录单独计数。 */
export function homeStats(runs: RunSummary[]) {
  const real = runs.filter(run => run.mode !== 'mock');
  const count = (states: RunState[]) => real.filter(run => states.includes(runState(run))).length;
  return { total: real.length, waiting: count(['waiting']), active: count(['active', 'blocked']), blocked: count(['blocked']), ended: count(['ended']), legacy: runs.length - real.length };
}

export function visibleRuns(runs: RunSummary[], options: { filter: RunFilter; query: string; showLegacy: boolean }): RunSummary[] {
  const query = options.query.trim().toLowerCase();
  return runs.filter(run => {
    if (!options.showLegacy && run.mode === 'mock') return false;
    const state = runState(run);
    if (options.filter === 'waiting' && state !== 'waiting') return false;
    if (options.filter === 'active' && state !== 'active' && state !== 'blocked') return false;
    if (options.filter === 'ended' && state !== 'ended') return false;
    return !query || run.title.toLowerCase().includes(query) || run.id.toLowerCase().includes(query);
  });
}

const gateKeys: Record<string, string> = { G1_answers: 'G1', G2_framework: 'G2', G3_docs: 'G3', G4_final: 'G4', G3_final: 'G4', G5_prd: 'G5' };
const waitingTexts: Record<string, string> = { answering: 'G1 回答问题', framework_gate: 'G2 确认框架', docs_gate: 'G3 确认文档', final_gate: 'G4 验收 MVP', prd_gate: 'G5 确认 PRD' };

export function waitingText(run: RunSummary): string {
  return waitingTexts[run.phase] ?? '等待你确认';
}

/** 状态列的文字：结束的运行写清是接受了哪个候选，还是在某个关卡停止。 */
export function outcomeText(run: RunSummary): string {
  if (run.terminal === 'cancelled') return '已取消';
  if (run.terminal === 'done') {
    if (run.finalChoice?.candidateId) return `已结束 · 接受 ${run.finalChoice.candidateId}`;
    const stop = (run.gates ?? []).filter(gate => gate.resolved && gate.action === 'stop').at(-1);
    return stop ? `已结束 · 在 ${gateKeys[stop.id] ?? stop.id} 停止` : '已结束';
  }
  const state = runState(run);
  if (state === 'waiting') return `等你决定 · ${waitingText(run)}`;
  if (state === 'blocked') return '已阻塞';
  return '进行中';
}

const waitingKeys: Record<string, string> = { answering: 'G1', framework_gate: 'G2', docs_gate: 'G3', final_gate: 'G4', prd_gate: 'G5' };

export function waitingGate(run: RunSummary): string {
  return waitingKeys[run.phase] ?? '关卡';
}
