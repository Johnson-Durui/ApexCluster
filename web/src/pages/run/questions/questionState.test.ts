import { describe, expect, it } from 'vitest';
import type { Question } from '../../../lib/types';
import { nextOptionSelection, questionStatusText } from './questionState';
import { rankQuestionsForDisplay } from './QuestionsPanel';

describe('问题选项状态', () => {
  it('单选题切换时只保留最后一个选项', () => {
    expect(nextOptionSelection(['a'], 'b', false)).toEqual(['b']);
  });

  it('多选题可追加和取消选项且不影响其他选择', () => {
    expect(nextOptionSelection(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(nextOptionSelection(['a', 'b'], 'a', true)).toEqual(['b']);
  });

  it('把未回答、默认、不确定和已回答状态转换为明确文案', () => {
    const base = { options: [{ id: 'a', label: '方案 A', implication: '' }], answer: null } as unknown as Question;
    expect(questionStatusText({ ...base, status: 'open' })).toBe('未回答');
    expect(questionStatusText({ ...base, status: 'skipped' })).toBe('已采用默认');
    expect(questionStatusText({ ...base, status: 'unsure' })).toBe('暂不确定');
    expect(questionStatusText({ ...base, status: 'answered', answer: { optionIds: ['a'], otherText: null, note: null, answeredAt: '' } })).toBe('方案 A');
  });
});

it('问题排序只改变展示顺序且不会丢题', () => {
  const questions = Array.from({ length: 16 }, (_, index) => ({ id: `Q${index + 1}`, priority: index === 15 ? 'blocking' : 'optional', status: 'open' })) as Question[];
  const ranked = rankQuestionsForDisplay(questions);
  expect(ranked).toHaveLength(16);
  expect(new Set(ranked.map(item => item.id))).toEqual(new Set(questions.map(item => item.id)));
  expect(ranked[0]?.id).toBe('Q16');
});
