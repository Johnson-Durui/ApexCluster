// The sticky settings save bar and the stale-draft prompt (BUILD-SPEC-B §6.4).
import { dirtyLabel } from './settingsDraft';

export function SettingsSaveBar({ dirty, saving, error, notice, onDiscard, onSave }: {
  dirty: number;
  saving: boolean;
  error: string;
  notice: string;
  onDiscard(): void;
  onSave(): void;
}) {
  return <div className="settings-save" role="group" aria-label="设置保存" data-dirty={dirty > 0 || undefined}>
    <div className="settings-save-state"><b>{dirtyLabel(dirty)}</b><small>有执行中或等待中的任务时，运行层会拒绝保存。</small></div>
    <div className="settings-save-feedback">
      {error ? <p className="chat-error settings-save-error" role="alert">{error}</p> : null}
      <p className="settings-notice" role="status">{notice}</p>
    </div>
    <div className="settings-save-actions">
      <button type="button" className="ghost compact" disabled={!dirty || saving} onClick={onDiscard}>放弃更改</button>
      <button type="button" className="button primary" disabled={saving} onClick={onSave}>{saving ? '保存并重载中…' : '保存设置'}</button>
    </div>
  </div>;
}

export function StaleDraftPrompt({ onRestore, onDiscard }: { onRestore(): void; onDiscard(): void }) {
  return <div className="settings-draft-prompt" role="status">
    <div>
      <b>草稿基于较早读取的配置</b>
      <p>本机留有一份尚未保存的修改，但服务端配置在那之后已经变化。恢复草稿会用草稿内容覆盖表单，仍需保存才会生效；直接编辑表单则视为放弃这份草稿。</p>
    </div>
    <div className="settings-draft-actions">
      <button type="button" className="button compact" onClick={onRestore}>恢复草稿</button>
      <button type="button" className="ghost compact" onClick={onDiscard}>放弃草稿</button>
    </div>
  </div>;
}
