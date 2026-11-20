import { api, ApiError, initSession } from './api';
import { cancelFixedDemo, fixedDemoArtifactUrl, getFixedDemoSnapshot, isFixedDemoId, listFixedDemos } from './fixed-demo';

export type ChatRole = string;
export type TaskStatus = 'queued' | 'running' | 'waiting_user' | 'waiting_children' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type InvocationStatus = 'running' | 'exited' | 'exit_unknown';

export interface ChatMessage {
  id: string; seq: number; role: 'user' | 'assistant' | 'system'; text: string;
  auto?: true;
  /** Set on the message that records a pipeline gate decision (runtime.decidePipelineGate). Rendered as a receipt. */
  pipelineGate?: { id: 'A' | 'B'; revision: number; decision: 'confirm' | 'revise' | 'cancel' };
  createdAt: string; turnId?: string; taskId?: string; clientMessageId?: string; attachmentIds?: string[];
}
export interface ChatTurn { id: string; rootTaskId: string; status: TaskStatus; createdAt: string; completedAt?: string }
export interface AgentTask {
  id: string; turnId: string; parentTaskId?: string; role: ChatRole; goal: string;
  status: TaskStatus; createdAt: string; updatedAt: string; segment: number;
  result?: string; resultRef?: string; error?: string; disposition?: 'adopted' | 'rejected' | 'reference';
  invocationIds: string[]; noProgressSegments: number; checkpointId?: string;
  workspaceId?: string; workspaceVersion?: number; mode: 'read' | 'edit' | 'verify';
  groupId?: string;
  profileId?: 'general' | 'document' | 'spreadsheet' | 'presentation' | 'research' | 'image';
  evidenceHashes?: string[]; sourceCoverage?: Record<string, number[]>; sourceCoverageHashes?: Record<string, string>;
}
export interface Invocation {
  id: string; taskId: string; segment: number; status: InvocationStatus; startedAt: string; endedAt?: string;
  toolCount: number; promptVersion: string; inputEstimate: number; contextWindow: number | null;
  contextUsed: number | null; exitConfirmed?: boolean; finishReason?: string;
  model?: string; effort?: string; contextHard?: number; peakUsed?: number; rotationReason?: string;
}
export interface WaitTicket {
  id: string; taskId: string; invocationId: string; type: 'user' | 'children' | 'tool';
  question?: string; options?: string[]; childIds?: string[]; status: 'pending' | 'resolved' | 'cancelled';
  createdAt: string; resolvedAt?: string; answer?: string; externalId?: string; resultRef?: string;
}
export interface ChatArtifact {
  id: string; taskId: string; name: string; relativePath: string; hash: string; bytes: number;
  kind: 'file' | 'diff' | 'test' | 'report'; createdAt: string;
  provenance?: 'model' | 'workspace' | 'runner'; binding?: { beforeSnapshotId: string; afterSnapshotId: string };
  projectExport?: ProjectExport;
}
export type ProjectExport = { status: 'saved'; path: string; relativePath: string; workspaceId: string; version: number; hash: string } | { status: 'failed'; error: string };
export interface ChatAttachment {
  id: string; name: string; bytes: number; hash: string; mime: string; createdAt: string;
  source: 'upload' | 'generated'; taskId?: string; invocationId?: string; clientUploadId?: string; messageIds?: string[]; inputHashes?: string[];
  projectExport?: ProjectExport;
}
export interface ChatTodo {
  id: string; taskId: string; text: string; status: 'pending' | 'in_progress' | 'completed' | 'failed';
  dependsOn?: string[]; linkedTaskIds?: string[]; evidenceRefs?: string[]; updatedAt: string;
}
export interface ChatStream {
  invocationId: string; taskId: string; role: ChatRole; text: string; status: InvocationStatus | 'rotated';
}
export interface Checkpoint {
  id: string; taskId: string; invocationId: string; createdAt: string; goal: string;
  constraintMessageIds: string[]; taskStates: Array<{ id: string; status: TaskStatus }>;
  pendingTicketIds: string[]; artifactIds: string[]; next: string; note?: string;
}
export interface ChatRecord {
  version: 1; id: string; title: string; createdAt: string; updatedAt: string; workspaceId?: string;
  seq: number; messageSeq: number; turns: ChatTurn[]; tasks: AgentTask[]; invocations: Invocation[];
  tickets: WaitTicket[]; artifacts: ChatArtifact[]; checkpoints: Checkpoint[];
  constraintMessageIds: string[]; blockedReason?: string; attachments?: ChatAttachment[]; todos?: ChatTodo[];
  pipeline?: ChatPipeline;
  fanoutGroups?: Array<{ id: string; parentTaskId: string; pool: string; total: number }>;
  apiUsage?: { tokens: number; usd: number; unpriced: number };
}
export type ChatPipelineStage = 'architecture' | 'gate-a' | 'implementation' | 'acceptance' | 'gate-b' | 'completed' | 'cancelled';
export type PipelineGateId = 'A' | 'B';
export type PipelineGateAction = { decision: 'confirm' | 'revise' | 'cancel'; feedback?: string };
export interface ChatPipeline {
  preset: string;
  stage: ChatPipelineStage;
  revision: number;
  gates: { clarify: 'user' | 'auto'; architecture: 'user' | 'auto'; delivery: 'user' | 'auto' };
  implementation?: { error?: string; milestones: Array<{ id: string; status: string }> };
}
export interface ChatSummary { id: string; title: string; workspaceId?: string; updatedAt: string; status: string }
export interface ChatEvent {
  seq: number; chatId: string; type: string; at: string; data: unknown;
  taskId?: string; parentTaskId?: string; invocationId?: string; turnId?: string;
}
export interface DriverCapability {
  role: ChatRole; available: boolean; reason?: string; version?: string;
  fingerprint?: string; isolationVerified: boolean; contextWindow?: number;
  model?: string; effort?: string; contextHard?: number;
}
export interface ApiChatConfiguration {
  mode: 'api' | 'cli';
  keyReadiness: Array<{ provider: string; env: string; configured: boolean }>;
  modelChecks: Array<{ id: string; provider: string; status: 'verified' | 'not_listed' | 'error' | 'unchecked' | 'stale' | 'simulated' }>;
  presets: Array<{ id: string; rootSeat: string; seats: DriverCapability[]; available: boolean; reason?: string }>;
}
export interface ChatCapabilities {
  drivers: DriverCapability[]; runner: { available: boolean; reason?: string }; nativePicker: boolean;
  dataRoot: string; unavailableReason?: string; services: ServiceCapability[];
  exec?: ExecCapability;
  apiConfiguration?: ApiChatConfiguration;
}
export interface ExecCapability {
  backend: 'docker' | 'wsl-bwrap' | 'windows-mxc' | 'local-unsafe' | null;
  available: boolean;
  reason?: string;
  unsafe: boolean;
}
export type ServiceState = 'disabled' | 'unconfigured' | 'unavailable' | 'unhealthy' | 'drifted' | 'ready' | 'degraded';
export interface ServiceCapability { id: string; name: string; state: ServiceState; reason?: string; tools: string[]; fingerprint?: string }
export interface SkillSetting { id: string; root: string; enabled: boolean }
export interface McpSetting {
  id: string; enabled: boolean; transport: 'stdio' | 'http'; dockerCli?: string; dockerCliSha256?: string; image?: string; serverArgs?: string[]; url?: string;
  toolAllowlist: string[]; allowWrites: boolean; writeToolAllowlist: string[]; timeoutMs: number; maxOutputBytes: number;
  toolAccess: Record<string, 'read' | 'write'>; apiKeyEnv?: string; apiKeyHeader?: 'Authorization' | 'x-api-key'; searchTool?: string;
}
export interface MediaSetting { enabled: boolean; endpoint: string; editEndpoint?: string; model: string; apiKeyEnv: string; allowPaidCalls: boolean; timeoutMs: number; maxOutputBytes: number }
export interface CodexMediaSetting { enabled: boolean; allowSubscriptionCalls: boolean; timeoutMs: number }
export interface ChatSettings {
  version: 1; skills: SkillSetting[]; mcp: McpSetting[]; media: { vision?: MediaSetting; image?: MediaSetting; codex?: CodexMediaSetting };
  documentWorker: { enabled: boolean; url: string };
}
export interface ChatSnapshot { chat: ChatRecord; messages: ChatMessage[]; nextBefore?: number; capabilities: DriverCapability[]; streams?: ChatStream[]; recentEvents?: ChatEvent[] }
export interface MessagePage { items: ChatMessage[]; nextBefore?: number }
export interface WorkspaceGrant {
  id: string; path: string; name: string; version: number; active: boolean; grantedAt: string; revokedAt?: string;
}
export interface WorkspaceSelection {
  requestId: string; status: 'pending' | 'selected' | 'cancelled'; expiresAt: number; workspace?: WorkspaceGrant;
}
async function putSettings(body: ChatSettings): Promise<ChatSettings> {
  const token = await initSession();
  const response = await fetch('/api/chat-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-workbench-token': token }, body: JSON.stringify(body) });
  const text = await response.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = { error: text || '服务未返回数据' }; }
  if (!response.ok) throw new ApiError((data as { error?: string }).error || `请求失败（${response.status}）`, response.status);
  return data as ChatSettings;
}
export const chatApi = {
  list: async (signal?: AbortSignal) => [...await api.get<ChatSummary[]>('/api/chats', signal), ...listFixedDemos()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  create: (body: { title?: string; workspaceId?: string; pipeline?: { preset: string; auto: boolean } } = {}) => api.post<ChatRecord>('/api/chats', body),
  decideGate: (id: string, gate: PipelineGateId, decision: PipelineGateAction) => api.post<ChatRecord>(`/api/chats/${id}/gates/${gate}`, decision),
  get: (id: string, signal?: AbortSignal) => isFixedDemoId(id) ? getFixedDemoSnapshot(id) : api.get<ChatSnapshot>(`/api/chats/${id}`, signal),
  capabilities: (signal?: AbortSignal) => api.get<ChatCapabilities>('/api/chat-capabilities', signal),
  trace: (id: string, since: number, signal?: AbortSignal) => api.get<{ items: ChatEvent[]; nextSince?: number }>(`/api/chats/${id}/trace?since=${since}`, signal),
  settings: (signal?: AbortSignal) => api.get<ChatSettings>('/api/chat-settings', signal),
  saveSettings: (settings: ChatSettings) => putSettings(settings),
  messages: (id: string, before: number, signal?: AbortSignal): Promise<MessagePage> => isFixedDemoId(id) ? getFixedDemoSnapshot(id).then(snapshot => ({ items: snapshot.messages.filter(message => message.seq < before) })) : api.get<MessagePage>(`/api/chats/${id}/messages?before=${before}&limit=50`, signal),
  send: (id: string, text: string, clientMessageId: string, confirmCost: boolean, attachmentIds?: string[]) => isFixedDemoId(id) ? Promise.reject(new Error('此会话是固定演示，请点击“重新演示”，或新建聊天处理其他需求。')) : api.post<{ chat: ChatRecord; message: ChatMessage }>(`/api/chats/${id}/messages`, { text, clientMessageId, confirmCost, ...(attachmentIds?.length ? { attachmentIds } : {}) }),
  attachments: (id: string, signal?: AbortSignal) => isFixedDemoId(id) ? Promise.resolve<ChatAttachment[]>([]) : api.get<ChatAttachment[]>(`/api/chats/${id}/attachments`, signal),
  uploadAttachment: (id: string, body: { name: string; base64: string; clientUploadId: string }) => isFixedDemoId(id) ? Promise.reject(new Error('固定演示不接受附件，请新建普通聊天。')) : api.post<ChatAttachment>(`/api/chats/${id}/attachments`, body),
  deleteAttachment: (chatId: string, attachmentId: string) => isFixedDemoId(chatId) ? Promise.reject(new Error('固定演示没有可删除的附件。')) : api.delete<{ deleted: true }>(`/api/chats/${chatId}/attachments/${attachmentId}`, {}),
  attachmentUrl: (chatId: string, attachmentId: string, preview = false) => `/api/chats/${chatId}/attachments/${attachmentId}${preview ? '?preview=1' : ''}`,
  answer: (id: string, ticketId: string, text: string, clientMessageId: string) => isFixedDemoId(id) ? Promise.reject(new Error('固定演示无需回答问题，请新建普通聊天处理需求。')) : api.post<ChatRecord>(`/api/chats/${id}/answers`, { ticketId, text, clientMessageId }),
  cancel: (id: string) => isFixedDemoId(id) ? cancelFixedDemo(id) : api.post<ChatRecord>(`/api/chats/${id}/cancel`, {}),
  workspaces: (signal?: AbortSignal) => api.get<WorkspaceGrant[]>('/api/workspaces', signal),
  selectWorkspace: () => api.post<WorkspaceSelection>('/api/workspaces/select', {}),
  pollWorkspace: (id: string, signal?: AbortSignal) => api.get<WorkspaceSelection>(`/api/workspaces/select/${id}`, signal),
  revokeWorkspace: (id: string) => api.delete<{ revoked: true }>(`/api/workspaces/${id}`, {}),
  artifactUrl: (chatId: string, artifactId: string) => isFixedDemoId(chatId) ? fixedDemoArtifactUrl(chatId, artifactId) : `/api/chats/${chatId}/artifacts/${artifactId}`,
};
