export interface TraceEvent {
  eventId: string;
  seq: number;
  timestamp: string;
  workspaceId: string;
  sessionId: string;
  executionId: string;
  agentId: string;
  type: string;
  data: Record<string, unknown>;
}

export interface TraceAgent {
  id: string;
  name: string;
  role: string;
  agentRunId: string | null;
  parentAgentRunId: string | null;
  task: string | null;
  status: 'queued' | 'running' | 'completed' | 'cancelled';
  resultSummary: string | null;
}

export interface TraceTool {
  id: string;
  agentId: string;
  agentRunId: string | null;
  name: string;
  status: 'building' | 'running' | 'completed' | 'failed' | 'cancelled';
  argumentsText: string;
  arguments: Record<string, unknown> | null;
  argumentError: string | null;
  resultSummary: string | null;
}

export interface TraceArtifact {
  id: string;
  agentRunId: string | null;
  name: string;
  mediaType: string;
  status: string;
  previewText: string;
  synthetic: boolean;
}

export interface TraceScope {
  key: string;
  workspaceId: string;
  sessionId: string;
  executionId: string;
  title: string;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
  summary: string | null;
  lastSeq: number;
  processed: number;
  ignored: number;
  seenEventIds: string[];
  agents: Record<string, TraceAgent>;
  tools: Record<string, TraceTool>;
  messages: Record<string, string>;
  artifacts: Record<string, TraceArtifact>;
}

export interface TraceState { scopes: Record<string, TraceScope> }

export const initialTraceState: TraceState = { scopes: {} };
export const traceScopeKey = (event: Pick<TraceEvent, 'workspaceId' | 'sessionId' | 'executionId'>) => `${event.workspaceId}/${event.sessionId}/${event.executionId}`;

function emptyScope(event: TraceEvent): TraceScope {
  return {
    key: traceScopeKey(event), workspaceId: event.workspaceId, sessionId: event.sessionId, executionId: event.executionId,
    title: '等待演示事件', status: 'idle', summary: null, lastSeq: 0, processed: 0, ignored: 0,
    seenEventIds: [], agents: {}, tools: {}, messages: {}, artifacts: {},
  };
}

const text = (value: unknown) => typeof value === 'string' ? value : null;
const object = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

function upsertAgent(scope: TraceScope, agentId: string, patch: Partial<TraceAgent>) {
  const current = scope.agents[agentId] ?? {
    id: agentId, name: agentId, role: '', agentRunId: null, parentAgentRunId: null,
    task: null, status: 'queued' as const, resultSummary: null,
  };
  scope.agents[agentId] = { ...current, ...patch };
}

/** 纯前端演示适配器：按运行边界隔离、按 eventId/seq 去重，不进行网络或持久化。 */
export function applyTraceEvent(state: TraceState, event: TraceEvent): TraceState {
  if (!event.eventId || !Number.isFinite(event.seq) || event.seq < 1 || !event.workspaceId || !event.sessionId || !event.executionId) return state;
  const key = traceScopeKey(event);
  const previous = state.scopes[key] ?? emptyScope(event);
  if (previous.seenEventIds.includes(event.eventId) || event.seq <= previous.lastSeq) return state;

  const scope: TraceScope = {
    ...previous,
    lastSeq: event.seq,
    processed: previous.processed + 1,
    seenEventIds: [...previous.seenEventIds, event.eventId],
    agents: { ...previous.agents }, tools: { ...previous.tools }, messages: { ...previous.messages }, artifacts: { ...previous.artifacts },
  };
  const data = event.data ?? {};

  switch (event.type) {
    case 'run.started': {
      scope.title = text(data.title) ?? scope.title;
      if (scope.status !== 'cancelled') scope.status = 'running';
      const participants = Array.isArray(data.participants) ? data.participants : [];
      for (const participant of participants) {
        const item = object(participant);
        const id = text(item?.id);
        if (id) upsertAgent(scope, id, { name: text(item?.name) ?? id, role: text(item?.role) ?? '' });
      }
      upsertAgent(scope, event.agentId, { agentRunId: text(data.rootAgentRunId), status: scope.status === 'cancelled' ? 'cancelled' : 'running' });
      break;
    }
    case 'agent.started':
      upsertAgent(scope, event.agentId, {
        agentRunId: text(data.agentRunId), parentAgentRunId: text(data.parentAgentRunId), task: text(data.task),
        status: scope.status === 'cancelled' ? 'cancelled' : 'running',
      });
      break;
    case 'agent.completed':
      upsertAgent(scope, event.agentId, {
        agentRunId: text(data.agentRunId), resultSummary: text(data.resultSummary),
        status: scope.status === 'cancelled' ? 'cancelled' : 'completed',
      });
      break;
    case 'tool.started': {
      const id = text(data.toolCallId);
      if (!id) break;
      const complete = data.argumentsComplete === true;
      scope.tools[id] = {
        id, agentId: event.agentId, agentRunId: text(data.agentRunId), name: text(data.name) ?? '未命名工具',
        status: scope.status === 'cancelled' ? 'cancelled' : complete ? 'running' : 'building', argumentsText: '',
        arguments: object(data.arguments), argumentError: null, resultSummary: null,
      };
      break;
    }
    case 'tool.arguments.delta': {
      const id = text(data.toolCallId);
      const current = id ? scope.tools[id] : null;
      if (!id || !current) break;
      const argumentsText = current.argumentsText + (text(data.argumentsDelta) ?? '');
      let args = object(data.arguments) ?? current.arguments;
      let argumentError: string | null = null;
      if (data.argumentsComplete === true && !args) {
        try { args = object(JSON.parse(argumentsText)); }
        catch { argumentError = '完整参数不是有效 JSON'; }
      }
      scope.tools[id] = {
        ...current, argumentsText, arguments: args, argumentError,
        status: scope.status === 'cancelled' ? 'cancelled' : data.argumentsComplete === true ? (argumentError ? 'failed' : 'running') : 'building',
      };
      break;
    }
    case 'tool.completed': {
      const id = text(data.toolCallId);
      const current = id ? scope.tools[id] : null;
      if (!id || !current) break;
      scope.tools[id] = {
        ...current,
        status: scope.status === 'cancelled' ? 'cancelled' : data.status === 'failed' ? 'failed' : 'completed',
        resultSummary: text(data.resultSummary),
      };
      break;
    }
    case 'message.delta': {
      if (scope.status === 'cancelled') break;
      const id = text(data.messageId);
      if (id) scope.messages[id] = (scope.messages[id] ?? '') + (text(data.contentDelta) ?? '');
      break;
    }
    case 'artifact.created': {
      if (scope.status === 'cancelled') break;
      const id = text(data.artifactId);
      if (id) scope.artifacts[id] = {
        id, agentRunId: text(data.agentRunId), name: text(data.name) ?? '未命名产物', mediaType: text(data.mediaType) ?? 'text/plain',
        status: text(data.status) ?? 'available', previewText: text(data.previewText) ?? '', synthetic: data.synthetic === true,
      };
      break;
    }
    case 'run.completed':
      if (scope.status !== 'cancelled') {
        scope.status = data.status === 'failed' ? 'failed' : 'completed';
        scope.summary = text(data.summary);
        upsertAgent(scope, event.agentId, { status: scope.status === 'completed' ? 'completed' : 'cancelled' });
      }
      break;
    default:
      scope.ignored += 1;
  }
  return { scopes: { ...state.scopes, [key]: scope } };
}

export function cancelTraceScope(state: TraceState, key: string): TraceState {
  const previous = state.scopes[key];
  if (!previous || previous.status === 'completed' || previous.status === 'failed' || previous.status === 'cancelled') return state;
  const agents = Object.fromEntries(Object.entries(previous.agents).map(([id, agent]) => [id, agent.status === 'running' || agent.status === 'queued' ? { ...agent, status: 'cancelled' as const } : agent]));
  const tools = Object.fromEntries(Object.entries(previous.tools).map(([id, tool]) => [id, tool.status === 'running' || tool.status === 'building' ? { ...tool, status: 'cancelled' as const } : tool]));
  return { scopes: { ...state.scopes, [key]: { ...previous, status: 'cancelled', summary: '开发演示已在浏览器内取消。', agents, tools } } };
}

export function replayTrace(events: TraceEvent[]): TraceState {
  return events.reduce(applyTraceEvent, initialTraceState);
}
