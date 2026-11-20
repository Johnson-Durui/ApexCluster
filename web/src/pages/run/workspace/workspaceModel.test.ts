import { describe, expect, test } from 'vitest';
import { liveRun, task } from '../live/testFixtures';
import { executionTools, latestAgentTasks, previewKind, readToolEvidence } from './workspaceModel';

describe('任务总览的事实映射', () => {
  test('各角色保留独立槽位，重试只取本角色最新任务', () => {
    const first = task({ id: 'claude-1', role: 'claude', phase: 'propose' });
    const astra = task({ id: 'astra-1', role: 'astra', phase: 'propose', status: 'running' });
    const retry = task({ id: 'claude-2', role: 'claude', phase: 'propose', rootTaskId: first.id, attempt: 2 });
    expect(latestAgentTasks([retry, first, astra]).map(value => value.id)).toEqual([retry.id, astra.id]);
  });
  test('同角色并行作业分别保留，后一个Sol作业不覆盖前一个', () => {
    const left = task({ id: 'sol-left', role: 'sol', phase: 'build', jobId: 'j-left', scope: 'job:j-left', status: 'running' });
    const right = task({ id: 'sol-right', role: 'sol', phase: 'build', jobId: 'j-right', scope: 'job:j-right', status: 'running' });
    expect(latestAgentTasks([left, right]).map(item => item.jobId)).toEqual(['j-left', 'j-right']);
  });
  test('工具只来自已记录的工具事件，按任务归属；不从普通文本推测工具', () => {
    const one = task({ id: 'one', role: 'sol', phase: 'build' });
    const two = task({ id: 'two', role: 'astra', phase: 'evaluate' });
    const tools = executionTools(liveRun([one, two]), { one: [{ at: one.createdAt, kind: 'tool', text: 'npm test' }], two: [{ at: two.createdAt, kind: 'message', text: '可能运行 npm test' }] });
    expect(tools).toHaveLength(1);
    expect(tools[0]?.task.id).toBe('one');
  });
  test('可执行格式和超大文本仅提供下载，HTML按文本预览', () => {
    expect(previewKind('test.exe', 50)).toBeNull();
    expect(previewKind('huge.md', 600000)).toBeNull();
    expect(previewKind('unsafe.html', 30)).toBe('text');
  });
  test('完整工具日志保留非零退出码与结果，不对缺失状态编造成功', () => {
    const result = readToolEvidence(JSON.stringify([{ seq: 2, type: 'command_execution', command: 'npm test', exitCode: 1, output: 'failed' }, { malformed: true }]));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ exitCode: 1, output: 'failed', status: null });
    expect(() => readToolEvidence('{}')).toThrow('格式不受支持');
  });
});
