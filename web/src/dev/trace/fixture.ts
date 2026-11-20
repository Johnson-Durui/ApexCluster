import type { TraceEvent } from './traceModel';

export const traceFixture = {
  evidence: 'PROPOSED',
  synthetic: true,
  source: 'Newly authored fixture, not captured original-site traffic.',
  usage: 'Replay locally through a demo adapter. Never append to authenticated production sessions or usage records.',
  expected: {
    participant_count: 3,
    parallel_agent_runs: ['run-researcher', 'run-analyst'],
    tool_call_count: 2,
    artifact_count: 1,
    final_status: 'completed',
  },
  events: [
    { eventId: 'demo-event-1', seq: 1, timestamp: '2026-10-26T02:00:01.000Z', workspaceId: 'demo-workspace', sessionId: 'demo-session', executionId: 'demo-execution', agentId: 'coordinator', type: 'run.started', data: { title: '整理多 Agent 前端页面与能力清单', rootAgentRunId: 'run-coordinator', participants: [{ id: 'coordinator', name: '协调 Agent', role: '拆分任务并汇总交付' }, { id: 'researcher', name: '资料 Agent', role: '提取参考中的界面和流程' }, { id: 'analyst', name: '分析 Agent', role: '核对已有能力与接入缺口' }] } },
    { eventId: 'demo-event-2', seq: 2, timestamp: '2026-10-26T02:00:02.000Z', workspaceId: 'demo-workspace', sessionId: 'demo-session', executionId: 'demo-execution', agentId: 'researcher', type: 'agent.started', data: { agentRunId: 'run-researcher', parentAgentRunId: 'run-coordinator', task: '梳理会话、工具和产物界面' } },
    { eventId: 'demo-event-3', seq: 3, timestamp: '2026-10-26T02:00:03.000Z', workspaceId: 'demo-workspace', sessionId: 'demo-session', executionId: 'demo-execution', agentId: 'analyst', type: 'agent.started', data: { agentRunId: 'run-analyst', parentAgentRunId: 'run-coordinator', task: '核对事件与接口接入缺口' } },
    { eventId: 'demo-event-4', seq: 4, timestamp: '2026-10-26T02:00:04.000Z', workspaceId: 'demo-workspace', sessionId: 'demo-session', executionId: 'demo-execution', agentId: 'researcher', type: 'tool.started', data: { toolCallId: 'tool-notes', agentRunId: 'run-researcher', name: 'demo.search_notes', argumentsComplete: false } },
    { eventId: 'demo-event-5', seq: 5, timestamp: '2026-10-26T02:00:05.000Z', workspaceId: 'demo-workspace', sessionId: 'demo-session', executionId: 'demo-execution', agentId: 'researcher', type: 'tool.arguments.delta', data: { toolCallId: 'tool-notes', argumentsDelta: '{"query":', argumentsComplete: false } },
    { eventId: 'demo-event-6', seq: 6, timestamp: '2026-10-26T02:00:06.000Z', workspaceId: 'demo-workspace', sessionId: 'demo-session', executionId: 'demo-execution', agentId: 'researcher', type: 'tool.arguments.delta', data: { toolCallId: 'tool-notes', argumentsDelta: '"多 Agent 界面与状态"}', argumentsComplete: true, arguments: { query: '多 Agent 界面与状态' } } },
    { eventId: 'demo-event-7', seq: 7, timestamp: '2026-10-26T02:00:07.000Z', workspaceId: 'demo-workspace', sessionId: 'demo-session', executionId: 'demo-execution', agentId: 'analyst', type: 'tool.started', data: { toolCallId: 'tool-capabilities', agentRunId: 'run-analyst', name: 'demo.inspect_capabilities', argumentsComplete: true, arguments: { scope: 'frontend-p0' } } },
    { eventId: 'demo-event-8', seq: 8, timestamp: '2026-10-26T02:00:08.000Z', workspaceId: 'demo-workspace', sessionId: 'demo-session', executionId: 'demo-execution', agentId: 'analyst', type: 'tool.completed', data: { toolCallId: 'tool-capabilities', status: 'completed', resultSummary: '演示结果：需对接运行事件、取消、文件和人工确认四类能力。' } },
    { eventId: 'demo-event-9', seq: 9, timestamp: '2026-10-26T02:00:09.000Z', workspaceId: 'demo-workspace', sessionId: 'demo-session', executionId: 'demo-execution', agentId: 'analyst', type: 'agent.completed', data: { agentRunId: 'run-analyst', resultSummary: '已完成接入缺口清单；此结果为开发演示数据。' } },
    { eventId: 'demo-event-10', seq: 10, timestamp: '2026-10-26T02:00:10.000Z', workspaceId: 'demo-workspace', sessionId: 'demo-session', executionId: 'demo-execution', agentId: 'researcher', type: 'tool.completed', data: { toolCallId: 'tool-notes', status: 'completed', resultSummary: '演示结果：已整理会话、执行详情与产物入口。' } },
    { eventId: 'demo-event-11', seq: 11, timestamp: '2026-10-26T02:00:11.000Z', workspaceId: 'demo-workspace', sessionId: 'demo-session', executionId: 'demo-execution', agentId: 'researcher', type: 'agent.completed', data: { agentRunId: 'run-researcher', resultSummary: '已整理页面与交互清单；此结果为开发演示数据。' } },
    { eventId: 'demo-event-12', seq: 12, timestamp: '2026-10-26T02:00:12.000Z', workspaceId: 'demo-workspace', sessionId: 'demo-session', executionId: 'demo-execution', agentId: 'coordinator', type: 'message.delta', data: { messageId: 'demo-answer', contentDelta: '建议先完成工作台闭环：任务输入、Agent 分工、工具执行、人工确认和产物交付。' } },
    { eventId: 'demo-event-13', seq: 13, timestamp: '2026-10-26T02:00:13.000Z', workspaceId: 'demo-workspace', sessionId: 'demo-session', executionId: 'demo-execution', agentId: 'coordinator', type: 'artifact.created', data: { artifactId: 'demo-artifact', agentRunId: 'run-coordinator', name: '前端页面清单.md', mediaType: 'text/markdown', status: 'available', previewText: '# 开发演示产物\n\n会话工作台、协作过程、工具详情、文件与产物、Agent 设置。', synthetic: true } },
    { eventId: 'demo-event-14', seq: 14, timestamp: '2026-10-26T02:00:14.000Z', workspaceId: 'demo-workspace', sessionId: 'demo-session', executionId: 'demo-execution', agentId: 'coordinator', type: 'run.completed', data: { status: 'completed', summary: '开发演示结束，无实际模型请求或工具执行。' } },
  ] satisfies TraceEvent[],
} as const;

export const traceEvents: TraceEvent[] = traceFixture.events.map(event => ({ ...event, data: { ...event.data } }));
