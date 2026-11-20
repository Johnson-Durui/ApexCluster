import { describe, expect, test } from 'vitest';
import { validateG3, validateG5 } from './docGateValidation';

describe('G3 文档确认表单', () => {
  test('修订时手册和开发文档至少填写一项', () => {
    expect(validateG3({ action: 'revise', conclusion: '通过', reason: '', handbookNotes: '  ', devdocNotes: '' })).toContain('至少');
    expect(validateG3({ action: 'revise', conclusion: '通过', reason: '', handbookNotes: '', devdocNotes: '补充部署步骤' })).toBeNull();
  });

  test('补充后通过必须说明待补内容', () => {
    expect(validateG3({ action: 'approve', conclusion: '补充后通过', reason: '', handbookNotes: '', devdocNotes: '' })).toContain('补充');
  });
});

describe('G5 PRD 确认表单', () => {
  test('修订必须填写 PRD 意见', () => {
    expect(validateG5({ action: 'revise', conclusion: '通过', reason: '', prdNotes: '' })).toContain('修改意见');
    expect(validateG5({ action: 'revise', conclusion: '通过', reason: '', prdNotes: '补充验收边界' })).toBeNull();
  });

  test('普通通过无需补充内容', () => {
    expect(validateG5({ action: 'approve', conclusion: '通过', reason: '', prdNotes: '' })).toBeNull();
  });
});
