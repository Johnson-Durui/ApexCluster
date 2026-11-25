import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ChatRecord, ChatTeamConfiguration, FrozenChatTeam } from '../../../lib/chat-api';
import { buildObservatory } from '../observatoryModel';
import SettingsSummary from '../SettingsSummary';
import { CollabPanel, CollabPopover } from './CollabPopover';
import {
  clearTeamMembers,
  DEFAULT_TEAM_DRAFT,
  enterCustomTeamMode,
  parseTeamDraft,
  selectAllAvailableMembers,
  selectLeadModel,
  toggleTeamMember,
  updateTeamMember,
  validateTeamDraft,
  type TeamDraft,
} from './teamConfig';

const apiConfig: ChatTeamConfiguration = {
  driverMode: 'api',
  supported: true,
  defaultRoster: {
    rootSeat: 'claude',
    leadModel: 'claude-fable-5-2',
    delegation: 'proactive',
    seats: [
      { id: 'claude', model: 'claude-fable-5-2', available: false },
      { id: 'astra', model: 'gpt-6.2-astra', available: true },
    ],
  },
  options: [
    {
      id: 'claude-fable-5-2', label: 'claude-fable-5-2', provider: 'anthropic', family: 'anthropic', driverMode: 'api',
      authLabel: 'API Key (ANTHROPIC_API_KEY)', defaultEffort: 'max', efforts: ['high', 'max'], available: false, reason: '缺少 ANTHROPIC_API_KEY',
    },
    {
      id: 'gpt-6.2-astra', label: 'gpt-6.2-astra', provider: 'openai', family: 'openai', driverMode: 'api',
      authLabel: 'API Key (OPENAI_API_KEY)', defaultEffort: 'high', efforts: ['medium', 'high', 'max'], available: true, contextWindow: 1_050_000,
    },
    {
      id: 'deepseek-v4-pro', label: 'deepseek-v4-pro', provider: 'deepseek', family: 'deepseek', driverMode: 'api',
      authLabel: 'API Key (DEEPSEEK_API_KEY)', defaultEffort: 'high', efforts: ['medium', 'high'], available: true, contextWindow: 128_000,
    },
  ],
};

const cliConfig: ChatTeamConfiguration = {
  driverMode: 'cli',
  supported: true,
  defaultRoster: {
    rootSeat: 'claude',
    delegation: 'proactive',
    seats: [
      { id: 'claude', model: 'claude-opus-5-5', available: false },
      { id: 'astra', model: 'gpt-6.2-astra', available: true },
      { id: 'sol', model: 'gpt-6.2-sol', available: true },
      { id: 'grok', model: 'grok-4.7-high-fast', available: false },
    ],
  },
  options: [
    {
      id: 'claude', label: 'Claude Code · claude-opus-5-5', provider: 'anthropic', family: 'anthropic', driverMode: 'cli',
      authLabel: '本地订阅 CLI (Claude Code)', defaultEffort: 'max', efforts: ['high', 'max'], available: false, reason: '未登录 Claude Code', model: 'claude-opus-5-5',
    },
    {
      id: 'astra', label: 'Codex CLI · gpt-6.2-astra', provider: 'openai', family: 'openai', driverMode: 'cli',
      authLabel: '本地订阅 CLI (Codex CLI)', defaultEffort: 'max', efforts: ['high', 'max'], available: true, model: 'gpt-6.2-astra',
    },
    {
      id: 'sol', label: 'Codex CLI · gpt-6.2-sol', provider: 'openai', family: 'openai', driverMode: 'cli',
      authLabel: '本地订阅 CLI (Codex CLI)', defaultEffort: 'max', efforts: ['high', 'max'], available: true, model: 'gpt-6.2-sol',
    },
  ],
};

const frozenTeam: FrozenChatTeam = {
  version: 1,
  driverMode: 'cli',
  lead: {
    seatId: 'astra',
    model: 'gpt-6.2-astra',
    label: 'Codex CLI · gpt-6.2-astra',
    provider: 'openai',
    effort: 'max',
    canWriteMain: true,
    canExec: true,
  },
  delegation: 'explicit',
  members: [
    {
      seatId: 'sol',
      model: 'gpt-6.2-sol',
      label: 'Codex CLI · gpt-6.2-sol',
      provider: 'openai',
      effort: 'high',
      role: 'writer',
      canWriteMain: true,
      canWriteIsolated: false,
      canAccept: false,
      canExec: true,
    },
  ],
  allowLeadWrite: true,
  requireAcceptanceReview: false,
};

const startedChat = (team?: FrozenChatTeam): ChatRecord => ({
  version: 1, id: 'c1', title: '自定义团队测试', createdAt: '', updatedAt: '', seq: 1, messageSeq: 0,
  turns: [], tasks: [], invocations: [], tickets: [], artifacts: [], checkpoints: [], constraintMessageIds: [],
  ...(team ? { team } : {}),
});

describe('custom team draft state & validation', () => {
  it('seeds the first available model when default lead is unavailable and never silently downgrades an unavailable selection', () => {
    const custom = enterCustomTeamMode(DEFAULT_TEAM_DRAFT, apiConfig);
    expect(custom.mode).toBe('custom');
    expect(custom.leadModel).toBe('gpt-6.2-astra');
    expect(custom.leadEffort).toBe('high');

    const soloValid = validateTeamDraft(custom, apiConfig);
    expect(soloValid.valid).toBe(true);
    expect(soloValid.payload).toEqual({
      leadModel: 'gpt-6.2-astra',
      leadLabel: 'gpt-6.2-astra',
      leadEffort: 'high',
      delegation: 'proactive',
      members: [],
      allowLeadWrite: false,
    });

    // Explicitly pointing at an unavailable model fails closed with its exact reason.
    const unavailableDraft: TeamDraft = { ...custom, leadModel: 'claude-fable-5-2' };
    const failed = validateTeamDraft(unavailableDraft, apiConfig);
    expect(failed.valid).toBe(false);
    expect(failed.error).toContain('缺少 ANTHROPIC_API_KEY');
  });

  it('prevents selecting the Lead as its own collaborator and switches lead cleanly', () => {
    let draft = enterCustomTeamMode(DEFAULT_TEAM_DRAFT, apiConfig);
    draft = toggleTeamMember(draft, 'deepseek-v4-pro', apiConfig);
    draft = toggleTeamMember(draft, 'gpt-6.2-astra', apiConfig); // ignored: same as lead
    expect(draft.members.map(item => item.model)).toEqual(['deepseek-v4-pro']);

    // Promoting deepseek-v4-pro to Lead automatically removes it from members.
    draft = selectLeadModel(draft, 'deepseek-v4-pro', apiConfig);
    expect(draft.leadModel).toBe('deepseek-v4-pro');
    expect(draft.members).toEqual([]);

    draft = selectAllAvailableMembers(draft, apiConfig);
    expect(draft.members.map(item => item.model)).toEqual(['gpt-6.2-astra']);
    draft = clearTeamMembers(draft);
    expect(draft.members).toEqual([]);
  });

  it('only sends requireAcceptanceReview when at least one reviewer member exists', () => {
    let draft = enterCustomTeamMode(DEFAULT_TEAM_DRAFT, cliConfig);
    draft = toggleTeamMember(draft, 'sol', cliConfig);
    const withoutReviewer = validateTeamDraft({ ...draft, allowLeadWrite: true, requireAcceptanceReview: true }, cliConfig);
    expect(withoutReviewer.valid).toBe(true);
    expect(withoutReviewer.hasReviewer).toBe(false);
    expect(withoutReviewer.payload?.requireAcceptanceReview).toBeUndefined();

    const withReviewerDraft = updateTeamMember(draft, 'sol', { role: 'reviewer' });
    const withReviewer = validateTeamDraft({ ...withReviewerDraft, requireAcceptanceReview: true }, cliConfig);
    expect(withReviewer.valid).toBe(true);
    expect(withReviewer.hasReviewer).toBe(true);
    expect(withReviewer.payload?.requireAcceptanceReview).toBe(true);
    expect(withReviewer.payload?.members).toEqual([{ model: 'sol', label: 'Codex CLI · gpt-6.2-sol', effort: 'max', role: 'reviewer' }]);

    // Even with a reviewer member, delegation === 'none' omits requireAcceptanceReview so backend never rejects with 400.
    const noneDelegation = validateTeamDraft({ ...withReviewerDraft, delegation: 'none', requireAcceptanceReview: true }, cliConfig);
    expect(noneDelegation.valid).toBe(true);
    expect(noneDelegation.payload?.requireAcceptanceReview).toBeUndefined();
  });

  it('sanitizes persisted sessionStorage drafts safely', () => {
    const parsed = parseTeamDraft({
      mode: 'custom',
      leadModel: 'astra',
      delegation: 'explicit',
      members: [{ model: 'astra', role: 'writer' }, { model: 'sol', role: 'reviewer' }, { model: 'sol', role: 'writer' }],
      allowLeadWrite: true,
      requireAcceptanceReview: false,
    });
    expect(parsed).toEqual({
      mode: 'custom',
      leadModel: 'astra',
      leadEffort: '',
      delegation: 'explicit',
      members: [{ model: 'sol', role: 'reviewer' }],
      allowLeadWrite: true,
      requireAcceptanceReview: false,
    });
  });
});

describe('CollabPopover & CollabPanel', () => {
  const emptyModel = buildObservatory(null, [], [], [], false);

  it('renders custom team editor for a fresh chat with runtime mode, lead picker, dispatch modes and unavailable reasons', () => {
    const draft = toggleTeamMember(enterCustomTeamMode(DEFAULT_TEAM_DRAFT, apiConfig), 'deepseek-v4-pro', apiConfig);
    const validation = validateTeamDraft(draft, apiConfig);
    const pill = renderToStaticMarkup(<CollabPopover capabilities={[]} model={emptyModel} demo={false}
      teamConfiguration={apiConfig} teamDraft={draft} onTeamDraft={vi.fn()} teamValidation={validation} />);
    expect(pill).toContain('自定义团队');
    expect(pill).toContain('主 gpt-6.2-astra +1');

    const panel = renderToStaticMarkup(<CollabPanel capabilities={[]} model={emptyModel} demo={false}
      teamConfiguration={apiConfig} teamDraft={draft} onTeamDraft={vi.fn()} teamValidation={validation} />);
    expect(panel).toContain('API Key');
    expect(panel).toContain('自定义协作团队');
    expect(panel).toContain('自主调度');
    expect(panel).toContain('按需调度');
    expect(panel).toContain('禁止调度');
    expect(panel).toContain('允许主 Agent 直接写入与执行');
    expect(panel).toContain('完成前要求独立评审验收');
    // Unavailable model is explicitly shown with its reason and disabled, never hidden.
    expect(panel).toContain('claude-fable-5-2');
    expect(panel).toContain('缺少 ANTHROPIC_API_KEY');
    expect(panel).toContain('deepseek-v4-pro');
  });

  it('renders local subscription CLI badge and read-only frozen custom team for an already-started chat', () => {
    const chat = startedChat(frozenTeam);
    const model = buildObservatory(chat, [], [], [], false);
    const pill = renderToStaticMarkup(<CollabPopover capabilities={[]} model={model} demo={false} chat={chat} />);
    expect(pill).toContain('自定义团队');
    expect(pill).toContain('主 Codex CLI · 按需调度 · +1');
    expect(pill).toContain('data-seat="astra"');

    const panel = renderToStaticMarkup(<CollabPanel capabilities={[]} model={model} demo={false} chat={chat} />);
    expect(panel).toContain('本会话协作团队');
    expect(panel).toContain('本地订阅 CLI');
    expect(panel).toContain('已冻结');
    expect(panel).toContain('Codex CLI · gpt-6.2-astra');
    expect(panel).toContain('按需调度');
    expect(panel).toContain('Codex CLI · gpt-6.2-sol');
    expect(panel).toContain('实现写入');
    expect(panel).not.toContain('name="collab-team-mode"');

    const summary = renderToStaticMarkup(<SettingsSummary chat={chat} capabilities={[]} globalCapabilities={null} fixedDemo={false} />);
    expect(summary).toContain('data-seat="astra"');
    expect(summary).toContain('data-seat="sol"');
  });

  it('keeps stale collaborators removable even when zero other options are available (no lockout)', () => {
    const singleCliConfig: ChatTeamConfiguration = {
      ...cliConfig,
      options: [cliConfig.options[1]], // only 'astra' available; 0 available collaborators
    };
    const staleDraft: TeamDraft = {
      mode: 'custom',
      leadModel: 'astra',
      leadEffort: 'max',
      delegation: 'proactive',
      members: [{ model: 'deepseek-v4-pro', role: 'collaborator' }],
      allowLeadWrite: false,
      requireAcceptanceReview: true,
    };
    const validation = validateTeamDraft(staleDraft, singleCliConfig);
    expect(validation.valid).toBe(false);
    expect(validation.error).toContain('deepseek-v4-pro');

    const panel = renderToStaticMarkup(<CollabPanel capabilities={[]} model={emptyModel} demo={false}
      teamConfiguration={singleCliConfig} teamDraft={staleDraft} onTeamDraft={vi.fn()} teamValidation={validation} />);
    expect(panel).toContain('>清空<');
    expect(panel).toContain('deepseek-v4-pro');
    expect(panel).toContain('已失效');
    expect(panel).toContain('移除失效协作者 deepseek-v4-pro');
  });

  it('shows a pipeline notice when runMode is pipeline so custom team and pipeline stay mutually exclusive', () => {
    const panel = renderToStaticMarkup(<CollabPanel capabilities={[]} model={emptyModel} demo={false}
      runMode="pipeline" teamConfiguration={apiConfig} teamDraft={DEFAULT_TEAM_DRAFT} onTeamDraft={vi.fn()} />);
    expect(panel).toContain('当前为「流水线」运行方式');
    expect(panel).not.toContain('name="team-delegation"');
  });
});
