// Project control (BUILD-SPEC-B §4.7): one popover replaces 添加项目 + 已有项目 for a new chat; an existing chat shows a
// read-only chip, and an existing chat that is still loading (or failed to load) shows a disabled placeholder chip,
// never the new-chat picker (§4.6). Revoking a grant asks inline (no window.confirm). A successful OS folder pick
// closes the popover, as choosing from the list does.
import { useRef, useState } from 'react';
import Popover from '../../../components/Popover';
import { Icon } from '../../../components/ui';
import type { ChatRecord, WorkspaceGrant } from '../../../lib/chat-api';

/** Runs the OS folder pick; closes the panel only when a folder was selected and the panel is still open. */
export async function chooseAndClose(choose: () => Promise<boolean> | void, isOpen: () => boolean, close: () => void): Promise<void> {
  const picked = await choose();
  if (picked === true && isOpen()) close();
}

/** Popover's close returns focus to its trigger; keep focus where it is when the user has already moved it elsewhere. */
const closeKeepingFocus = (close: () => void) => () => {
  const keep = document.activeElement;
  close();
  if (keep instanceof HTMLElement && keep !== document.body && !keep.closest('.project-pop')) keep.focus({ preventScroll: true });
};

export function ProjectControl({ chat, unavailable = false, workspaces, selected, busy, sending, nativePicker, onSelect, onChoose, onRevoke }: {
  chat: ChatRecord | null;
  /** An existing chat that is not loaded: 'loading' (skeleton) or 'failed'. Shows a disabled chip instead of the picker. */
  unavailable?: false | 'loading' | 'failed';
  workspaces: WorkspaceGrant[];
  selected: string;
  busy: boolean;
  sending: boolean;
  nativePicker?: boolean;
  onSelect(id: string): void;
  /** Resolves to true when a folder was picked and selected. */
  onChoose(): Promise<boolean> | void;
  onRevoke(id: string): void;
}) {
  const [manage, setManage] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const open = useRef(false);
  const bound = workspaces.find(item => item.id === (chat?.workspaceId ?? selected));
  if (chat) {
    return <span className="workspace-chip c-pill is-static" title={bound?.path ?? (chat.workspaceId ? '已绑定的工作区当前不可用' : '未授权项目目录')}>
      <Icon name={chat.workspaceId ? 'folder' : 'monitor'} size={14} /><span>{bound?.name ?? (chat.workspaceId ? '工作区不可用' : '仅对话')}</span>
    </span>;
  }
  if (unavailable) {
    const words = unavailable === 'loading' ? '项目目录…' : '项目目录不可用';
    return <span className="workspace-chip c-pill is-static is-unavailable" aria-disabled="true" title={unavailable === 'loading' ? '正在恢复聊天' : '聊天未加载，无法读取它的项目目录'}>
      <Icon name="folder" size={14} /><span>{words}</span>
    </span>;
  }
  const pickerOff = nativePicker === false;
  return <Popover label="项目目录" placement="up" buttonClassName="c-pill workspace-open" panelClassName="project-pop" onOpenChange={next => { open.current = next; }}
    button={<><Icon name="folder" size={14} /><span>{bound ? `项目：${bound.name}` : '仅对话 · 未授权目录'}</span><Icon name="chevron-down" size={12} /></>}>
    {close => <>
      <h2>项目目录</h2>
      <label className="field"><span className="sr-only">项目工作区</span>
        <select value={selected} disabled={sending || busy} onChange={event => { onSelect(event.target.value); close(); }}>
          <option value="">仅对话，不授权目录</option>
          {workspaces.map(item => <option key={item.id} value={item.id}>{item.name} — {item.path}</option>)}
        </select>
      </label>
      <button type="button" className="btn sm workspace-choose" onClick={() => void chooseAndClose(onChoose, () => open.current, closeKeepingFocus(close))} disabled={sending || busy || pickerOff} title={pickerOff ? '当前启动方式未连接系统目录选择器' : '打开系统文件夹选择窗口'}><Icon name="folder" size={14} />{busy ? '等待目录选择…' : '用系统选择目录'}</button>
      <p className="muted">生成文件会自动保存到所选项目的 agent-outputs 文件夹。</p>
      {pickerOff ? <p className="muted">当前启动方式未连接系统目录选择器。</p> : null}
      {workspaces.length ? <div className="workspace-manage">
        <button type="button" className="btn-reset manage-toggle" aria-expanded={manage} onClick={() => setManage(value => !value)}><Icon name={manage ? 'chevron-down' : 'chevron-right'} size={12} />管理已授权目录</button>
        {manage ? <ul className="workspace-grants">{workspaces.map(item => <li key={item.id}>
          <span><b>{item.name}</b><small className="mono">{item.path}</small></span>
          {confirming === item.id ? <span className="grant-confirm" role="group" aria-label="确认撤销授权">
            <span>撤销对“{item.name}”的访问授权？正在使用它的任务会停止。</span>
            <button type="button" className="btn danger sm" disabled={busy || sending} onClick={() => { setConfirming(null); onRevoke(item.id); }}>确认撤销</button>
            <button type="button" className="btn ghost sm" onClick={() => setConfirming(null)}>返回</button>
          </span> : <button type="button" className="btn ghost sm" disabled={busy || sending} onClick={() => setConfirming(item.id)}>撤销授权</button>}
        </li>)}</ul> : null}
      </div> : null}
    </>}
  </Popover>;
}
