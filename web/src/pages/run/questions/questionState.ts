import type { Question } from '../../../lib/types';

export type QuestionFilter = 'all' | 'open' | 'blocking' | 'claude' | 'astra' | 'sol';

export function nextOptionSelection(current: string[], optionId: string, multiSelect: boolean): string[] {
  if (!multiSelect) return [optionId];
  return current.includes(optionId) ? current.filter(id => id !== optionId) : [...current, optionId];
}

export function questionMatchesFilter(question: Question, filter: QuestionFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'open') return question.status === 'open';
  if (filter === 'blocking') return question.priority === 'blocking' && question.status === 'open';
  return question.askedBy === filter;
}

export function questionStatusText(question: Question): string {
  if (question.status === 'open') return '未回答';
  if (question.status === 'skipped') return '已采用默认';
  if (question.status === 'unsure') return '暂不确定';
  const selected = question.answer?.optionIds
    .map(id => question.options.find(option => option.id === id)?.label)
    .filter((label): label is string => Boolean(label)) ?? [];
  if (question.answer?.otherText) selected.push(`其他：${question.answer.otherText}`);
  return selected.length ? selected.join('、') : '已回答';
}
