import { describe, expect, test } from 'vitest';
import { traceEvents, traceFixture } from './fixture';
import { applyTraceEvent, cancelTraceScope, initialTraceState, replayTrace, traceScopeKey, type TraceEvent } from './traceModel';

describe('开发演示 trace 适配器', () => {
  test('原始 14 事件满足交接包 expected，并呈现三 Agent、两工具、一产物', () => {
    const state = replayTrace(traceEvents);
    const scope = state.scopes[traceScopeKey(traceEvents[0]!)];
    expect(traceEvents).toHaveLength(14);
    expect(Object.keys(scope.agents)).toHaveLength(traceFixture.expected.participant_count);
    expect(Object.values(scope.agents).filter(agent => traceFixture.expected.parallel_agent_runs.includes(agent.agentRunId as 'run-researcher' | 'run-analyst')).map(agent => agent.agentRunId).sort()).toEqual([...traceFixture.expected.parallel_agent_runs].sort());
    expect(Object.keys(scope.tools)).toHaveLength(traceFixture.expected.tool_call_count);
    expect(Object.keys(scope.artifacts)).toHaveLength(traceFixture.expected.artifact_count);
    expect(scope.status).toBe(traceFixture.expected.final_status);
    expect(scope.agents.coordinator.agentRunId).toBe('run-coordinator');
    expect(scope.messages['demo-answer']).toContain('Agent 分工');
  });

  test('参数分片完成前保持构建中，完成后才得到结构化参数', () => {
    const partial = replayTrace(traceEvents.slice(0, 5)).scopes[traceScopeKey(traceEvents[0]!)];
    expect(partial.tools['tool-notes']).toMatchObject({ status: 'building', arguments: null, argumentError: null, argumentsText: '{"query":' });
    const complete = replayTrace(traceEvents.slice(0, 6)).scopes[traceScopeKey(traceEvents[0]!)];
    expect(complete.tools['tool-notes']).toMatchObject({ status: 'running', arguments: { query: '多 Agent 界面与状态' }, argumentError: null });
  });

  test('同一运行按 eventId 和 seq 去重，不重复拼接消息', () => {
    const events = [...traceEvents, traceEvents[11]!, { ...traceEvents[11]!, eventId: 'replayed-with-new-id' }];
    const scope = replayTrace(events).scopes[traceScopeKey(traceEvents[0]!)];
    expect(scope.processed).toBe(14);
    expect(scope.messages['demo-answer']).toBe('建议先完成工作台闭环：任务输入、Agent 分工、工具执行、人工确认和产物交付。');
  });

  test('工作区、会话、执行边界隔离，未知事件只记入诊断', () => {
    const foreign: TraceEvent = { ...traceEvents[0]!, eventId: 'foreign-1', workspaceId: 'other-workspace', executionId: 'other-execution' };
    const unknown: TraceEvent = { ...foreign, eventId: 'foreign-2', seq: 2, type: 'future.event' };
    const state = replayTrace([traceEvents[0]!, foreign, unknown]);
    expect(Object.keys(state.scopes)).toHaveLength(2);
    expect(state.scopes[traceScopeKey(traceEvents[0]!)].processed).toBe(1);
    expect(state.scopes[traceScopeKey(foreign)].ignored).toBe(1);
  });

  test('浏览器内取消是终态，迟发消息、产物和完成事件不能恢复成功', () => {
    const started = replayTrace(traceEvents.slice(0, 7));
    const key = traceScopeKey(traceEvents[0]!);
    const cancelled = cancelTraceScope(started, key);
    const withLateEvents = traceEvents.slice(7).reduce(applyTraceEvent, cancelled);
    const scope = withLateEvents.scopes[key];
    expect(scope.status).toBe('cancelled');
    expect(scope.messages).toEqual({});
    expect(scope.artifacts).toEqual({});
    expect(Object.values(scope.agents).filter(agent => agent.status === 'running')).toHaveLength(0);
    expect(Object.values(scope.tools).filter(tool => tool.status === 'running' || tool.status === 'building')).toHaveLength(0);
  });

  test('无效信封安全忽略且保持原引用', () => {
    expect(applyTraceEvent(initialTraceState, { ...traceEvents[0]!, eventId: '', seq: 0 })).toBe(initialTraceState);
  });
});
