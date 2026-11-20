// 多模态服务 (#env-media): the image provider (local Codex or a separately billed API) and its consent switches.
// "以上方运行状态为准" stays true because the Environment page renders 运行状态 above this section.
import type { ChatSettings, CodexMediaSetting, MediaSetting } from '../../../lib/chat-api';

const mediaLabels = { vision: '视觉理解', image: '图像生成' } as const;
type ApiMediaKind = keyof typeof mediaLabels;
export type MediaProvider = 'codex' | 'api';

export const newMedia = (kind: ApiMediaKind): MediaSetting => ({ enabled: true, endpoint: 'http://127.0.0.1:8000/v1', model: '请填写模型名', apiKeyEnv: kind === 'vision' ? 'VISION_API_KEY' : 'IMAGE_API_KEY', allowPaidCalls: false, timeoutMs: 30_000, maxOutputBytes: 32 * 1024 * 1024 });
export const newCodexMedia = (): CodexMediaSetting => ({ enabled: true, allowSubscriptionCalls: false, timeoutMs: 180_000 });
export const mediaProvider = (settings: ChatSettings): MediaProvider => settings.media.codex?.enabled ? 'codex' : 'api';
export function selectMediaProvider(settings: ChatSettings, provider: MediaProvider): ChatSettings {
  return { ...settings, media: { ...settings.media, codex: provider === 'codex' ? { ...(settings.media.codex ?? newCodexMedia()), enabled: true } : settings.media.codex ? { ...settings.media.codex, enabled: false } : undefined } };
}
export function updateCodexMedia(settings: ChatSettings, patch: Partial<CodexMediaSetting>): ChatSettings {
  return { ...settings, media: { ...settings.media, codex: { ...(settings.media.codex ?? newCodexMedia()), ...patch } } };
}

function ApiMediaItem({ kind, settings, onChange }: { kind: ApiMediaKind; settings: ChatSettings; onChange(next: ChatSettings): void }) {
  const item = settings.media[kind];
  const update = (patch: Partial<MediaSetting>) => onChange({ ...settings, media: { ...settings.media, [kind]: { ...(item ?? newMedia(kind)), ...patch } } });
  const summary = item?.enabled ? item.allowPaidCalls ? '已配置，待运行状态确认' : '未授权独立计费 API' : item ? '已停用' : '未配置';
  return <details className="settings-item media-setting" open={!!item}>
    <summary><b>{mediaLabels[kind]}</b><span>{summary}</span></summary>
    <div className="settings-grid">
      <label className="settings-switch"><input type="checkbox" checked={item?.enabled ?? false} onChange={event => update({ enabled: event.target.checked })} />启用</label>
      <label className="settings-field">模型<input className="mono" value={item?.model ?? ''} onChange={event => update({ model: event.target.value })} /></label>
      <label className="settings-field span-2">Endpoint<input className="mono" value={item?.endpoint ?? ''} onChange={event => update({ endpoint: event.target.value })} placeholder="https://…" /></label>
      {kind === 'image' ? <label className="settings-field span-2">编辑 Endpoint（可选）<input className="mono" value={item?.editEndpoint ?? ''} onChange={event => update({ editEndpoint: event.target.value || undefined })} /></label> : null}
      <label className="settings-field span-2">API Key 环境变量名<input className="mono" value={item?.apiKeyEnv ?? ''} onChange={event => update({ apiKeyEnv: event.target.value })} autoComplete="off" /><small>例如 IMAGE_API_KEY；这里不会接收或显示密钥值。</small></label>
      <label className="span-2 paid-call-consent"><input type="checkbox" checked={item?.allowPaidCalls ?? false} onChange={event => update({ allowPaidCalls: event.target.checked })} /><span><b>允许通过该服务调用独立计费 API</b><small>未勾选时不会暴露对应图片或视觉工具。</small></span></label>
    </div>
    {item ? <button type="button" className="ghost compact settings-remove" onClick={() => { const media = { ...settings.media }; delete media[kind]; onChange({ ...settings, media }); }}>移除配置</button> : null}
  </details>;
}

export function MediaSettingsSection({ settings, onChange }: { settings: ChatSettings; onChange: (next: ChatSettings) => void }) {
  const provider = mediaProvider(settings);
  const updateCodex = (patch: Partial<CodexMediaSetting>) => onChange(updateCodexMedia(settings, patch));
  return <section className="panel settings-card media-provider-settings" id="env-media" aria-labelledby="env-media-heading">
    <div className="settings-section-title"><div><h2 id="env-media-heading">多模态服务</h2><p>选择图片理解、生成和参考图编辑使用的服务。实际可用状态以上方运行状态为准。</p></div></div>
    <fieldset className="media-provider-choice">
      <legend>图片提供方</legend>
      <label className={provider === 'codex' ? 'is-selected' : ''}><input type="radio" name="media-provider" value="codex" checked={provider === 'codex'} onChange={() => onChange(selectMediaProvider(settings, 'codex'))} /><span><b>本机 GPT</b><small>复用已登录的 Codex 与现有订阅，不需要填写地址、模型或密钥。</small></span></label>
      <label className={provider === 'api' ? 'is-selected' : ''}><input type="radio" name="media-provider" value="api" checked={provider === 'api'} onChange={() => onChange(selectMediaProvider(settings, 'api'))} /><span><b>自定义 API</b><small>使用单独配置的视觉与图片接口，计费授权分别管理。</small></span></label>
    </fieldset>
    {provider === 'codex' ? <div className="native-media-config">
      <div><b>本机图片能力</b><p>图片由受控工具生成并作为真实文件交付。保存后仍需运行层验证本机能力，未通过时不会静默切换到 API。</p></div>
      <label className="paid-call-consent subscription-call-consent"><input type="checkbox" checked={settings.media.codex?.allowSubscriptionCalls ?? false} onChange={event => updateCodex({ enabled: true, allowSubscriptionCalls: event.target.checked })} /><span><b>允许使用现有订阅额度</b><small>未勾选时不会调用本机 GPT 图片能力。</small></span></label>
    </div> : <div className="settings-collection api-media-settings">{(['vision', 'image'] as const).map(kind => <ApiMediaItem key={kind} kind={kind} settings={settings} onChange={onChange} />)}</div>}
  </section>;
}
