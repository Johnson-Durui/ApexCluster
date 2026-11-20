import { describe, expect, it } from 'vitest';
import type { CellKind } from '../../../lib/types';
import { scoreCellText, scoreKindMeta } from './scoreCell';

describe('评分格五种类型', () => {
  it.each([
    ['agreed', '一致'], ['disputed', '分歧'], ['single', '单方'], ['unknown', '未知'], ['user', '你的覆盖'],
  ] as const)('%s 显示为 %s', (kind: CellKind, label: string) => {
    expect(scoreKindMeta[kind].label).toBe(label);
  });

  it('分歧保留区间，不编造中间分', () => {
    expect(scoreCellText({ kind: 'disputed', point: null, lo: 2, hi: 4, judgeScores: { claude: 4, astra: 2 } })).toBe('4 / 2 → 2.0–4.0');
  });

  it('未知格明确显示未知', () => {
    expect(scoreCellText({ kind: 'unknown', point: null, lo: 0, hi: 5, judgeScores: {} })).toBe('— / — → 未知');
  });
});
