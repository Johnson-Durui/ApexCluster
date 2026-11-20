import type { CellKind, CellResult } from '../../../lib/types';

export const scoreKindMeta: Record<CellKind, { label: string; tone: string; description: string }> = {
  agreed: { label: '一致', tone: 'ok', description: '两位评审分差未达到分歧阈值' },
  disputed: { label: '分歧', tone: 'bad', description: '两位评审分差达到分歧阈值，保留区间' },
  single: { label: '单方', tone: 'warn', description: '只有一位评审给出有效评分' },
  unknown: { label: '未知', tone: '', description: '当前没有足够依据形成评分' },
  user: { label: '你的覆盖', tone: 'info', description: '使用你填写理由后的评分覆盖' },
};

export function scoreCellText(cell: Pick<CellResult, 'kind' | 'point' | 'lo' | 'hi' | 'judgeScores'>): string {
  const claude = cell.judgeScores.claude ?? '—';
  const astra = cell.judgeScores.astra ?? '—';
  const result = cell.point === null ? (cell.kind === 'unknown' ? '未知' : `${cell.lo.toFixed(1)}–${cell.hi.toFixed(1)}`) : cell.point.toFixed(1);
  return `${claude} / ${astra} → ${result}`;
}
