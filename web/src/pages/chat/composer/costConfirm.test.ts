import { describe, expect, it } from 'vitest';
import { COST_KEY, missingForSend, persistCostConfirmed, readCostConfirmed, revokeCostConfirmation } from './costConfirm';

const memory = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); }, values };
};

describe('cost confirmation', () => {
  it('撤销 clears dmw:chat:cost-confirmed:v1', () => {
    const store = memory();
    persistCostConfirmed(store);
    expect(store.values.get(COST_KEY)).toBe('1');
    expect(readCostConfirmed(store)).toBe(true);
    revokeCostConfirmation(store);
    expect(store.values.has('dmw:chat:cost-confirmed:v1')).toBe(false);
    expect(readCostConfirmed(store)).toBe(false);
  });

  it('treats a throwing storage as not confirmed', () => {
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    expect(readCostConfirmed(broken)).toBe(false);
    expect(() => persistCostConfirmed(broken)).not.toThrow();
    expect(() => revokeCostConfirmation(broken)).not.toThrow();
  });

  it('lists only the missing items', () => {
    expect(missingForSend({ hasContent: false, costConfirmed: false, needsCost: true, pipeline: true, workspace: false, preset: true })).toEqual(['输入内容', '额度确认', '项目目录']);
    expect(missingForSend({ hasContent: true, costConfirmed: true, needsCost: true, pipeline: false, workspace: false, preset: false })).toEqual([]);
    expect(missingForSend({ hasContent: true, costConfirmed: false, needsCost: false, pipeline: false, workspace: false, preset: false })).toEqual([]);
  });
});
