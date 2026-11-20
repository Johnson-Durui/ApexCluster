// Run mode for a new chat (BUILD-SPEC-B §4.7): markup and strings unchanged (PipelineStatus.test pins them); styled as a
// one-row segmented control above the textarea by composer.css.
import type { ApiChatConfiguration } from '../../../lib/chat-api';

export function PipelineComposerControls({ configuration, mode, preset, auto, disabled, workspaceGranted, onMode, onPreset, onAuto }: {
  configuration?: ApiChatConfiguration;
  mode: 'normal' | 'pipeline';
  preset: string;
  auto: boolean;
  disabled: boolean;
  workspaceGranted: boolean;
  onMode: (mode: 'normal' | 'pipeline') => void;
  onPreset: (preset: string) => void;
  onAuto: (auto: boolean) => void;
}) {
  const presets = configuration?.presets ?? [];
  return <fieldset className="pipeline-create" disabled={disabled}>
    <legend>运行方式</legend>
    <div className="pipeline-mode" role="radiogroup" aria-label="新聊天运行方式">
      <label><input type="radio" name="chat-mode" checked={mode === 'normal'} onChange={() => onMode('normal')} />普通聊天</label>
      <label><input type="radio" name="chat-mode" checked={mode === 'pipeline'} onChange={() => onMode('pipeline')} />流水线</label>
    </div>
    {mode === 'pipeline' ? <div className="pipeline-create-options">
      <label><span>流水线预设</span><select value={preset} onChange={event => onPreset(event.target.value)}>
        <option value="">选择预设</option>
        {presets.map(item => <option key={item.id} value={item.id} disabled={!item.available}>{item.id}{item.available ? '' : `（${item.reason ?? '不可用'}）`}</option>)}
      </select></label>
      <label className="pipeline-auto"><input type="checkbox" checked={auto} onChange={event => onAuto(event.target.checked)} />自动通过用户关卡</label>
      {!workspaceGranted ? <p className="pipeline-workspace-required"><b aria-hidden="true">! </b>流水线需要先授权项目目录</p> : null}
    </div> : null}
  </fieldset>;
}
