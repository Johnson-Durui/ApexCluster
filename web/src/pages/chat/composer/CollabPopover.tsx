// 协作 popover (BUILD-SPEC-B §4.7): per-task multi-agent team & Lead Agent ('主agent') configurator for a fresh chat,
// and read-only frozen team / seat availability summary for an already-started chat.
import type { Dispatch, SetStateAction } from 'react';
import Popover from '../../../components/Popover';
import { seatHandlers } from '../../../components/seatFocus';
import { Icon, Status, Tag } from '../../../components/ui';
import type {
  ChatRecord,
  ChatTeamConfiguration,
  DriverCapability,
  FrozenChatTeam,
  SelectableAgentOption,
  TeamMemberRole,
} from '../../../lib/chat-api';
import type { Observatory } from '../observatoryModel';
import { seatLabel, seatStyle } from '../thread/seats';
import {
  clearTeamMembers,
  DELEGATION_LABEL,
  DELEGATION_OPTIONS,
  DRIVER_MODE_LABELS,
  enterCustomTeamMode,
  frozenTeamSummaryText,
  MAX_CUSTOM_TEAM_MEMBERS,
  MEMBER_ROLE_LABEL,
  MEMBER_ROLE_OPTIONS,
  memberCapabilityWords,
  selectAllAvailableMembers,
  selectLeadModel,
  shortAgentLabel,
  toggleTeamMember,
  updateTeamMember,
  type TeamDraft,
  type TeamValidationResult,
} from './teamConfig';

export interface CollabPopoverProps {
  capabilities: DriverCapability[];
  model: Observatory;
  demo: boolean;
  chat?: ChatRecord | null;
  runMode?: 'normal' | 'pipeline';
  preset?: string;
  teamConfiguration?: ChatTeamConfiguration | null;
  teamDraft?: TeamDraft;
  onTeamDraft?: Dispatch<SetStateAction<TeamDraft>>;
  teamValidation?: TeamValidationResult;
  disabled?: boolean;
}

function runtimeLabel(mode: 'api' | 'cli' | undefined): string | null {
  return mode ? DRIVER_MODE_LABELS[mode] : null;
}

function FrozenTeamView({ team, capabilities }: { team: FrozenChatTeam; capabilities: DriverCapability[] }) {
  const capByRole = new Map(capabilities.map(item => [item.role, item]));
  const leadCap = capByRole.get(team.lead.seatId);
  return <div className="collab-frozen">
    <div className="collab-head">
      <h2>本会话协作团队</h2>
      <div className="collab-tags">
        <Tag>{DRIVER_MODE_LABELS[team.driverMode]}</Tag>
        <Tag>已冻结</Tag>
      </div>
    </div>
    <p>会话创建时已锁定主 Agent、调度权限与协作者清单，本会话内只读不可变更。</p>

    <section className="collab-card" aria-label="主 Agent">
      <div className="collab-card-head" style={seatStyle(team.lead.seatId)} {...seatHover(team.lead.seatId)}>
        <span className="seat-dot" aria-hidden="true" />
        <b>{team.lead.label}</b>
        <Tag>主 Agent</Tag>
        <Tag tone={team.delegation === 'none' ? undefined : 'ok'}>{DELEGATION_LABEL[team.delegation]}</Tag>
      </div>
      <div className="collab-meta mono">{team.lead.model} · {team.lead.provider}{team.lead.effort ? ` · ${team.lead.effort}` : ''}</div>
      <div className="collab-perm-row">
        <span>主 Agent 写入与执行：<b>{team.allowLeadWrite || team.lead.canWriteMain ? '已授权' : '仅协调'}</b></span>
        <span>独立验收：<b>{team.requireAcceptanceReview ? '必需' : '不强制'}</b></span>
      </div>
      {leadCap && !leadCap.available ? <p className="collab-warn">{leadCap.reason ?? '主 Agent 当前不可用'}</p> : null}
    </section>

    <section className="collab-section" aria-label="已授权协作者">
      <div className="collab-section-head">
        <h3>可调度协作者</h3>
        <span className="mono muted">{team.members.length} 席</span>
      </div>
      {team.members.length ? <ul className="collab-frozen-members">{team.members.map(member => {
        const cap = capByRole.get(member.seatId);
        return <li key={member.seatId} className="collab-frozen-member" style={seatStyle(member.seatId)} {...seatHover(member.seatId)}>
          <div className="collab-member-top">
            <span className="seat-dot" aria-hidden="true" />
            <b>{member.label}</b>
            <Tag>{MEMBER_ROLE_LABEL[member.role]}</Tag>
          </div>
          <div className="collab-meta mono">{member.model} · {member.effort} · {memberCapabilityWords(member)}</div>
          {cap && !cap.available ? <small className="bad-text">{cap.reason ?? '当前不可用'}</small> : null}
        </li>;
      })}</ul> : <p className="muted">未配置协作者，由主 Agent 独立完成任务。</p>}
    </section>
  </div>;
}

function seatHover(role: string) {
  const { onClick: _pin, ...hover } = seatHandlers(role);
  return hover;
}

function DefaultSeatsList({ capabilities, model }: { capabilities: DriverCapability[]; model: Observatory }) {
  const name = (role: string) => model.roles.find(item => item.id === role)?.label ?? seatLabel(role);
  if (!capabilities.length) return <p>暂未取得模型状态，可在环境与连接中检查。</p>;
  return <ul className="collab-rows">{capabilities.map(item => <li key={item.role} className="collab-row" style={seatStyle(item.role)} {...seatHover(item.role)}>
    <span className="seat-dot" aria-hidden="true" />
    <span className="collab-row-name"><b>{name(item.role)}</b>{item.model ? <small className="mono">{item.model}</small> : null}</span>
    <span className={item.available ? 'ok-text' : 'muted'}>{item.available ? '已连接' : item.reason ?? '当前不可用'}</span>
  </li>)}</ul>;
}

function formatContext(tokens?: number): string | null {
  if (!tokens) return null;
  return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M 上下文` : `${Math.round(tokens / 1000)}K 上下文`;
}

function sortOptionsAvailableFirst(options: SelectableAgentOption[]): SelectableAgentOption[] {
  return [...options].sort((a, b) => Number(b.available) - Number(a.available));
}

function CustomTeamEditor({
  teamConfiguration,
  teamDraft,
  onTeamDraft,
  teamValidation,
  disabled,
}: {
  teamConfiguration: ChatTeamConfiguration | null | undefined;
  teamDraft: TeamDraft;
  onTeamDraft: Dispatch<SetStateAction<TeamDraft>>;
  teamValidation?: TeamValidationResult;
  disabled: boolean;
}) {
  if (!teamConfiguration) {
    return <p className="muted">暂未取得可选模型清单，请在「环境与连接」中检查密钥或本地 CLI 登录状态。</p>;
  }
  const options = teamConfiguration.options;
  const availableOptions = options.filter(item => item.available);
  const optionById = new Map(options.map(item => [item.id, item]));
  const selectedLead = optionById.get(teamDraft.leadModel);
  const selectedMemberMap = new Map(teamDraft.members.map(item => [item.model, item]));
  const staleMembers = teamDraft.members.filter(item => item.model !== teamDraft.leadModel && !optionById.has(item.model));
  const collaboratorChoices = sortOptionsAvailableFirst(options.filter(item => item.id !== teamDraft.leadModel));
  const availableCollaborators = collaboratorChoices.filter(item => item.available);
  const hasReviewer = teamDraft.members.some(item => item.role === 'reviewer');
  const canRequireAcceptance = hasReviewer && teamDraft.delegation !== 'none';
  const delegationMeta = DELEGATION_OPTIONS.find(item => item.value === teamDraft.delegation) ?? DELEGATION_OPTIONS[0];
  const leadContext = formatContext(selectedLead?.contextWindow);

  if (!availableOptions.length) {
    return <div className="collab-custom-empty">
      <p className="collab-error" role="alert">当前没有任何可用模型。请先在「环境与连接」中配置 API Key 或完成本地订阅 CLI 登录；系统不会静默降级。</p>
      {options.length ? <ul className="collab-unavail-list">{options.map(opt => <li key={opt.id}>
        <b>{opt.label}</b><small className="muted">{opt.authLabel} · {opt.reason ?? '当前不可用'}</small>
      </li>)}</ul> : null}
    </div>;
  }

  return <div className="collab-custom">
    <section className="collab-section" aria-label="主 Agent 配置">
      <div className="collab-section-head">
        <h3>主 Agent（主控与调度者）</h3>
        {selectedLead ? <span className="mono muted">{selectedLead.provider}</span> : null}
      </div>
      <div className="collab-lead-grid">
        <label className="collab-field">
          <span className="sr-only">选择主 Agent</span>
          <select aria-label="选择主 Agent" value={teamDraft.leadModel} disabled={disabled}
            onChange={event => onTeamDraft(current => selectLeadModel(current, event.target.value, teamConfiguration))}>
            {!selectedLead && teamDraft.leadModel ? <option value={teamDraft.leadModel} disabled>{teamDraft.leadModel}（不在当前可用清单）</option> : null}
            {!selectedLead ? <option value="">选择可用的主 Agent</option> : null}
            {sortOptionsAvailableFirst(options).map(opt => <option key={opt.id} value={opt.id} disabled={!opt.available}>
              {opt.label}{opt.available ? `（${opt.provider}）` : `（不可用：${opt.reason ?? '未就绪'}）`}
            </option>)}
          </select>
        </label>
        {selectedLead && selectedLead.efforts.length > 1 ? <label className="collab-effort">
          <span className="sr-only">主 Agent 推理档位</span>
          <select aria-label="主 Agent 推理档位" value={teamDraft.leadEffort || selectedLead.defaultEffort} disabled={disabled}
            onChange={event => onTeamDraft(current => ({ ...current, leadEffort: event.target.value }))}>
            {selectedLead.efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
          </select>
        </label> : null}
      </div>
      {selectedLead ? <div className="collab-lead-meta">
        <span>{selectedLead.authLabel}</span>
        {selectedLead.model && selectedLead.model !== selectedLead.label ? <code className="mono">{selectedLead.model}</code> : null}
        {leadContext ? <span className="mono">{leadContext}</span> : null}
      </div> : null}
    </section>

    <section className="collab-section" aria-label="主 Agent 调度权限">
      <div className="collab-section-head">
        <h3>主 Agent 调度权限</h3>
        <span className="muted">{delegationMeta.short}</span>
      </div>
      <div className="collab-seg" role="radiogroup" aria-label="主 Agent 调度权限">
        {DELEGATION_OPTIONS.map(option => <label key={option.value}>
          <input type="radio" name="team-delegation" value={option.value} checked={teamDraft.delegation === option.value} disabled={disabled}
            onChange={() => onTeamDraft(current => ({ ...current, delegation: option.value }))} />
          {option.label}
        </label>)}
      </div>
      <p className="collab-hint">{delegationMeta.description}</p>
      <div className="collab-toggles">
        <label className="collab-check">
          <input type="checkbox" checked={teamDraft.allowLeadWrite} disabled={disabled}
            onChange={event => onTeamDraft(current => ({ ...current, allowLeadWrite: event.target.checked }))} />
          <span><b>允许主 Agent 直接写入与执行</b><small>单模型独立作业或未指定实现写入协作者时建议开启</small></span>
        </label>
        <label className={`collab-check${canRequireAcceptance ? '' : ' is-disabled'}`}>
          <input type="checkbox" checked={canRequireAcceptance && teamDraft.requireAcceptanceReview} disabled={disabled || !canRequireAcceptance}
            onChange={event => onTeamDraft(current => ({ ...current, requireAcceptanceReview: event.target.checked }))} />
          <span><b>完成前要求独立评审验收</b><small>{canRequireAcceptance ? '将在交付前要求「独立评审」角色核对并验收'
            : teamDraft.delegation === 'none' ? '禁止调度模式下无法委派独立验收席位'
            : '为至少 1 位协作者指定「独立评审」角色后可启用'}</small></span>
        </label>
      </div>
    </section>

    <section className="collab-section" aria-label="可调度协作者">
      <div className="collab-section-head">
        <h3>可调度协作者</h3>
        <div className="collab-bulk">
          <span className="mono muted">已选 {teamDraft.members.length}/{availableCollaborators.length}</span>
          {availableCollaborators.length > 0 ? <button type="button" className="btn-reset collab-link" disabled={disabled || teamDraft.members.length >= Math.min(availableCollaborators.length, MAX_CUSTOM_TEAM_MEMBERS)}
            onClick={() => onTeamDraft(current => selectAllAvailableMembers(current, teamConfiguration))}>全选可用</button> : null}
          {teamDraft.members.length > 0 ? <button type="button" className="btn-reset collab-link" disabled={disabled}
            onClick={() => onTeamDraft(current => clearTeamMembers(current))}>清空</button> : null}
        </div>
      </div>
      {teamDraft.delegation === 'none' && teamDraft.members.length > 0 ? <p className="collab-warn">当前为「禁止调度」，主 Agent 不会向已选协作者派发子任务。</p> : null}
      {collaboratorChoices.length === 0 && staleMembers.length === 0 ? <p className="muted">当前仅检测到主 Agent 自身，可单模型直接执行任务。</p> : <ul className="collab-members">
        {staleMembers.map(stale => <li key={`stale:${stale.model}`} className="collab-member-item is-selected is-stale">
          <div className="collab-stale-row">
            <label className="collab-member-check">
              <input type="checkbox" checked disabled={disabled}
                onChange={() => onTeamDraft(current => toggleTeamMember(current, stale.model, teamConfiguration))} />
              <span className="collab-member-info">
                <b>{stale.model}</b>
                <small>不在当前可用清单中（可能来自其他运行模式），请移除后继续。</small>
              </span>
              <Status kind="err" className="collab-avail">已失效</Status>
            </label>
            <button type="button" className="btn-reset collab-link" disabled={disabled} aria-label={`移除失效协作者 ${stale.model}`}
              onClick={() => onTeamDraft(current => toggleTeamMember(current, stale.model, teamConfiguration))}>移除</button>
          </div>
        </li>)}
        {collaboratorChoices.map(opt => {
          const picked = selectedMemberMap.get(opt.id);
          const checked = Boolean(picked);
          const atLimit = !checked && teamDraft.members.length >= MAX_CUSTOM_TEAM_MEMBERS;
          const rowDisabled = disabled || (!opt.available && !checked) || atLimit;
          return <li key={opt.id} className={`collab-member-item${checked ? ' is-selected' : ''}${!opt.available ? ' is-unavailable' : ''}`}>
            <label className="collab-member-check">
              <input type="checkbox" checked={checked} disabled={rowDisabled}
                onChange={() => onTeamDraft(current => toggleTeamMember(current, opt.id, teamConfiguration))} />
              <span className="collab-member-info">
                <b>{opt.label}</b>
                <small>{opt.available ? `${opt.provider} · ${opt.authLabel}` : `${opt.provider} · ${opt.reason ?? '当前不可用'}`}</small>
              </span>
              {opt.available ? <Status kind="ok" className="collab-avail">可用</Status> : <Status kind="block" className="collab-avail">不可用</Status>}
            </label>
            {checked && picked ? <div className="collab-member-controls">
              <label>
                <span>职责</span>
                <select aria-label={`${opt.label} 职责`} value={picked.role} disabled={disabled}
                  onChange={event => onTeamDraft(current => updateTeamMember(current, opt.id, { role: event.target.value as TeamMemberRole }))}>
                  {MEMBER_ROLE_OPTIONS.map(role => <option key={role.value} value={role.value}>{role.label}</option>)}
                </select>
              </label>
              {opt.efforts.length > 1 ? <label>
                <span>档位</span>
                <select aria-label={`${opt.label} 推理档位`} value={picked.effort || opt.defaultEffort} disabled={disabled}
                  onChange={event => onTeamDraft(current => updateTeamMember(current, opt.id, { effort: event.target.value }))}>
                  {opt.efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
                </select>
              </label> : null}
            </div> : null}
          </li>;
        })}
      </ul>}
    </section>

    {teamValidation && !teamValidation.valid && teamValidation.error ? <p className="collab-error" role="alert">{teamValidation.error}</p> : null}
  </div>;
}

/** Exported separately for direct SSR unit testing alongside the Popover trigger. */
export function CollabPanel({
  capabilities,
  model,
  demo,
  chat = null,
  runMode = 'normal',
  teamConfiguration,
  teamDraft,
  onTeamDraft,
  teamValidation,
  disabled = false,
}: CollabPopoverProps) {
  if (demo) {
    return <>
      <h2>协作 Agent</h2>
      <p>本会话播放固定的角色脚本，不发起真实模型调用，不生成调用次数或上下文用量。</p>
    </>;
  }

  // Already-started chat: read-only frozen custom team or default seat snapshot.
  if (chat) {
    if (chat.team) return <FrozenTeamView team={chat.team} capabilities={capabilities} />;
    const modeTag = runtimeLabel(teamConfiguration?.driverMode);
    return <>
      <div className="collab-head">
        <h2>协作 Agent</h2>
        {modeTag ? <Tag>{modeTag}</Tag> : null}
      </div>
      <p>本会话使用默认协作编排，席位配置已随会话锁定。</p>
      <DefaultSeatsList capabilities={capabilities} model={model} />
    </>;
  }

  // Fresh chat: interactive Default Roster vs Custom Team configurator.
  const driverModeTag = runtimeLabel(teamConfiguration?.driverMode);
  const options = teamConfiguration?.options ?? [];
  const availableCount = options.length ? options.filter(item => item.available).length : capabilities.filter(item => item.available).length;
  const totalCount = options.length || capabilities.length;
  const customSupported = Boolean(onTeamDraft && teamDraft) && (teamConfiguration ? teamConfiguration.supported : true);
  const inCustomMode = customSupported && runMode === 'normal' && teamDraft?.mode === 'custom';

  return <>
    <div className="collab-head">
      <h2>任务协作团队</h2>
      <div className="collab-tags">
        {driverModeTag ? <Tag>{driverModeTag}</Tag> : null}
        {totalCount > 0 ? <span className="mono muted">{availableCount}/{totalCount} 可用</span> : null}
      </div>
    </div>

    {runMode === 'pipeline' ? <>
      <p className="collab-warn">当前为「流水线」运行方式，使用所选流水线预设编排；切换回「普通聊天」可自由指定主 Agent 与协作者。</p>
      <DefaultSeatsList capabilities={capabilities} model={model} />
    </> : <>
      {onTeamDraft && teamDraft ? <div className="collab-seg collab-mode-switch" role="radiogroup" aria-label="团队配置模式">
        <label>
          <input type="radio" name="collab-team-mode" value="default" checked={teamDraft.mode === 'default'} disabled={disabled}
            onChange={() => onTeamDraft(current => ({ ...current, mode: 'default' }))} />
          默认编排
        </label>
        <label>
          <input type="radio" name="collab-team-mode" value="custom" checked={teamDraft.mode === 'custom'} disabled={disabled || !customSupported}
            onChange={() => onTeamDraft(current => enterCustomTeamMode(current, teamConfiguration))} />
          自定义协作团队
        </label>
      </div> : null}

      {inCustomMode && teamDraft && onTeamDraft ? <CustomTeamEditor
        teamConfiguration={teamConfiguration}
        teamDraft={teamDraft}
        onTeamDraft={onTeamDraft}
        teamValidation={teamValidation}
        disabled={disabled}
      /> : <>
        <p>根据任务需要分工，使用当前默认名册。模型不齐全或想指定主 Agent 时，可切换到「自定义协作团队」。</p>
        {teamConfiguration?.defaultRoster ? <div className="collab-default-summary">
          <span>默认主 Agent：<b>{seatLabel(teamConfiguration.defaultRoster.rootSeat)}</b>{teamConfiguration.defaultRoster.leadModel ? <code className="mono"> · {teamConfiguration.defaultRoster.leadModel}</code> : null}</span>
          <span className="muted">{DELEGATION_LABEL[teamConfiguration.defaultRoster.delegation]}</span>
        </div> : null}
        <DefaultSeatsList capabilities={capabilities} model={model} />
        {onTeamDraft && teamDraft && customSupported ? <div className="collab-default-foot">
          <button type="button" className="btn sm" disabled={disabled}
            onClick={() => onTeamDraft(current => enterCustomTeamMode(current, teamConfiguration))}>自定义主 Agent 与协作者 →</button>
        </div> : null}
      </>}
    </>}
  </>;
}

export function CollabPopover(props: CollabPopoverProps) {
  const { capabilities, demo, chat = null, runMode = 'normal', preset, teamConfiguration, teamDraft, teamValidation } = props;
  const available = capabilities.filter(item => item.available).length;

  let button;
  let buttonTitle: string | undefined;

  if (demo) {
    button = <><b>预设协作</b><Icon name="chevron-down" size={12} /></>;
  } else if (chat?.team) {
    const summary = frozenTeamSummaryText(chat.team);
    button = <>
      <span className="seat-dot" data-seat={chat.team.lead.seatId} style={seatStyle(chat.team.lead.seatId)} aria-hidden="true" />
      <b>自定义团队</b>
      <span className="mono"> · {summary}</span>
      <Icon name="chevron-down" size={12} />
    </>;
    buttonTitle = `主 Agent：${chat.team.lead.label} · ${DELEGATION_LABEL[chat.team.delegation]} · ${chat.team.members.length} 位协作者 · ${DRIVER_MODE_LABELS[chat.team.driverMode]}`;
  } else if (!chat && runMode === 'pipeline') {
    button = <><b>流水线编排</b><span className="mono"> · {preset || '未选预设'}</span><Icon name="chevron-down" size={12} /></>;
  } else if (!chat && teamDraft?.mode === 'custom') {
    const leadOpt = teamConfiguration?.options.find(item => item.id === teamDraft.leadModel);
    const invalid = teamValidation ? !teamValidation.valid : !leadOpt?.available;
    const leadName = leadOpt ? shortAgentLabel(leadOpt.label) : teamDraft.leadModel || '未选主 Agent';
    const memberCount = teamDraft.members.length;
    button = <>
      <b>自定义团队</b>
      <span className={`mono${invalid ? ' bad-text' : ''}`}>
        {invalid ? ' · 待配置' : ` · 主 ${leadName}${memberCount > 0 ? ` +${memberCount}` : ''}`}
      </span>
      <Icon name="chevron-down" size={12} />
    </>;
    buttonTitle = invalid ? teamValidation?.error : `主 Agent：${leadOpt?.label ?? leadName} · ${DELEGATION_LABEL[teamDraft.delegation]} · ${memberCount} 位协作者`;
  } else {
    button = <><b>自动协作</b><span className="mono"> · {available} 席位</span><Icon name="chevron-down" size={12} /></>;
  }

  const isWide = Boolean(!demo && (chat?.team || (!chat && runMode === 'normal' && teamDraft?.mode === 'custom')));

  return <Popover label="协作 Agent" placement="up" align="end" buttonClassName="c-pill collab-pill" buttonTitle={buttonTitle}
    button={button}
    panelClassName={`collab-pop${isWide ? ' is-wide' : ''}`}>
    <CollabPanel {...props} />
  </Popover>;
}
