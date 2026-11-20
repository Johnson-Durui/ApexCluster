export type DocGateAction = 'approve' | 'revise' | 'back_to_framework' | 'stop';
export type PrdGateAction = 'approve' | 'revise' | 'stop';

export function validateG3(input: {
  action: DocGateAction;
  conclusion: '通过' | '补充后通过';
  reason: string;
  handbookNotes: string;
  devdocNotes: string;
}): string | null {
  if (input.action === 'revise' && !input.handbookNotes.trim() && !input.devdocNotes.trim()) return '请至少为一份文档写修改意见。';
  if (input.action === 'approve' && input.conclusion === '补充后通过' && !input.reason.trim()) return '请选择“通过”，或写明补充后通过仍需补充的内容。';
  return null;
}

export function validateG5(input: {
  action: PrdGateAction;
  conclusion: '通过' | '补充后通过';
  reason: string;
  prdNotes: string;
}): string | null {
  if (input.action === 'revise' && !input.prdNotes.trim()) return '请写明 PRD 的修改意见。';
  if (input.action === 'approve' && input.conclusion === '补充后通过' && !input.reason.trim()) return '请选择“通过”，或写明补充后通过仍需补充的内容。';
  return null;
}
