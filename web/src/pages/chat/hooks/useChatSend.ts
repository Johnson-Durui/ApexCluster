// Composer state and the send path: the per-chat draft (sessionStorage), pending uploads (uploaded at send time),
// cost confirmation, run mode for a new chat, create → upload → send, and the steering acknowledgement.
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch } from 'react';
import { chatApi, type ChatAttachment, type ChatMessage, type ChatRecord, type ChatTeamConfiguration } from '../../../lib/chat-api';
import { FIXED_DEMO_PROMPT, isFixedDemoId, isFixedDemoPrompt } from '../../../lib/fixed-demo';
import { isSteeringAcknowledgement, type ChatAction } from '../chatModel';
import { persistCostConfirmed, readCostConfirmed, revokeCostConfirmation } from '../composer/costConfirm';
import type { PendingUpload } from '../composer/Composer';
import { DEFAULT_TEAM_DRAFT, parseTeamDraft, seedLeadIfEmpty, validateTeamDraft, type TeamDraft } from '../composer/teamConfig';
import { explain } from './explain';

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_BATCH = 10;
const draftKey = (chatId: string) => `dmw:chat:draft:${chatId}`;
const newId = () => crypto.randomUUID();

export function validateAttachmentFiles(files: File[]): { accepted: File[]; error?: string } {
  const selected = files.slice(0, MAX_ATTACHMENT_BATCH);
  const oversized = selected.find(file => file.size > MAX_ATTACHMENT_BYTES);
  const accepted = selected.filter(file => file.size <= MAX_ATTACHMENT_BYTES);
  const errors = [];
  if (files.length > MAX_ATTACHMENT_BATCH) errors.push(`每批最多选择 ${MAX_ATTACHMENT_BATCH} 个文件，已保留前 ${MAX_ATTACHMENT_BATCH} 个。`);
  if (oversized) errors.push(`“${oversized.name}”超过 20 MiB，未加入。`);
  return { accepted, error: errors.length ? errors.join(' ') : undefined };
}

async function fileBase64(file: File): Promise<string> {
  const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error ?? new Error('文件读取失败')); reader.readAsDataURL(file); });
  return data.slice(data.indexOf(',') + 1);
}

type Draft = { text: string; clientMessageId: string; error: string; workspaceId: string; mode: 'normal' | 'pipeline'; preset: string; auto: boolean; team: TeamDraft };
function readDraft(chatId: string): Draft {
  try {
    const value = JSON.parse(sessionStorage.getItem(draftKey(chatId)) ?? '{}') as Record<string, unknown>;
    return {
      text: typeof value.text === 'string' ? value.text : '',
      clientMessageId: typeof value.clientMessageId === 'string' ? value.clientMessageId : newId(),
      error: typeof value.error === 'string' ? value.error : '',
      workspaceId: typeof value.workspaceId === 'string' ? value.workspaceId : '',
      mode: value.mode === 'pipeline' ? 'pipeline' : 'normal',
      preset: typeof value.preset === 'string' ? value.preset : '',
      auto: value.auto === true,
      team: parseTeamDraft(value.team),
    };
  } catch { return { text: '', clientMessageId: newId(), error: '', workspaceId: '', mode: 'normal', preset: '', auto: false, team: { ...DEFAULT_TEAM_DRAFT, members: [] } }; }
}
function writeSession(key: string, value: string | null) {
  try { if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value); } catch { /* drafts are a convenience */ }
}

export interface SendOptions {
  chat: ChatRecord | null;
  messages: ChatMessage[];
  fresh: boolean;
  /** The draft slot is ready (not loading, chat id known). */
  ready: boolean;
  dispatch: Dispatch<ChatAction>;
  workspace: string;
  setWorkspace(id: string): void;
  workspaceBusy: boolean;
  demoParam: boolean;
  defaultPreset?: string;
  teamConfiguration?: ChatTeamConfiguration | null;
  handoff: { current: string };
  startDemo(): Promise<void>;
}

export function useChatSend(options: SendOptions) {
  const { chat, fresh, ready, dispatch, workspace, teamConfiguration } = options;
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [draftError, setDraftError] = useState('');
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [costConfirmed, setCostConfirmed] = useState(readCostConfirmed);
  const [mode, setMode] = useState<'normal' | 'pipeline'>('normal');
  const [preset, setPreset] = useState('');
  const [auto, setAuto] = useState(false);
  const [teamDraft, setTeamDraft] = useState<TeamDraft>(() => ({ ...DEFAULT_TEAM_DRAFT, members: [] }));
  const [steeringAck, setSteeringAck] = useState(false);
  const clientMessageId = useRef<string>(newId());
  const created = useRef('');
  const opts = useRef(options);
  opts.current = options;
  const slot = fresh ? 'new' : chat?.id ?? '';

  useEffect(() => {
    if (!ready || !slot) return;
    const draft = readDraft(slot);
    setInput(slot === 'new' && opts.current.demoParam ? FIXED_DEMO_PROMPT : draft.text);
    clientMessageId.current = draft.clientMessageId;
    setError(draft.error);
    setDraftError(draft.error);
    if (slot === 'new') {
      if (draft.workspaceId) opts.current.setWorkspace(draft.workspaceId);
      setMode(draft.mode); setPreset(draft.preset); setAuto(draft.auto);
      setTeamDraft(seedLeadIfEmpty(draft.team, opts.current.teamConfiguration));
    }
  }, [slot, ready]);

  useEffect(() => {
    if (!preset && options.defaultPreset) setPreset(options.defaultPreset);
  }, [options.defaultPreset, preset]);

  useEffect(() => {
    if (!teamConfiguration) return;
    setTeamDraft(current => seedLeadIfEmpty(current, teamConfiguration));
  }, [teamConfiguration]);

  const teamValidation = useMemo(
    () => (fresh || !chat) && mode === 'normal' ? validateTeamDraft(teamDraft, teamConfiguration) : { valid: true, hasReviewer: false },
    [fresh, chat, mode, teamDraft, teamConfiguration],
  );

  useEffect(() => {
    if (!ready || !slot || (fresh && created.current)) return;
    writeSession(draftKey(slot), JSON.stringify({
      text: input,
      clientMessageId: clientMessageId.current,
      error: draftError || undefined,
      workspaceId: fresh ? workspace || undefined : undefined,
      mode: fresh ? mode : undefined,
      preset: fresh && mode === 'pipeline' ? preset : undefined,
      auto: fresh && mode === 'pipeline' ? auto : undefined,
      team: fresh && teamDraft.mode === 'custom' ? teamDraft : undefined,
    }));
  }, [slot, ready, fresh, input, draftError, workspace, mode, preset, auto, teamDraft]);

  const addFiles = useCallback((files: File[]) => {
    setPending(current => {
      const room = Math.max(0, MAX_ATTACHMENT_BATCH - current.length);
      const checked = validateAttachmentFiles(files);
      const accepted = checked.accepted.slice(0, room);
      const errors = [checked.error, checked.accepted.length > room ? `每条消息最多附带 ${MAX_ATTACHMENT_BATCH} 个文件。` : undefined].filter(Boolean);
      if (errors.length) setError(errors.join(' '));
      return [...current, ...accepted.map(file => ({ id: newId(), file, status: 'queued' as const }))];
    });
  }, []);
  const patch = (id: string, value: Partial<PendingUpload>) => setPending(current => current.map(item => item.id === id ? { ...item, ...value } : item));
  async function uploadOne(chatId: string, item: PendingUpload): Promise<ChatAttachment | null> {
    if (item.attachment) return item.attachment;
    patch(item.id, { status: 'uploading', error: undefined });
    try {
      const attachment = await chatApi.uploadAttachment(chatId, { name: item.file.name, base64: await fileBase64(item.file), clientUploadId: item.id });
      patch(item.id, { status: 'uploaded', attachment });
      return attachment;
    } catch (cause) { patch(item.id, { status: 'failed', error: explain(cause, '附件上传失败') }); return null; }
  }
  async function retryUpload(item: PendingUpload) {
    const target = chat?.id ?? created.current;
    if (!target) { patch(item.id, { status: 'queued', error: undefined }); return; }
    await uploadOne(target, item);
  }
  async function removeUpload(item: PendingUpload) {
    const target = chat?.id ?? created.current;
    if (target && item.attachment) {
      try { await chatApi.deleteAttachment(target, item.attachment.id); }
      catch (cause) { setError(explain(cause, '附件移除失败')); return; }
    }
    setPending(current => current.filter(candidate => candidate.id !== item.id));
  }

  async function send() {
    const text = input;
    const { messages, workspaceBusy } = opts.current;
    if ((!text.trim() && !pending.length) || sending || workspaceBusy) return;
    if ((fresh || !chat) && isFixedDemoPrompt(text)) {
      if (pending.length) { setError('固定演示只使用这条提示词，请先移除附件。'); return; }
      await opts.current.startDemo();
      return;
    }
    if (isFixedDemoId(chat?.id)) { setError('此会话是固定演示，请点击“重新演示”，或新建聊天处理其他需求。'); return; }
    if (!costConfirmed) { setError('首次发送前，请明确确认本会话会消耗模型额度。'); return; }
    if ((fresh || !chat) && mode === 'pipeline' && !workspace) { setError('流水线需要先授权一个项目目录。'); return; }
    if ((fresh || !chat) && mode === 'pipeline' && !preset) { setError('请选择一个可用的流水线预设。'); return; }
    if ((fresh || !chat) && mode === 'normal' && teamDraft.mode === 'custom' && !teamValidation.valid) {
      setError(teamValidation.error || '请完善自定义协作团队配置。');
      return;
    }
    const requestChat = !fresh ? chat : null;
    setSteeringAck(false);
    persistCostConfirmed();
    setSending(true); setError(''); setDraftError('');
    let createdId = '';
    try {
      const title = text.trim().split(/\r?\n/)[0].slice(0, 40) || pending[0]?.file.name || '附件任务';
      const createBody = {
        title,
        workspaceId: workspace || undefined,
        ...(mode === 'pipeline' ? { pipeline: { preset, auto } } : teamValidation.payload ? { team: teamValidation.payload } : {}),
      };
      const target = !fresh && chat ? chat : await chatApi.create(createBody);
      if (fresh || !chat) {
        createdId = target.id;
        created.current = target.id;
        opts.current.handoff.current = target.id;
        writeSession(draftKey(target.id), JSON.stringify({ text, clientMessageId: clientMessageId.current }));
        writeSession(draftKey('new'), null);
        dispatch({ type: 'chat', chat: target });
      }
      const uploaded = await Promise.all(pending.map(item => uploadOne(target.id, item)));
      if (uploaded.some(item => !item)) throw new Error('部分附件上传失败。可在输入框上方重试后再次发送。');
      const result = await chatApi.send(target.id, text.trim() ? text : '请处理这些附件。', clientMessageId.current, true, uploaded.map(item => item!.id));
      dispatch({ type: 'chat', chat: result.chat });
      dispatch({ type: 'message', message: result.message });
      if (isSteeringAcknowledgement(requestChat, messages, result.chat.id, result.message)) setSteeringAck(true);
      setInput(''); setPending([]); writeSession(draftKey(target.id), null); clientMessageId.current = newId();
      window.dispatchEvent(new Event('workbench:chat-created'));
    } catch (cause) {
      const message = explain(cause, '发送失败，草稿已保留');
      setError(message); setDraftError(message);
      if (createdId) writeSession(draftKey(createdId), JSON.stringify({ text, clientMessageId: clientMessageId.current, error: message }));
    } finally {
      setSending(false);
      if (createdId) {
        window.dispatchEvent(new Event('workbench:chat-created'));
        location.hash = `/?chat=${encodeURIComponent(createdId)}`;
      }
    }
  }

  const confirmCost = (checked: boolean) => setCostConfirmed(checked);
  const revokeCost = () => { revokeCostConfirmation(); setCostConfirmed(false); };
  return {
    input, setInput, error, setError, sending, setSending, pending, addFiles, retryUpload, removeUpload, send,
    costConfirmed, confirmCost, revokeCost, mode, setMode, preset, setPreset, auto, setAuto, teamDraft, setTeamDraft, teamValidation, steeringAck,
    resetDraft: () => { setInput(''); setPending([]); setTeamDraft({ ...DEFAULT_TEAM_DRAFT, members: [] }); writeSession(draftKey('new'), null); clientMessageId.current = newId(); },
    newMessageId: newId,
  };
}
