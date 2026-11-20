// Dev-only map states derived from the frozen nine-seat fixture (fixture.ts is read-only after WP0).
import type { AgentTask, ChatPipelineStage, ChatRecord, DriverCapability, TaskStatus } from '../../lib/chat-api';
import { observatoryFixture } from './fixture';

export interface PreviewOptions { stage: ChatPipelineStage; extraSeats: boolean; question: boolean; dispatch: 'before' | 'after' | null }

const GATES = new Set<ChatPipelineStage>(['gate-a', 'gate-b']);
const ENDED = new Set<ChatPipelineStage>(['completed', 'cancelled']);
/** The dispatch demo flips this task queued → running (claude → grok). */
export const DISPATCH_TASK = 'grok-scan';

/**
 * implementation / architecture / acceptance: the fixture's live mix, the lead waiting on its children (question=1 keeps
 * the fixture's open question on the lead). gate-a / gate-b: every task of the turn done, the pipeline holds at a user
 * gate. completed / cancelled: everything finished or stopped, nothing flows.
 */
export function previewChat({ stage, extraSeats, question, dispatch }: PreviewOptions) {
  const sample = observatoryFixture(stage, { extraSeats });
  const settle = (status: TaskStatus) => (task: AgentTask): AgentTask => task.turnId === 'turn-2' ? { ...task, status } : task;
  let tasks = sample.chat.tasks;
  let turnStatus: ChatRecord['turns'][number]['status'] = 'waiting_user';
  let tickets = sample.chat.tickets;
  if (GATES.has(stage) || stage === 'completed') {
    tasks = tasks.map(settle('completed'));
    turnStatus = 'completed';
    tickets = tickets.map(ticket => ({ ...ticket, status: 'resolved' as const, answer: '以验收清单为准', resolvedAt: ticket.createdAt }));
  } else if (stage === 'cancelled') {
    tasks = tasks.map(task => task.turnId === 'turn-2' && task.status !== 'completed' ? { ...task, status: 'cancelled' as const } : task);
    turnStatus = 'cancelled';
    tickets = tickets.map(ticket => ({ ...ticket, status: 'cancelled' as const }));
  } else if (!question) {
    tasks = tasks.map(task => task.id === 'root' ? { ...task, status: 'waiting_children' as const } : task);
    turnStatus = 'running';
    tickets = tickets.map(ticket => ({ ...ticket, status: 'resolved' as const, answer: '以验收清单为准', resolvedAt: ticket.createdAt }));
  }
  if (dispatch && !ENDED.has(stage) && !GATES.has(stage)) {
    const status: TaskStatus = dispatch === 'before' ? 'queued' : 'running';
    tasks = tasks.map(task => task.id === DISPATCH_TASK ? { ...task, status } : task);
  }
  const chat: ChatRecord = { ...sample.chat, tasks, tickets, turns: sample.chat.turns.map(turn => turn.id === 'turn-2' ? { ...turn, status: turnStatus } : turn) };
  return { ...sample, chat };
}

/** Welcome: every configured seat, one unavailable with its reason. */
export function previewCapabilities(capabilities: DriverCapability[]): DriverCapability[] {
  return capabilities.map(seat => seat.role === 'hydrogen' ? { ...seat, available: false, reason: '缺少密钥' } : seat);
}
