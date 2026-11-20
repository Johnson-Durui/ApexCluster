import { describe, expect, test } from 'vitest';
import type { Run } from '../../lib/types';
import { gateTab, revealScroll, tabForPhase } from './tabs';

const run = (patch: Partial<Run>) => ({ phase: 'propose', phaseStatus: 'running', terminal: null, jobs: [], docs: { batch: 0, bases: [], requests: [], versions: [], missing: [], requestSeq: 0 }, ...patch }) as Run;

describe('运行页自动切换标签', () => {
  test('模型工作时看执行过程，阻塞时也看执行过程', () => {
    expect(tabForPhase(run({ phase: 'propose' }))).toBe('live');
    expect(tabForPhase(run({ phase: 'docs' }))).toBe('live');
    expect(tabForPhase(run({ phase: 'validate', phaseStatus: 'blocked' }))).toBe('live');
  });

  test('等你决定时打开对应关卡', () => {
    expect(tabForPhase(run({ phase: 'answering', phaseStatus: 'waiting_user' }))).toBe('questions');
    expect(tabForPhase(run({ phase: 'framework_gate', phaseStatus: 'waiting_user' }))).toBe('decision');
    expect(tabForPhase(run({ phase: 'docs_gate', phaseStatus: 'waiting_user' }))).toBe('documents');
    expect(tabForPhase(run({ phase: 'final_gate', phaseStatus: 'waiting_user' }))).toBe('validation');
    expect(gateTab(run({ phase: 'prd_gate', phaseStatus: 'waiting_user' }))).toBe('documents');
    expect(gateTab(run({ phase: 'framework_gate', phaseStatus: 'running' }))).toBeNull();
  });

  test('结束或取消后始终打开交付成果，即使没有产物', () => {
    const docs = { batch: 1, bases: [], requests: [], versions: [{}] as Run['docs']['versions'], missing: [], requestSeq: 1 };
    expect(tabForPhase(run({ phase: 'done', terminal: 'done', docs }))).toBe('deliverables');
    expect(tabForPhase(run({ phase: 'done', terminal: 'done', jobs: [{}] as Run['jobs'] }))).toBe('deliverables');
    expect(tabForPhase(run({ phase: 'answering', terminal: 'cancelled', phaseStatus: 'completed' }))).toBe('deliverables');
  });
});

describe('标签条横向滚动（窄窗口）', () => {
  test('标签已完整可见时不滚动', () => {
    expect(revealScroll({ scrollLeft: 0, clientWidth: 600 }, { offsetLeft: 100, offsetWidth: 80 })).toBeNull();
    expect(revealScroll({ scrollLeft: 0, clientWidth: 600 }, { offsetLeft: 6, offsetWidth: 80 })).toBeNull();
  });

  test('右侧被截断的标签（如 决策记录）滚入视野，并留出 24px 边距', () => {
    expect(revealScroll({ scrollLeft: 0, clientWidth: 600 }, { offsetLeft: 700, offsetWidth: 80 })).toBe(204);
  });

  test('左侧已卷出的标签滚回视野', () => {
    expect(revealScroll({ scrollLeft: 300, clientWidth: 600 }, { offsetLeft: 6, offsetWidth: 80 })).toBe(0);
    expect(revealScroll({ scrollLeft: 300, clientWidth: 600 }, { offsetLeft: 310, offsetWidth: 80 })).toBe(286);
  });
});
