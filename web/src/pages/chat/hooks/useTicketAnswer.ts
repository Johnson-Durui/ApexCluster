// Answering the lead's question in the thread (BUILD-SPEC-B §4.5): the draft, the busy flag and the inline error. The
// error belongs to the ticket it was raised on, so a failed answer to one question never shows on the next question's
// card (not even for one frame, which a reset effect would allow, and role=alert would announce).
import { useState, type Dispatch } from 'react';
import { chatApi, type ChatRecord, type WaitTicket } from '../../../lib/chat-api';
import type { ChatAction } from '../chatModel';
import { explain } from './explain';

export interface TicketError { ticketId: string; message: string }

/** The error to show on `ticketId`'s card: only one raised on that same ticket. */
export function ticketErrorFor(error: TicketError | null, ticketId: string | undefined): string {
  return error && ticketId && error.ticketId === ticketId ? error.message : '';
}

export function useTicketAnswer(chat: ChatRecord | null, ticket: WaitTicket | undefined, dispatch: Dispatch<ChatAction>) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TicketError | null>(null);

  async function submit(text: string) {
    if (!chat || !ticket || busy || !text.trim()) return;
    setBusy(true); setError(null);
    try { dispatch({ type: 'chat', chat: await chatApi.answer(chat.id, ticket.id, text, crypto.randomUUID()) }); setValue(''); }
    catch (cause) { setError({ ticketId: ticket.id, message: explain(cause, '回答提交失败') }); }
    finally { setBusy(false); }
  }

  return { value, setValue, busy, error: ticketErrorFor(error, ticket?.id), submit };
}
