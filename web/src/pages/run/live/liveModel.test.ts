import { describe, expect, test } from 'vitest';
import type { Run } from '../../../lib/types';
import { task } from './testFixtures';
import { groupStages, liveMetrics, requestedSettings } from './liveModel';

describe('执行过程分组', () => {
  test('连续的同类任务组成一个阶段，重试替换同一槽位', () => {
    const stages = groupStages([
      task({ id: 'c1', role: 'claude', phase: 'clarify' }), task({ id: 'c2', role: 'astra', phase: 'clarify' }),
      task({ id: 'p1', role: 'claude', phase: 'propose' }), task({ id: 'p2', role: 'astra', phase: 'propose', status: 'failed' }),
      task({ id: 'p3', role: 'astra', phase: 'propose', attempt: 2, rootTaskId: 'p2' }),
      task({ id: 'r1', role: 'claude', phase: 'review' }), task({ id: 'r2', role: 'astra', phase: 'review' }),
    ]);
    expect(stages.map(stage => stage.id)).toEqual(['clarify-1', 'propose-1', 'review-1']);
    expect(stages[1]!.tasks.map(item => item.id)).toEqual(['p1', 'p3']);
  });

  test('重新设计后再次出现的阶段按次数编号', () => {
    const stages = groupStages([task({ id: 'a', role: 'claude', phase: 'propose' }), task({ id: 'b', role: 'claude', phase: 'review' }), task({ id: 'c', role: 'claude', phase: 'propose' })]);
    expect(stages.map(stage => stage.label)).toEqual(['独立提案', '交叉评审', '独立提案 · 第 2 次']);
  });

  test('手册与开发文档同属一个阶段，修订只保留最新任务', () => {
    const stages = groupStages([task({ id: 'h1', role: 'claude', phase: 'handbook' }), task({ id: 'd1', role: 'claude', phase: 'devdoc' }), task({ id: 'h2', role: 'claude', phase: 'handbook' })]);
    expect(stages).toHaveLength(1);
    expect(stages[0]!.label).toBe('撰写构建前文档');
    expect(stages[0]!.tasks.map(item => item.id)).toEqual(['h2', 'd1']);
  });

  test('多个构建作业按作业分槽位并列显示', () => {
    const stages = groupStages([task({ id: 'j1', role: 'sol', phase: 'build', jobId: 'j-C1-1' }), task({ id: 'j2', role: 'sol', phase: 'build', jobId: 'j-C2-1' })]);
    expect(stages[0]!.tasks).toHaveLength(2);
  });

  test('独立评审和 Claude 终审作为独立执行阶段显示', () => {
    const stages = groupStages([
      task({ id: 'b1', role: 'sol', phase: 'build', jobId: 'j-C1-1' }),
      task({ id: 'e1', role: 'astra', phase: 'evaluate', jobId: 'j-C1-1' }),
      task({ id: 'f1', role: 'claude', phase: 'final_review', jobId: 'j-C1-1' }),
    ]);
    expect(stages.map(stage => stage.label)).toEqual(['Sol 构建 MVP', 'Astra 独立评审', 'Claude 终审']);
  });

  test('从进度事件统计工具调用、接口重试和推理 token 估计', () => {
    const metrics = liveMetrics([
      { at: '', kind: 'started', text: '会话已启动' },
      { at: '', kind: 'tool', text: '调用 WebSearch：sqlite windows' },
      { at: '', kind: 'info', text: '推理中（估计已生成 1024 tokens，非最终用量）' },
      { at: '', kind: 'retry', text: '接口重试 #1：overloaded' },
      { at: '', kind: 'tool', text: '执行命令：npm test' },
      { at: '', kind: 'info', text: '推理中（估计已生成 2048 tokens，非最终用量）' },
    ]);
    expect(metrics).toEqual({ tools: 2, retries: 1, tokens: 2048, events: 6 });
    expect(liveMetrics([]).tokens).toBeNull();
  });

  test('请求设置：裁决固定 Ultra，文档用撰写强度，构建用作业强度', () => {
    const run = {
      models: {
        claude: { role: 'claude', adapter: 'claude-code', model: 'claude-opus-5-5', effort: 'max' },
        astra: { role: 'astra', adapter: 'codex', model: 'gpt-6-astra', effort: 'max' },
        sol: { role: 'sol', adapter: 'codex', model: 'gpt-6.1-sol', effort: 'max' },
      },
      docWriter: { role: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' },
      jobs: [{ id: 'j-C1-1', effort: 'ultra' }],
    } as unknown as Pick<Run, 'models' | 'jobs' | 'docWriter'>;
    expect(requestedSettings(task({ id: 'u', role: 'astra', phase: 'adjudicate' }), run)).toEqual({ model: 'gpt-6-astra', effort: 'ultra' });
    expect(requestedSettings(task({ id: 'h', role: 'claude', phase: 'handbook' }), run)).toEqual({ model: 'claude-opus-5-5', effort: 'xhigh' });
    expect(requestedSettings(task({ id: 's', role: 'sol', phase: 'build', jobId: 'j-C1-1' }), run)).toEqual({ model: 'gpt-6.1-sol', effort: 'ultra' });
    expect(requestedSettings(task({ id: 'p', role: 'claude', phase: 'propose' }), run)).toEqual({ model: 'claude-opus-5-5', effort: 'max' });
  });
});
