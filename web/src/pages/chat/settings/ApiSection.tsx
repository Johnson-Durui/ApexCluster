// API 名册与预设 (#env-api). Read-only: shows whether environment variables exist, never their values.
import type { ApiChatConfiguration } from '../../../lib/chat-api';

const modelCheckLabels: Record<ApiChatConfiguration['modelChecks'][number]['status'], string> = {
  verified: '已核对', not_listed: '型号未列出', error: '核对失败', unchecked: '尚未核对', stale: '核对已过期', simulated: '仅模拟',
};

export function ApiConfigurationStatus({ configuration }: { configuration?: ApiChatConfiguration }) {
  if (!configuration) return <section className="panel settings-card api-roster-status" id="env-api" aria-labelledby="api-roster-heading">
    <div className="settings-section-title"><div><h2 id="api-roster-heading">API 名册与预设</h2><p>后端尚未返回 API 配置状态；不能据此认定密钥、型号或预设可用。</p></div></div>
  </section>;
  return <section className="panel settings-card api-roster-status" id="env-api" aria-labelledby="api-roster-heading">
    <div className="settings-section-title"><div><h2 id="api-roster-heading">API 名册与预设</h2><p>当前驱动：{configuration.mode === 'api' ? 'API' : 'CLI'}。这里只显示环境变量是否存在，不读取或展示密钥值。</p></div></div>
    <div className="api-readiness-grid">
      <div className="api-readiness-group"><h3>密钥就绪</h3>{configuration.keyReadiness.length ? <ul>{configuration.keyReadiness.map(item => <li key={`${item.provider}-${item.env}`} className={item.configured ? 'is-ready' : 'is-blocked'}><span className="api-status-dot" aria-hidden="true" /><div><b>{item.provider}</b><code>{item.env}</code><small>{item.configured ? '已检测到环境变量' : '未检测到；请在工作台启动环境中配置后重载状态'}</small></div></li>)}</ul> : <p className="muted">未返回任何密钥检查项。</p>}</div>
      <div className="api-readiness-group"><h3>型号核对</h3>{configuration.modelChecks.length ? <ul>{configuration.modelChecks.map(item => <li key={`${item.provider}-${item.id}`} className={item.status === 'verified' ? 'is-ready' : 'is-blocked'} data-status={item.status}><span className="api-status-dot" aria-hidden="true" /><div><b>{item.id}</b><small>{item.provider} · {modelCheckLabels[item.status]}</small></div></li>)}</ul> : <p className="muted">未返回任何型号核对记录。</p>}</div>
    </div>
    <div className="api-preset-list"><h3>流水线预设</h3>{configuration.presets.length ? configuration.presets.map(preset => <article key={preset.id} className={`api-preset ${preset.available || preset.architectureAvailable ? 'is-ready' : 'is-blocked'}`}>
      <header><div><b>{preset.id}</b><small>根席位：{preset.rootSeat}</small></div><span>{preset.available ? '可用' : preset.architectureAvailable ? '仅架构可用（至关卡 A）' : '不可用'}</span></header>
      {!preset.available ? <p className="api-preset-reason" role="status">{preset.reason || '预设中至少一个席位当前不可用；请核对对应密钥和型号状态。'}</p> : null}
      <ul>{preset.seats.map((seat, index) => <li key={`${seat.role}-${seat.model ?? 'unbound'}-${index}`} data-seat={seat.role}>
        <div><b>{seat.role}{seat.role === preset.rootSeat ? <em>根</em> : null}</b><span>{seat.model ?? '未绑定型号'}{seat.effort ? ` · ${seat.effort}` : ''}</span></div>
        <small>{seat.contextHard ? `换窗上限 ${seat.contextHard.toLocaleString()} tokens` : '未返回换窗上限'} · {seat.available ? '席位可用' : seat.reason || '席位不可用'}</small>
      </li>)}</ul>
    </article>) : <p className="muted">未配置流水线预设。</p>}</div>
  </section>;
}
