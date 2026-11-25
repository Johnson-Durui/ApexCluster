// The inspector 设置 tab (BUILD-SPEC-B §4.9): a read-only summary. Global settings are edited on 环境与连接.
// It shows the execution sandbox, per-seat availability from this chat's snapshot, and the service runtime state.
import type { ChatCapabilities, ChatRecord, DriverCapability } from '../../lib/chat-api';
import { Status, Tag } from '../../components/ui';
import ExecCapabilityNotice from './ExecCapabilityNotice';
import { DELEGATION_LABEL, DRIVER_MODE_LABELS, MEMBER_ROLE_LABEL, memberCapabilityWords } from './composer/teamConfig';
import { ServiceStatusList } from './settings/ServicesSection';
import { seatStyle } from './thread/seats';

export interface SettingsSummaryProps {
  chat?: ChatRecord | null;
  capabilities: DriverCapability[];
  globalCapabilities: ChatCapabilities | null;
  fixedDemo: boolean;
  /** Seat display names (from the observatory roles); unknown seats show their id. */
  labels?: Record<string, string>;
}

export default function SettingsSummary({ chat, capabilities, globalCapabilities, fixedDemo, labels = {} }: SettingsSummaryProps) {
  const exec = globalCapabilities?.exec;
  const team = fixedDemo ? undefined : chat?.team;
  return <section className="settings-summary" aria-label="设置摘要">
    {fixedDemo ? <p className="insp-demo-note"><Tag tone="mock">▷ 预设演示</Tag>预设演示会话：以下为本机真实全局配置</p> : null}
    {team ? <div className="insp-sec">
      <div className="insp-sec-title"><h3>本会话协作团队</h3><small>已冻结 · {DRIVER_MODE_LABELS[team.driverMode]}</small></div>
      <div className="insp-team-card">
        <div className="insp-team-lead" data-seat={team.lead.seatId} style={seatStyle(team.lead.seatId)}>
          <span className="seat-dot" aria-hidden="true" />
          <b>{team.lead.label}</b>
          <Tag>主 Agent</Tag>
          <Tag tone={team.delegation === 'none' ? undefined : 'ok'}>{DELEGATION_LABEL[team.delegation]}</Tag>
        </div>
        <small className="mono muted">{team.lead.model} · {team.lead.provider} · {team.lead.effort}</small>
        <div className="insp-team-perms">
          <span>主 Agent 写入：{team.allowLeadWrite || team.lead.canWriteMain ? '已授权' : '仅协调'}</span>
          <span>独立验收：{team.requireAcceptanceReview ? '必需' : '不强制'}</span>
        </div>
        {team.members.length ? <ul className="insp-team-members">{team.members.map(member => <li key={member.seatId} data-seat={member.seatId} style={seatStyle(member.seatId)}>
          <span className="seat-dot" aria-hidden="true" />
          <span><b>{member.label}</b> <Tag>{MEMBER_ROLE_LABEL[member.role]}</Tag><small className="mono">{member.model} · {memberCapabilityWords(member)}</small></span>
        </li>)}</ul> : <p className="muted">无协作者，主 Agent 独立执行。</p>}
      </div>
    </div> : null}
    <div className="insp-sec">
      <div className="insp-sec-title"><h3>执行沙箱</h3><small>模型命令只通过配置的执行后端运行</small></div>
      {exec?.backend ? <ExecCapabilityNotice capability={exec} />
        : <p className="muted">{exec ? `未配置执行后端 · ${exec.reason ?? '不可用'}` : '尚未取得执行沙箱状态；可在环境与连接中检查。'}</p>}
    </div>
    <div className="insp-sec">
      <div className="insp-sec-title"><h3>本聊天席位</h3><small>以运行状态为准，不会静默替换型号</small></div>
      {capabilities.length ? <ul className="insp-seat-list">{capabilities.map(seat => <li key={seat.role} data-seat={seat.role}>
        <span className="seat-dot" aria-hidden="true" />
        <span className="insp-seat-name"><b>{labels[seat.role] ?? seat.role}</b>{seat.model ? <code>{seat.model}{seat.effort ? ` · ${seat.effort}` : ''}</code> : null}</span>
        {seat.available ? <Status kind="ok">已连接</Status> : <Status kind="block">当前不可用</Status>}
        {!seat.available ? <small className="insp-seat-reason">{seat.reason ?? '能力未经验证'}</small> : null}
      </li>)}</ul> : <p className="muted">{fixedDemo ? '预设演示不调用模型，没有席位能力记录。' : '本聊天尚未返回席位能力记录。'}</p>}
    </div>
    <div className="insp-sec">
      <div className="insp-sec-title"><h3>运行状态</h3><small>只读 · 只有“已就绪”表示当前可用</small></div>
      {globalCapabilities ? <ServiceStatusList services={globalCapabilities.services ?? []} /> : <p className="muted">尚未取得运行状态；可在环境与连接中检查。</p>}
    </div>
    <a className="insp-env-link" href="#/environment">在 环境与连接 中管理 MCP、Skill、多模态与 API →</a>
  </section>;
}
