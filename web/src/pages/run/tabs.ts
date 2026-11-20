import type { IconName } from '../../components/ui';
import type { Run } from '../../lib/types';

export type RunTab = 'workspace' | 'live' | 'questions' | 'proposals' | 'compare' | 'decision' | 'documents' | 'validation' | 'deliverables' | 'records';

/** 页面内的跨组件事件：打开需求快照、定位到某个问题。 */
export const OPEN_SNAPSHOT_EVENT = 'workbench:open-snapshot';
export const FOCUS_QUESTION_EVENT = 'workbench:focus-question';

export const runTabs: { key: RunTab; label: string; icon: IconName }[] = [
  { key: 'workspace', label: '任务总览', icon: 'layers' },
  { key: 'live', label: '执行过程', icon: 'activity' },
  { key: 'questions', label: '澄清问题', icon: 'message' },
  { key: 'proposals', label: '架构方案', icon: 'layers' },
  { key: 'compare', label: '评审对比', icon: 'scale' },
  { key: 'decision', label: '框架决策', icon: 'flag' },
  { key: 'documents', label: '项目文档', icon: 'file' },
  { key: 'validation', label: 'MVP 验证', icon: 'terminal' },
  { key: 'deliverables', label: '交付成果', icon: 'box' },
  { key: 'records', label: '决策记录', icon: 'list' },
];

/** Horizontal scroll that brings a tab fully into the tab strip with `pad` px of context, or null if it is already
 *  shown. Only the strip scrolls (never the page), so an automatic tab switch or a gate jump always shows its tab. */
export function revealScroll(strip: { scrollLeft: number; clientWidth: number }, tab: { offsetLeft: number; offsetWidth: number }, pad = 24): number | null {
  const start = tab.offsetLeft - pad;
  const end = tab.offsetLeft + tab.offsetWidth + pad;
  const next = start < strip.scrollLeft ? Math.max(0, start)
    : end > strip.scrollLeft + strip.clientWidth ? end - strip.clientWidth
      : strip.scrollLeft;
  return Math.abs(next - strip.scrollLeft) < 1 ? null : next;
}

/** 当前关卡对应的标签页；用来在标签上标出“等你决定”。 */
export function gateTab(run: Pick<Run, 'phase' | 'phaseStatus' | 'terminal'>): RunTab | null {
  if (run.terminal || run.phaseStatus !== 'waiting_user') return null;
  if (run.phase === 'answering') return 'questions';
  if (run.phase === 'framework_gate') return 'decision';
  if (run.phase === 'docs_gate' || run.phase === 'prd_gate') return 'documents';
  if (run.phase === 'final_gate') return 'validation';
  return null;
}

/** 阶段变化时自动切换到最相关的标签页：模型在工作时看执行过程，等你决定时看对应关卡。 */
export function tabForPhase(run: Pick<Run, 'phase' | 'phaseStatus' | 'terminal' | 'jobs'> & { docs?: Run['docs'] }): RunTab {
  const gate = gateTab(run);
  if (gate) return gate;
  if (!run.terminal && run.phaseStatus === 'blocked') return 'live';
  if (run.phase === 'done' || run.terminal) return 'deliverables';
  if (run.phase === 'answering') return 'questions';
  if (run.phase === 'framework_gate') return 'decision';
  if (run.phase === 'docs_gate' || run.phase === 'prd_gate') return 'documents';
  if (run.phase === 'final_gate') return 'validation';
  return 'live';
}
