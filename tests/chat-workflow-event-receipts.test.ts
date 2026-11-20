import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatEvent, ChatRecord } from '../src/chat/types.js';
import { validateCancelledAskUserReceipt, validateRootGrokBatchReceipt } from '../scripts/chat-workflow-event-receipts.js';

const root = 'root-task';
const invocation = 'invocation-1';
const call = 'invocation-1:8';
const children = ['child-a', 'child-b', 'child-c'];

function pair(text = JSON.stringify(children.map(taskId => ({ taskId, role: 'grok', status: 'queued' })))): ChatEvent[] {
  return [
    { seq: 1, chatId: 'chat', type: 'tool_started', at: '2026-01-01T00:00:00Z', taskId: root, invocationId: invocation, data: { name: 'grok_submit', toolCallId: call } },
    { seq: 2, chatId: 'chat', type: 'tool_result', at: '2026-01-01T00:00:01Z', taskId: root, invocationId: invocation, data: { name: 'grok_submit', toolCallId: call, text } },
  ];
}

test('accepts one exact program-event Grok batch receipt', () => {
  assert.deepEqual(validateRootGrokBatchReceipt(pair(), root, children, 'chat'), {
    taskId: root, invocationId: invocation, toolCallId: call, childTaskIds: children,
  });
});

test('rejects split, duplicate, errored, mismatched and model-text batches', () => {
  assert.throws(() => validateRootGrokBatchReceipt([...pair(), ...pair()], root, children, 'chat'), /exactly one/);
  assert.throws(() => validateRootGrokBatchReceipt([...pair(), { ...pair()[0]!, seq: 3, type: 'tool_error' }], root, children, 'chat'), /no other events/);
  assert.throws(() => validateRootGrokBatchReceipt(pair(JSON.stringify([
    { taskId: children[0], role: 'grok', status: 'queued' },
    { taskId: children[1], role: 'grok', status: 'queued' },
    { taskId: 'model-claimed-child', role: 'grok', status: 'queued' },
  ])), root, children, 'chat'), /do not match/);
  assert.throws(() => validateRootGrokBatchReceipt(pair('I queued three tasks.'), root, children, 'chat'), /JSON array/);
  const mismatch = pair();
  mismatch[1] = { ...mismatch[1]!, data: { ...(mismatch[1]!.data as object), toolCallId: 'other-call' } };
  assert.throws(() => validateRootGrokBatchReceipt(mismatch, root, children, 'chat'), /toolCallId mismatch/);
  const crossChat = pair(); crossChat[1] = { ...crossChat[1]!, chatId: 'other-chat' };
  assert.throws(() => validateRootGrokBatchReceipt(crossChat, root, children, 'chat'), /chatId mismatch/);
  const foreignPair = pair().map(event => ({ ...event, chatId: 'other-chat' }));
  assert.throws(() => validateRootGrokBatchReceipt(foreignPair, root, children, 'chat'), /unexpected chatId/);
  const reverseSequence = pair(); reverseSequence[0] = { ...reverseSequence[0]!, seq: 3 };
  assert.throws(() => validateRootGrokBatchReceipt(reverseSequence, root, children, 'chat'), /sequence is invalid/);
});

test('validates the persisted ask_user started/question/result cancellation shape', () => {
  const chat = {
    id: 'cancel-chat', turns: [{ rootTaskId: 'cancel-root' }],
    tasks: [{ id: 'cancel-root' }],
    invocations: [{ id: 'cancel-invocation', taskId: 'cancel-root', status: 'exited', exitConfirmed: true }],
    tickets: [{ id: 'ticket-1', taskId: 'cancel-root', invocationId: 'cancel-invocation', type: 'user', status: 'cancelled', question: '是否继续？', options: ['继续', '停止'] }],
  } as unknown as ChatRecord;
  const events: ChatEvent[] = [
    { seq: 5, chatId: chat.id, taskId: 'cancel-root', invocationId: 'cancel-invocation', type: 'tool_started', at: '', data: { name: 'ask_user', toolCallId: 'cancel-invocation:1' } },
    { seq: 7, chatId: chat.id, taskId: 'cancel-root', invocationId: 'cancel-invocation', type: 'question', at: '', data: { type: 'user', id: 'ticket-1', taskId: 'cancel-root', invocationId: 'cancel-invocation', status: 'pending', question: '是否继续？', options: ['继续', '停止'] } },
    { seq: 8, chatId: chat.id, taskId: 'cancel-root', invocationId: 'cancel-invocation', type: 'tool_result', at: '', data: { name: 'ask_user', toolCallId: 'cancel-invocation:1', text: '等待用户回答。' } },
  ];
  assert.deepEqual(validateCancelledAskUserReceipt(events, chat, '是否继续？', ['继续', '停止']), {
    taskId: 'cancel-root', invocationId: 'cancel-invocation', ticketId: 'ticket-1', toolCallId: 'cancel-invocation:1', startedSeq: 5, questionSeq: 7, resultSeq: 8,
  });
  assert.throws(() => validateCancelledAskUserReceipt([...events, { ...events[0]!, seq: 9, data: { name: 'file_read', toolCallId: 'cancel-invocation:2' } }], chat, '是否继续？', ['继续', '停止']), /other than ask_user/);
});
