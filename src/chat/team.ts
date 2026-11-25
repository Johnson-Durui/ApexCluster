import { z } from 'zod/v4';
import { HttpError } from '../orchestrator/errors.js';
import { requireModel } from '../providers/registry.js';
import type { ModelSpec } from '../providers/types.js';
import { CLI_ROSTER, parseRoster, resolveSeat, validateCliRoster, type ApiChatBinding, type ResolvedSeat, type Roster, type SeatSpec } from './roster.js';
import type { ChatDriver, ChatRole, CliChatRole } from './types.js';

export const delegationModeSchema = z.enum(['proactive', 'explicit', 'none']);
export type DelegationMode = z.infer<typeof delegationModeSchema>;

export const teamMemberRoleSchema = z.enum(['collaborator', 'writer', 'reviewer']);
export type TeamMemberRole = z.infer<typeof teamMemberRoleSchema>;

export const chatTeamMemberInputSchema = z.object({
  model: z.string().trim().min(1).max(160),
  label: z.string().trim().min(1).max(60).optional(),
  effort: z.string().trim().min(1).max(32).optional(),
  role: teamMemberRoleSchema.default('collaborator'),
}).strict();
export type ChatTeamMemberInput = z.infer<typeof chatTeamMemberInputSchema>;

export const chatTeamInputSchema = z.object({
  leadModel: z.string().trim().min(1).max(160),
  leadLabel: z.string().trim().min(1).max(60).optional(),
  leadEffort: z.string().trim().min(1).max(32).optional(),
  delegation: delegationModeSchema.default('proactive'),
  members: z.array(z.union([z.string().trim().min(1).max(160), chatTeamMemberInputSchema])).max(16).default([]),
  allowLeadWrite: z.boolean().default(false),
  requireAcceptanceReview: z.boolean().optional(),
}).strict();
export type ChatTeamInput = z.infer<typeof chatTeamInputSchema>;

export interface SelectableAgentOption {
  id: string;
  label: string;
  provider: string;
  family: string;
  driverMode: 'api' | 'cli';
  authLabel: string;
  defaultEffort: string;
  efforts: string[];
  available: boolean;
  reason?: string;
  model?: string;
  contextWindow?: number;
}

export interface ChatTeamConfiguration {
  driverMode: 'api' | 'cli';
  supported: boolean;
  defaultRoster: {
    rootSeat: string;
    leadModel?: string;
    delegation: DelegationMode;
    seats: Array<{ id: string; model?: string; available: boolean }>;
  };
  options: SelectableAgentOption[];
}

export interface FrozenChatTeamMember {
  seatId: string;
  model: string;
  label: string;
  provider: string;
  effort: string;
  role: TeamMemberRole;
  canWriteMain: boolean;
  canWriteIsolated: boolean;
  canAccept: boolean;
  canExec: boolean;
}

export interface FrozenChatTeam {
  version: 1;
  driverMode: 'api' | 'cli';
  lead: {
    seatId: string;
    model: string;
    label: string;
    provider: string;
    effort: string;
    canWriteMain: boolean;
    canExec: boolean;
  };
  delegation: DelegationMode;
  members: FrozenChatTeamMember[];
  allowLeadWrite: boolean;
  requireAcceptanceReview: boolean;
}

const EFFORT_PREFERENCE = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'] as const;

const CLI_AGENT_META: Record<CliChatRole, {
  display: string;
  provider: string;
  family: string;
  authLabel: string;
  fallbackModel: string;
  fallbackEffort: string;
}> = {
  claude: {
    display: 'Claude Code',
    provider: 'anthropic',
    family: 'anthropic',
    authLabel: '本地订阅 CLI (Claude Code)',
    fallbackModel: 'claude-opus-5-5',
    fallbackEffort: 'max',
  },
  astra: {
    display: 'Codex · Astra',
    provider: 'openai',
    family: 'openai',
    authLabel: '本地订阅 CLI (Codex CLI)',
    fallbackModel: 'gpt-6.2-astra',
    fallbackEffort: 'max',
  },
  sol: {
    display: 'Codex · Sol',
    provider: 'openai',
    family: 'openai',
    authLabel: '本地订阅 CLI (Codex CLI)',
    fallbackModel: 'gpt-6.2-sol',
    fallbackEffort: 'max',
  },
  grok: {
    display: 'Cursor · Grok',
    provider: 'xai',
    family: 'xai',
    authLabel: '本地订阅 CLI (Cursor Agent)',
    fallbackModel: 'grok-4.7-high-fast',
    fallbackEffort: 'high',
  },
};

const CLI_ROLE_LIST: readonly CliChatRole[] = ['claude', 'astra', 'sol', 'grok'];

function isCliRole(value: string): value is CliChatRole {
  return (CLI_ROLE_LIST as readonly string[]).includes(value);
}

export function defaultEffortForModel(model: ModelSpec): string {
  for (const preferred of EFFORT_PREFERENCE) {
    if (model.efforts.includes(preferred)) return preferred;
  }
  return model.efforts[0]!;
}

/** Derive a deterministic, schema-valid seat ID from an arbitrary registered model ID. */
export function seatIdFromModel(modelId: string, used: Set<string>): string {
  let base = modelId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
  if (!base || !/^[a-z]/.test(base)) base = `m-${base || 'agent'}`;
  base = base.slice(0, 42).replace(/[-_]+$/g, '') || 'm-agent';
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let suffix = 2; ; suffix++) {
    const tag = `-${suffix}`;
    const candidate = `${base.slice(0, 48 - tag.length).replace(/[-_]+$/g, '')}${tag}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

function probeSeatFor(model: ModelSpec, effort: string): ResolvedSeat {
  return {
    id: 'probe',
    kind: 'lead',
    promptFile: 'custom-lead.md',
    strengths: model.id,
    binding: { model: model.id, effort, delegation: 'explicit' },
    can: { askUser: true, delegateSeats: [], writeMain: false, writeIsolated: false, integrate: false, acceptance: false, exec: false },
  };
}

export function buildApiTeamConfiguration(api: ApiChatBinding): ChatTeamConfiguration {
  const rootSpec = resolveSeat(api.roster, api.roster.rootSeat);
  const seats = api.roster.seats.map(item => {
    const resolved = resolveSeat(api.roster, item.id)!;
    return {
      id: item.id,
      model: resolved.binding.model,
      available: api.resolveDriver(resolved).capability.available,
    };
  });
  const options: SelectableAgentOption[] = [...api.registry.values()].map(model => {
    const defaultEffort = defaultEffortForModel(model);
    const capability = api.resolveDriver(probeSeatFor(model, defaultEffort)).capability;
    return {
      id: model.id,
      label: model.id,
      provider: model.provider,
      family: model.family,
      driverMode: 'api',
      authLabel: `API Key (${model.apiKeyEnv})`,
      defaultEffort,
      efforts: [...model.efforts],
      available: capability.available,
      ...(capability.reason ? { reason: capability.reason } : {}),
      model: model.id,
      contextWindow: model.contextWindow,
    };
  });
  return {
    driverMode: 'api',
    supported: true,
    defaultRoster: {
      rootSeat: api.roster.rootSeat,
      leadModel: rootSpec?.binding.model,
      delegation: rootSpec?.binding.delegation ?? 'explicit',
      seats,
    },
    options,
  };
}

export function buildCliTeamConfiguration(drivers: Record<ChatRole, ChatDriver>): ChatTeamConfiguration {
  const seats = CLI_ROSTER.seats.map(seat => {
    const cap = drivers[seat.id]?.capability;
    return {
      id: seat.id,
      model: cap?.model ?? seat.bindings.default.model,
      available: Boolean(cap?.available && cap?.isolationVerified),
    };
  });
  const options: SelectableAgentOption[] = CLI_ROLE_LIST.map(role => {
    const meta = CLI_AGENT_META[role];
    const cap = drivers[role]?.capability;
    const model = cap?.model ?? meta.fallbackModel;
    const effort = cap?.effort ?? meta.fallbackEffort;
    const available = Boolean(cap?.available && cap?.isolationVerified);
    const reason = available ? undefined : (cap?.reason ?? '本地 CLI 驱动未配置或隔离能力未验证');
    return {
      id: role,
      label: `${meta.display} · ${model}`,
      provider: cap?.provider ?? meta.provider,
      family: meta.family,
      driverMode: 'cli',
      authLabel: meta.authLabel,
      defaultEffort: effort,
      efforts: [effort],
      available,
      ...(reason ? { reason } : {}),
      model,
      ...(cap?.contextWindow ? { contextWindow: cap.contextWindow } : {}),
    };
  });
  return {
    driverMode: 'cli',
    supported: true,
    defaultRoster: {
      rootSeat: CLI_ROSTER.rootSeat,
      leadModel: drivers[CLI_ROSTER.rootSeat]?.capability.model ?? resolveSeat(CLI_ROSTER, CLI_ROSTER.rootSeat)?.binding.model,
      delegation: resolveSeat(CLI_ROSTER, CLI_ROSTER.rootSeat)?.binding.delegation ?? 'explicit',
      seats,
    },
    options,
  };
}

interface NormalizedMember {
  model: string;
  label?: string;
  effort?: string;
  role: TeamMemberRole;
}

function normalizeMembers(raw: ChatTeamInput['members']): NormalizedMember[] {
  return raw.map(item => typeof item === 'string'
    ? { model: item, role: 'collaborator' as const }
    : { model: item.model, ...(item.label ? { label: item.label } : {}), ...(item.effort ? { effort: item.effort } : {}), role: item.role });
}

function resolveAcceptanceRequirement(input: ChatTeamInput, members: readonly NormalizedMember[]): boolean {
  const hasReviewer = members.some(member => member.role === 'reviewer');
  if (input.requireAcceptanceReview === true) {
    if (input.delegation === 'none') throw new HttpError(400, '禁止调度模式下无法委派独立验收席位');
    if (!hasReviewer) throw new HttpError(400, '启用独立验收需要至少选择一位 reviewer 角色协作者');
    return true;
  }
  if (input.requireAcceptanceReview === false) return false;
  return input.delegation !== 'none' && hasReviewer;
}

function memberRoleSpec(role: TeamMemberRole, isMainWriter: boolean): {
  kind: SeatSpec['kind'];
  weight: number;
  promptFile: string;
  can: SeatSpec['can'];
  roleSummary: string;
} {
  if (role === 'reviewer') {
    return {
      kind: 'secondary',
      weight: 3,
      promptFile: 'custom-reviewer.md',
      can: { askUser: false, delegateSeats: [], writeMain: false, writeIsolated: false, integrate: false, acceptance: true, exec: true },
      roleSummary: '独立评审与验证（只读快照，可运行测试/校验）',
    };
  }
  if (role === 'writer') {
    return {
      kind: 'builder',
      weight: 2,
      promptFile: 'custom-writer.md',
      can: {
        askUser: false,
        delegateSeats: [],
        writeMain: isMainWriter,
        writeIsolated: !isMainWriter,
        integrate: isMainWriter,
        acceptance: false,
        exec: true,
      },
      roleSummary: isMainWriter ? '主工作区实现写者与集成执行' : '独立编辑副本实现写者与测试执行',
    };
  }
  return {
    kind: 'crossref',
    weight: 2,
    promptFile: 'custom-collaborator.md',
    can: { askUser: false, delegateSeats: [], writeMain: false, writeIsolated: false, integrate: false, acceptance: false, exec: false },
    roleSummary: '只读协作分析、方案补充与资料整理',
  };
}

function leadStrengths(label: string, model: string, delegation: DelegationMode, allowLeadWrite: boolean): string {
  const dispatchText = delegation === 'proactive' ? '已授权自主拆分并调度协作者'
    : delegation === 'explicit' ? '已授权按需调度协作者' : '禁止委派，独立完成任务';
  const writeText = allowLeadWrite ? '具备主工作区写入与执行权限' : '只读统筹，不直接写入源码';
  return `用户指定主 Agent（${label} / ${model}）：${dispatchText}；${writeText}。`;
}

/** Build and fail-closed-validate a per-chat API Roster from user team choices. */
export function synthesizeApiTeamRoster(rawInput: unknown, api: ApiChatBinding): { roster: Roster; team: FrozenChatTeam } {
  const input = chatTeamInputSchema.parse(rawInput);
  const members = normalizeMembers(input.members);
  const requireAcceptanceReview = resolveAcceptanceRequirement(input, members);

  const leadSpec = api.registry.get(input.leadModel);
  if (!leadSpec) throw new HttpError(400, `主 Agent 型号未在模型注册表中登记：${input.leadModel}`);
  const leadEffort = input.leadEffort ?? defaultEffortForModel(leadSpec);
  try { requireModel(api.registry, leadSpec.id, leadEffort); }
  catch { throw new HttpError(400, `主 Agent 型号 ${leadSpec.id} 不支持推理强度 ${leadEffort}`); }

  const resolvedMembers = members.map(member => {
    const spec = api.registry.get(member.model);
    if (!spec) throw new HttpError(400, `协作者型号未在模型注册表中登记：${member.model}`);
    const effort = member.effort ?? defaultEffortForModel(spec);
    try { requireModel(api.registry, spec.id, effort); }
    catch { throw new HttpError(400, `协作者型号 ${spec.id} 不支持推理强度 ${effort}`); }
    return { ...member, spec, effort };
  });

  const used = new Set<string>();
  const leadSeatId = seatIdFromModel(leadSpec.id, used);
  const leadLabel = input.leadLabel ?? leadSpec.id;
  let mainWriterAssigned = input.allowLeadWrite;

  const memberSeats: SeatSpec[] = [];
  const frozenMembers: FrozenChatTeamMember[] = [];
  for (const member of resolvedMembers) {
    const seatId = seatIdFromModel(member.spec.id, used);
    const isMainWriter = member.role === 'writer' && !mainWriterAssigned;
    if (isMainWriter) mainWriterAssigned = true;
    const roleCfg = memberRoleSpec(member.role, isMainWriter);
    const label = member.label ?? member.spec.id;
    memberSeats.push({
      id: seatId,
      kind: roleCfg.kind,
      delegationWeight: roleCfg.weight,
      promptFile: roleCfg.promptFile,
      strengths: `${label}（${member.spec.id}）：${roleCfg.roleSummary}`,
      bindings: { default: { model: member.spec.id, effort: member.effort, delegation: 'none' } },
      can: roleCfg.can,
    });
    frozenMembers.push({
      seatId,
      model: member.spec.id,
      label,
      provider: member.spec.provider,
      effort: member.effort,
      role: member.role,
      canWriteMain: roleCfg.can.writeMain,
      canWriteIsolated: roleCfg.can.writeIsolated,
      canAccept: roleCfg.can.acceptance,
      canExec: roleCfg.can.exec,
    });
  }

  const delegateSeats = input.delegation === 'none' ? [] : memberSeats.map(seat => seat.id);
  const leadSeat: SeatSpec = {
    id: leadSeatId,
    kind: 'lead',
    delegationWeight: 4,
    promptFile: 'custom-lead.md',
    strengths: leadStrengths(leadLabel, leadSpec.id, input.delegation, input.allowLeadWrite),
    bindings: { default: { model: leadSpec.id, effort: leadEffort, delegation: input.delegation } },
    can: {
      askUser: true,
      delegateSeats,
      writeMain: input.allowLeadWrite,
      writeIsolated: false,
      integrate: input.allowLeadWrite,
      acceptance: false,
      exec: input.allowLeadWrite,
    },
  };

  let roster: Roster;
  try {
    roster = parseRoster({
      version: 1,
      rootSeat: leadSeatId,
      seats: [leadSeat, ...memberSeats],
      pools: [],
      layers: { architecture: { pools: [] }, implementation: { pools: [] } },
    }, api.registry);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : '自定义团队名册校验失败');
  }

  const leadDriver = api.resolveDriver(resolveSeat(roster, leadSeatId)!);
  if (!leadDriver.capability.available) {
    throw new HttpError(503, `主 Agent ${leadSpec.id} 当前不可用：${leadDriver.capability.reason ?? '缺少密钥或尚未核对'}`);
  }
  for (const member of frozenMembers) {
    const driver = api.resolveDriver(resolveSeat(roster, member.seatId)!);
    if (!driver.capability.available) {
      throw new HttpError(503, `协作者 ${member.model} 当前不可用：${driver.capability.reason ?? '缺少密钥或尚未核对'}`);
    }
  }

  const team: FrozenChatTeam = {
    version: 1,
    driverMode: 'api',
    lead: {
      seatId: leadSeatId,
      model: leadSpec.id,
      label: leadLabel,
      provider: leadSpec.provider,
      effort: leadEffort,
      canWriteMain: input.allowLeadWrite,
      canExec: input.allowLeadWrite,
    },
    delegation: input.delegation,
    members: frozenMembers,
    allowLeadWrite: input.allowLeadWrite,
    requireAcceptanceReview,
  };

  return { roster, team };
}

/** Build and fail-closed-validate a per-chat CLI Roster so any local subscription CLI can act as Lead. */
export function synthesizeCliTeamRoster(rawInput: unknown, drivers: Record<ChatRole, ChatDriver>): { roster: Roster; team: FrozenChatTeam } {
  const input = chatTeamInputSchema.parse(rawInput);
  const members = normalizeMembers(input.members);
  const requireAcceptanceReview = resolveAcceptanceRequirement(input, members);

  if (!isCliRole(input.leadModel)) {
    throw new HttpError(400, `本地 CLI 模式下主 Agent 必须为 claude、astra、sol 或 grok：${input.leadModel}`);
  }
  const leadRole = input.leadModel;
  const leadMeta = CLI_AGENT_META[leadRole];
  const leadDriver = drivers[leadRole];
  const leadModelName = leadDriver?.capability.model ?? leadMeta.fallbackModel;
  const leadEffort = leadDriver?.capability.effort ?? leadMeta.fallbackEffort;
  if (input.leadEffort && input.leadEffort !== leadEffort) {
    throw new HttpError(400, `本地 CLI 模式下 ${leadRole} 推理强度固定为 ${leadEffort}，不支持覆盖为 ${input.leadEffort}`);
  }
  if (!leadDriver?.capability.available || !leadDriver.capability.isolationVerified) {
    throw new HttpError(503, `主 Agent ${leadRole} 当前不可用：${leadDriver?.capability.reason ?? '本地 CLI 驱动未验证'}`);
  }

  const seenMembers = new Set<string>();
  const resolvedMembers: Array<NormalizedMember & { cliRole: CliChatRole; modelName: string; effortName: string; provider: string }> = [];
  for (const member of members) {
    if (!isCliRole(member.model)) {
      throw new HttpError(400, `本地 CLI 模式下协作者必须为 claude、astra、sol 或 grok：${member.model}`);
    }
    if (member.model === leadRole) {
      throw new HttpError(400, `本地 CLI 模式下主 Agent ${leadRole} 不能同时作为自身协作者`);
    }
    if (seenMembers.has(member.model)) {
      throw new HttpError(400, `本地 CLI 模式下协作者 ${member.model} 不能重复选择`);
    }
    seenMembers.add(member.model);
    const meta = CLI_AGENT_META[member.model];
    const driver = drivers[member.model];
    const modelName = driver?.capability.model ?? meta.fallbackModel;
    const effortName = driver?.capability.effort ?? meta.fallbackEffort;
    if (member.effort && member.effort !== effortName) {
      throw new HttpError(400, `本地 CLI 模式下 ${member.model} 推理强度固定为 ${effortName}，不支持覆盖为 ${member.effort}`);
    }
    if (!driver?.capability.available || !driver.capability.isolationVerified) {
      throw new HttpError(503, `协作者 ${member.model} 当前不可用：${driver?.capability.reason ?? '本地 CLI 驱动未验证'}`);
    }
    resolvedMembers.push({
      ...member,
      cliRole: member.model,
      modelName,
      effortName,
      provider: driver.capability.provider ?? meta.provider,
    });
  }

  let mainWriterAssigned = input.allowLeadWrite;
  const memberSeats: SeatSpec[] = [];
  const frozenMembers: FrozenChatTeamMember[] = [];
  for (const member of resolvedMembers) {
    const isMainWriter = member.role === 'writer' && !mainWriterAssigned;
    if (isMainWriter) mainWriterAssigned = true;
    const roleCfg = memberRoleSpec(member.role, isMainWriter);
    const label = member.label ?? `${CLI_AGENT_META[member.cliRole].display} · ${member.modelName}`;
    memberSeats.push({
      id: member.cliRole,
      kind: roleCfg.kind,
      delegationWeight: roleCfg.weight,
      promptFile: roleCfg.promptFile,
      strengths: `${label}：${roleCfg.roleSummary}`,
      bindings: { default: { model: member.modelName, effort: member.effortName, delegation: 'none' } },
      can: roleCfg.can,
    });
    frozenMembers.push({
      seatId: member.cliRole,
      model: member.modelName,
      label,
      provider: member.provider,
      effort: member.effortName,
      role: member.role,
      canWriteMain: roleCfg.can.writeMain,
      canWriteIsolated: roleCfg.can.writeIsolated,
      canAccept: roleCfg.can.acceptance,
      canExec: roleCfg.can.exec,
    });
  }

  const delegateSeats = input.delegation === 'none' ? [] : memberSeats.map(seat => seat.id);
  const leadLabel = input.leadLabel ?? `${leadMeta.display} · ${leadModelName}`;
  const leadSeat: SeatSpec = {
    id: leadRole,
    kind: 'lead',
    delegationWeight: 4,
    promptFile: 'custom-lead.md',
    strengths: leadStrengths(leadLabel, leadModelName, input.delegation, input.allowLeadWrite),
    bindings: { default: { model: leadModelName, effort: leadEffort, delegation: input.delegation } },
    can: {
      askUser: true,
      delegateSeats,
      writeMain: input.allowLeadWrite,
      writeIsolated: false,
      integrate: input.allowLeadWrite,
      acceptance: false,
      exec: input.allowLeadWrite,
    },
  };

  let roster: Roster;
  try {
    roster = validateCliRoster({
      version: 1,
      rootSeat: leadRole,
      seats: [leadSeat, ...memberSeats],
      pools: [],
      layers: { architecture: { pools: [] }, implementation: { pools: [] } },
    });
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : '自定义 CLI 团队名册校验失败');
  }

  const team: FrozenChatTeam = {
    version: 1,
    driverMode: 'cli',
    lead: {
      seatId: leadRole,
      model: leadModelName,
      label: leadLabel,
      provider: leadDriver.capability.provider ?? leadMeta.provider,
      effort: leadEffort,
      canWriteMain: input.allowLeadWrite,
      canExec: input.allowLeadWrite,
    },
    delegation: input.delegation,
    members: frozenMembers,
    allowLeadWrite: input.allowLeadWrite,
    requireAcceptanceReview,
  };

  return { roster, team };
}
