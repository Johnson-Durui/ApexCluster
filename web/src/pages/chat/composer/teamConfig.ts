// Pure state, validation and display helpers for the per-task custom multi-agent team configurator.
import type {
  ChatTeamConfiguration,
  ChatTeamInput,
  ChatTeamMemberInput,
  DelegationMode,
  FrozenChatTeam,
  SelectableAgentOption,
  TeamMemberRole,
} from '../../../lib/chat-api';

export interface TeamMemberDraft {
  model: string;
  role: TeamMemberRole;
  effort?: string;
}

export interface TeamDraft {
  mode: 'default' | 'custom';
  leadModel: string;
  leadEffort: string;
  delegation: DelegationMode;
  members: TeamMemberDraft[];
  allowLeadWrite: boolean;
  /** Applied only when at least one selected collaborator has role === 'reviewer'. */
  requireAcceptanceReview: boolean;
}

export const MAX_CUSTOM_TEAM_MEMBERS = 16;

export const DEFAULT_TEAM_DRAFT: TeamDraft = {
  mode: 'default',
  leadModel: '',
  leadEffort: '',
  delegation: 'proactive',
  members: [],
  allowLeadWrite: false,
  requireAcceptanceReview: true,
};

export const DRIVER_MODE_LABELS: Record<'api' | 'cli', string> = {
  api: 'API Key',
  cli: '本地订阅 CLI',
};

export const DELEGATION_OPTIONS: ReadonlyArray<{
  value: DelegationMode;
  label: string;
  short: string;
  description: string;
}> = [
  { value: 'proactive', label: '自主调度', short: '自主调度', description: '主 Agent 可按任务需要主动派发已授权协作者并行协作。' },
  { value: 'explicit', label: '按需调度', short: '按需调度', description: '仅在你明确要求协作或点名模型时，主 Agent 才派发协作者。' },
  { value: 'none', label: '禁止调度', short: '独立执行', description: '由主 Agent 独立完成任务，不会向其他协作者派发子任务。' },
];

export const DELEGATION_LABEL: Record<DelegationMode, string> = {
  proactive: '自主调度',
  explicit: '按需调度',
  none: '禁止调度',
};

export const DELEGATION_SHORT: Record<DelegationMode, string> = {
  proactive: '自主调度',
  explicit: '按需调度',
  none: '独立执行',
};

export const MEMBER_ROLE_OPTIONS: ReadonlyArray<{ value: TeamMemberRole; label: string; summary: string }> = [
  { value: 'collaborator', label: '通用协作', summary: '分析与并行子任务' },
  { value: 'writer', label: '实现写入', summary: '工作区实现与命令执行' },
  { value: 'reviewer', label: '独立评审', summary: '冻结视图评审与独立验收' },
];

export const MEMBER_ROLE_LABEL: Record<TeamMemberRole, string> = {
  collaborator: '通用协作',
  writer: '实现写入',
  reviewer: '独立评审',
};

export function shortAgentLabel(label: string): string {
  const parts = label.split('·').map(part => part.trim()).filter(Boolean);
  const text = parts.length >= 3 ? `${parts[0]} · ${parts[1]}` : (parts[0] ?? label.trim());
  return text.length > 22 ? `${text.slice(0, 21)}…` : text;
}

const trimLabel = (label: string): string | undefined => {
  const value = label.trim().slice(0, 60);
  return value || undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isDelegation = (value: unknown): value is DelegationMode => value === 'proactive' || value === 'explicit' || value === 'none';
const isMemberRole = (value: unknown): value is TeamMemberRole => value === 'collaborator' || value === 'writer' || value === 'reviewer';

export function parseTeamDraft(raw: unknown): TeamDraft {
  if (!isRecord(raw)) return { ...DEFAULT_TEAM_DRAFT, members: [] };
  const leadModel = typeof raw.leadModel === 'string' ? raw.leadModel : '';
  const seen = new Set<string>();
  const members: TeamMemberDraft[] = [];
  if (Array.isArray(raw.members)) {
    for (const item of raw.members) {
      if (!isRecord(item) || typeof item.model !== 'string' || !item.model || item.model === leadModel || seen.has(item.model)) continue;
      seen.add(item.model);
      members.push({
        model: item.model,
        role: isMemberRole(item.role) ? item.role : 'collaborator',
        ...(typeof item.effort === 'string' && item.effort ? { effort: item.effort } : {}),
      });
      if (members.length >= MAX_CUSTOM_TEAM_MEMBERS) break;
    }
  }
  return {
    mode: raw.mode === 'custom' ? 'custom' : 'default',
    leadModel,
    leadEffort: typeof raw.leadEffort === 'string' ? raw.leadEffort : '',
    delegation: isDelegation(raw.delegation) ? raw.delegation : 'proactive',
    members,
    allowLeadWrite: raw.allowLeadWrite === true,
    requireAcceptanceReview: raw.requireAcceptanceReview !== false,
  };
}

function defaultLeadOption(config?: ChatTeamConfiguration | null): SelectableAgentOption | undefined {
  if (!config) return undefined;
  const preferredId = config.driverMode === 'cli' ? config.defaultRoster.rootSeat : config.defaultRoster.leadModel;
  const preferred = preferredId ? config.options.find(item => item.id === preferredId && item.available) : undefined;
  return preferred ?? config.options.find(item => item.available);
}

/** Switches into custom mode and seeds an initial available Lead only if no Lead has been chosen yet. */
export function enterCustomTeamMode(draft: TeamDraft, config?: ChatTeamConfiguration | null): TeamDraft {
  if (draft.leadModel) return { ...draft, mode: 'custom' };
  const initialLead = defaultLeadOption(config);
  if (!initialLead) return { ...draft, mode: 'custom' };
  return {
    ...draft,
    mode: 'custom',
    leadModel: initialLead.id,
    leadEffort: initialLead.defaultEffort,
    members: draft.members.filter(item => item.model !== initialLead.id),
  };
}

/** Ensures an empty leadModel gets seeded once capabilities arrive while in custom mode; never silently swaps an unavailable selection. */
export function seedLeadIfEmpty(draft: TeamDraft, config?: ChatTeamConfiguration | null): TeamDraft {
  if (draft.mode !== 'custom' || draft.leadModel || !config) return draft;
  return enterCustomTeamMode(draft, config);
}

export function selectLeadModel(draft: TeamDraft, modelId: string, config?: ChatTeamConfiguration | null): TeamDraft {
  const option = config?.options.find(item => item.id === modelId);
  return {
    ...draft,
    mode: 'custom',
    leadModel: modelId,
    leadEffort: option?.defaultEffort ?? '',
    members: draft.members.filter(item => item.model !== modelId),
  };
}

export function toggleTeamMember(draft: TeamDraft, modelId: string, config?: ChatTeamConfiguration | null): TeamDraft {
  if (!modelId || modelId === draft.leadModel) return draft;
  const exists = draft.members.some(item => item.model === modelId);
  if (exists) {
    return { ...draft, members: draft.members.filter(item => item.model !== modelId) };
  }
  if (draft.members.length >= MAX_CUSTOM_TEAM_MEMBERS) return draft;
  const option = config?.options.find(item => item.id === modelId);
  return {
    ...draft,
    members: [...draft.members, { model: modelId, role: 'collaborator', ...(option?.defaultEffort ? { effort: option.defaultEffort } : {}) }],
  };
}

export function updateTeamMember(draft: TeamDraft, modelId: string, patch: Partial<Pick<TeamMemberDraft, 'role' | 'effort'>>): TeamDraft {
  return {
    ...draft,
    members: draft.members.map(item => item.model === modelId ? { ...item, ...patch } : item),
  };
}

export function selectAllAvailableMembers(draft: TeamDraft, config?: ChatTeamConfiguration | null): TeamDraft {
  if (!config) return draft;
  const existing = new Map(draft.members.map(item => [item.model, item]));
  const next: TeamMemberDraft[] = [];
  for (const option of config.options) {
    if (!option.available || option.id === draft.leadModel) continue;
    next.push(existing.get(option.id) ?? { model: option.id, role: 'collaborator', ...(option.defaultEffort ? { effort: option.defaultEffort } : {}) });
    if (next.length >= MAX_CUSTOM_TEAM_MEMBERS) break;
  }
  return { ...draft, members: next };
}

export function clearTeamMembers(draft: TeamDraft): TeamDraft {
  return { ...draft, members: [] };
}

export interface TeamValidationResult {
  valid: boolean;
  error?: string;
  payload?: ChatTeamInput;
  leadOption?: SelectableAgentOption;
  hasReviewer: boolean;
}

export function validateTeamDraft(draft: TeamDraft, config?: ChatTeamConfiguration | null): TeamValidationResult {
  if (draft.mode !== 'custom') return { valid: true, hasReviewer: false };
  if (!config) return { valid: false, error: '尚未取得可选模型状态，请稍候或在「环境与连接」中重载检查。', hasReviewer: false };
  if (!config.supported) return { valid: false, error: '当前运行环境不支持自定义协作团队。', hasReviewer: false };
  const optionById = new Map(config.options.map(item => [item.id, item]));
  const leadOption = optionById.get(draft.leadModel);
  if (!leadOption) {
    const anyAvailable = config.options.some(item => item.available);
    return { valid: false, error: anyAvailable ? '请选择一个可用的主 Agent。' : '当前没有可用的模型，无法启动自定义协作团队。', hasReviewer: false };
  }
  if (!leadOption.available) {
    return { valid: false, error: `主 Agent「${leadOption.label}」当前不可用：${leadOption.reason ?? '请先在环境与连接中核对'}`, leadOption, hasReviewer: false };
  }

  const members: ChatTeamMemberInput[] = [];
  const seen = new Set<string>();
  let hasReviewer = false;
  for (const member of draft.members) {
    if (member.model === leadOption.id || seen.has(member.model)) continue;
    seen.add(member.model);
    const opt = optionById.get(member.model);
    if (!opt) {
      return { valid: false, error: `所选协作者「${member.model}」不在当前可用清单中。`, leadOption, hasReviewer };
    }
    if (!opt.available) {
      return { valid: false, error: `协作者「${opt.label}」当前不可用：${opt.reason ?? '请先在环境与连接中核对'}`, leadOption, hasReviewer };
    }
    const effort = member.effort && (!opt.efforts.length || opt.efforts.includes(member.effort)) ? member.effort : opt.defaultEffort;
    if (member.role === 'reviewer') hasReviewer = true;
    const memberLabel = trimLabel(opt.label);
    members.push({
      model: opt.id,
      ...(memberLabel ? { label: memberLabel } : {}),
      ...(effort ? { effort } : {}),
      role: member.role,
    });
  }

  const leadEffort = draft.leadEffort && (!leadOption.efforts.length || leadOption.efforts.includes(draft.leadEffort)) ? draft.leadEffort : leadOption.defaultEffort;
  const leadLabel = trimLabel(leadOption.label);
  const canRequireAcceptance = hasReviewer && draft.delegation !== 'none';
  const payload: ChatTeamInput = {
    leadModel: leadOption.id,
    ...(leadLabel ? { leadLabel } : {}),
    ...(leadEffort ? { leadEffort } : {}),
    delegation: draft.delegation,
    members,
    allowLeadWrite: draft.allowLeadWrite,
    ...(canRequireAcceptance ? { requireAcceptanceReview: draft.requireAcceptanceReview } : {}),
  };

  return { valid: true, payload, leadOption, hasReviewer };
}

export function frozenTeamSummaryText(team: FrozenChatTeam): string {
  const lead = shortAgentLabel(team.lead.label);
  const mode = DELEGATION_SHORT[team.delegation];
  const count = team.members.length;
  return count > 0 ? `主 ${lead} · ${mode} · +${count}` : `主 ${lead} · ${mode}`;
}

export function memberCapabilityWords(member: FrozenChatTeam['members'][number]): string {
  const words: string[] = [];
  if (member.canWriteMain) words.push('主目录写入');
  else if (member.canWriteIsolated) words.push('隔离写入');
  if (member.canAccept) words.push('独立验收');
  if (member.canExec) words.push('命令执行');
  return words.length ? words.join(' / ') : '只读协作';
}
