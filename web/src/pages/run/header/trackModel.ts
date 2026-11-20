import type { Phase, Run } from '../../../lib/types';

/** 进度条上每个元素的状态。stopped 表示运行在这里被停止或取消。 */
export type TrackState = 'done' | 'now' | 'todo' | 'off' | 'blocked' | 'stopped';
export type GateKey = 'G1' | 'G2' | 'G3' | 'G4' | 'G5';

export interface TrackInput {
  phase: Phase;
  phaseStatus: Run['phaseStatus'];
  terminal: Run['terminal'];
  writeDocs: boolean;
  writePrd: boolean;
  gates: { id: string; resolved: boolean; action: string | null }[];
}
export interface TrackStep { phase: Phase; label: string; state: TrackState }
export interface TrackSegment { kind: 'segment'; key: string; steps: TrackStep[]; loop: TrackStep[]; state: TrackState; fill: number }
export interface TrackGate { kind: 'gate'; key: GateKey; phase: Phase; label: string; state: TrackState }
export type TrackItem = TrackSegment | TrackGate;

export const PHASE_ORDER: Phase[] = ['intake', 'clarify', 'answering', 'propose', 'review', 'framework_gate', 'recheck', 'adjudicate', 'docs', 'docs_gate', 'validate', 'final_gate', 'prd_writing', 'prd_gate', 'done'];

const STEP_LABELS: Partial<Record<Phase, string>> = {
  intake: '录入需求', clarify: '澄清提问', propose: '独立提案', review: '交叉评审', recheck: '复核分歧', adjudicate: 'Ultra 裁决',
  docs: '手册与开发文档', validate: 'Sol 构建', prd_writing: 'PRD 撰写', done: '结束',
};
const GATES: { key: GateKey; phase: Phase; label: string; records: string[] }[] = [
  { key: 'G1', phase: 'answering', label: '回答问题', records: ['G1_answers'] },
  { key: 'G2', phase: 'framework_gate', label: '确认框架', records: ['G2_framework'] },
  { key: 'G3', phase: 'docs_gate', label: '确认文档', records: ['G3_docs'] },
  { key: 'G4', phase: 'final_gate', label: '验收 MVP', records: ['G4_final', 'G3_final'] },
  { key: 'G5', phase: 'prd_gate', label: '确认 PRD', records: ['G5_prd'] },
];
const SEGMENTS: { key: string; steps: Phase[]; loop?: Phase[]; needs?: 'writeDocs' | 'writePrd' }[] = [
  { key: 'intake', steps: ['intake', 'clarify'] },
  { key: 'design', steps: ['propose', 'review'], loop: ['recheck', 'adjudicate'] },
  { key: 'docs', steps: ['docs'], needs: 'writeDocs' },
  { key: 'build', steps: ['validate'] },
  { key: 'prd', steps: ['prd_writing'], needs: 'writePrd' },
  { key: 'end', steps: ['done'] },
];
const LOOP = new Set<Phase>(['recheck', 'adjudicate']);
const index = (phase: Phase) => PHASE_ORDER.indexOf(phase);
/** 复核与裁决从 G2 发起、结束后回到 G2，因此位置记在交叉评审与 G2 之间。 */
const position = (phase: Phase) => LOOP.has(phase) ? index('review') + 0.5 : index(phase);

export function trackInputFromRun(run: Run): TrackInput {
  return {
    phase: run.phase, phaseStatus: run.phaseStatus, terminal: run.terminal,
    writeDocs: run.writeDocs !== false, writePrd: run.writePrd !== false,
    gates: run.gates.map(gate => ({ id: gate.id, resolved: Boolean(gate.resolvedAt), action: actionOf(gate.resolution) })),
  };
}

function actionOf(resolution: unknown): string | null {
  if (!resolution || typeof resolution !== 'object' || !('action' in resolution)) return null;
  const action = (resolution as { action: unknown }).action;
  return typeof action === 'string' ? action : null;
}

export function buildTrack(input: TrackInput): TrackItem[] {
  // 正常结束（done）时，phase 都是 done；需要用关卡决定区分“走完”和“在某个关卡停止”。
  let stopPhase: Phase | null = null;
  if (input.terminal === 'done') {
    for (const gate of GATES) {
      const last = input.gates.filter(record => gate.records.includes(record.id) && record.resolved).at(-1);
      if (last && (last.action === 'stop' || last.action === 'cancel')) { stopPhase = gate.phase; break; }
    }
  }
  const current = input.terminal === 'done' ? (stopPhase ? index(stopPhase) : PHASE_ORDER.length) : position(input.phase);
  const stateOf = (phase: Phase): TrackState => {
    if (input.terminal === 'done') return phase === stopPhase ? 'stopped' : position(phase) < current ? 'done' : 'todo';
    if (phase === input.phase) return input.terminal === 'cancelled' ? 'stopped' : input.phaseStatus === 'blocked' ? 'blocked' : 'now';
    return position(phase) < current ? 'done' : 'todo';
  };
  const loopStateOf = (phase: Phase): TrackState => phase === input.phase && input.terminal !== 'done' ? stateOf(phase) : 'todo';
  const enabled = (needs?: 'writeDocs' | 'writePrd') => !needs || input[needs];

  const items: TrackItem[] = [];
  SEGMENTS.forEach((segment, i) => {
    const on = enabled(segment.needs);
    const steps = segment.steps.map(phase => ({ phase, label: STEP_LABELS[phase] ?? phase, state: on ? stateOf(phase) : 'off' as TrackState }));
    const loop = (segment.loop ?? []).map(phase => ({ phase, label: STEP_LABELS[phase] ?? phase, state: loopStateOf(phase) }));
    const active = [...steps, ...loop].find(step => step.state === 'now' || step.state === 'blocked' || step.state === 'stopped');
    const done = steps.filter(step => step.state === 'done').length;
    const state: TrackState = !on ? 'off' : active ? active.state : done === steps.length ? 'done' : done ? 'now' : 'todo';
    const fill = !on ? 0 : Math.min(1, (done + (active && !LOOP.has(active.phase) ? 0.5 : 0)) / steps.length);
    items.push({ kind: 'segment', key: segment.key, steps, loop, state, fill });
    const gate = GATES[i];
    if (gate) {
      const gateOn = gate.key === 'G3' ? input.writeDocs : gate.key === 'G5' ? input.writePrd : true;
      items.push({ kind: 'gate', key: gate.key, phase: gate.phase, label: gate.label, state: gateOn ? stateOf(gate.phase) : 'off' });
    }
  });
  return items;
}

export const trackStateLabels: Record<TrackState, string> = { done: '已完成', now: '进行中', todo: '未开始', off: '已关闭', blocked: '已阻塞', stopped: '在此停止' };
