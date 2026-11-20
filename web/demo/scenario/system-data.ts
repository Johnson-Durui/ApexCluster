// Static data behind the system endpoints of the online demo (README.md "System endpoints"): seats and capabilities, the initial chat
// settings, the one workspace grant, the read-only environment check and the legacy run config.
// Shapes follow the product's API types (web/src/lib) and the server's answers. Every value is
// synthetic: the fingerprints are sha256 of 'mawb-demo|<preset>:<seat>:<model>', not values from a real machine.
// Types come from the product (import type only), so a product type change breaks `npm run typecheck:demo`.
import type { ChatSettings, DriverCapability, WorkspaceGrant } from '../../src/lib/chat-api';
import type { AppConfig } from '../../src/lib/types';
import type { ProbeReport } from '../../src/pages/new/environmentModel';

const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- workspace

/** The neutral demo project (README.md "Hard rules"). Chats that set workspaceId must use this id and version. */
export const DEMO_WORKSPACE_ID = 'w-roomdesk';
export const DEMO_WORKSPACE_PATH = 'D:\\Projects\\roomdesk';
export const DEMO_WORKSPACE_NAME = 'roomdesk';
export const DEMO_WORKSPACE_VERSION = 1;
/** Granted six days before the page was opened, so it predates every pre-baked chat. */
const GRANTED_AT = new Date(Date.now() - 6 * DAY - 37 * 60 * 1000).toISOString();

/** The active grant. A new object per call, so callers may not change the shared copy. */
export function demoWorkspaceGrant(): WorkspaceGrant {
  return { id: DEMO_WORKSPACE_ID, path: DEMO_WORKSPACE_PATH, name: DEMO_WORKSPACE_NAME, version: DEMO_WORKSPACE_VERSION, active: true, grantedAt: GRANTED_AT };
}

// ---------------------------------------------------------------- seats and capabilities

/**
 * A driver as the server sends it. `provider` and `isolationBasis` are server fields the UI never reads; they are
 * kept for realism. The type still checks every product field of DriverCapability.
 */
interface ServerDriver extends DriverCapability {
  provider: string;
  isolationBasis?: 'api-no-local-process';
}

/** Installed SDK version per provider protocol (the server's capability snapshot). */
const SDK: Record<string, string> = { anthropic: '1.9.0', openai: '7.57.0', google: '3.4.0' };

function seat(role: string, model: string, effort: string, provider: string, contextWindow: number, fingerprint: string, withBasis: boolean): ServerDriver {
  return {
    role, available: true, version: SDK[provider], fingerprint, isolationVerified: true,
    ...(withBasis ? { isolationBasis: 'api-no-local-process' as const } : {}),
    contextWindow, contextHard: 240000, model, effort, provider,
  };
}

/** The roster (config/roster.json, default bindings): claude, astra, opus, carbon, sol. Order is the map order. */
function flagshipSeats(withBasis: boolean): ServerDriver[] {
  return [
    seat('claude', 'claude-fable-5-2', 'max', 'anthropic', 1000000, '27996dec7e11a7ff91bafc149c81684288238c32b2571f752b51435b04cd7f98', withBasis),
    seat('astra', 'gpt-6.2-astra', 'max', 'openai', 1050000, '3b1b266efc0c0b582b3816f00c132eb7483c7b3f8d8df7d63a5d036a648675dd', withBasis),
    seat('opus', 'claude-opus-5-5', 'max', 'anthropic', 1000000, 'd7f5fa45e80135968552089729afd4c1d60d8892f54855618a68d6ac87a92b63', withBasis),
    seat('carbon', 'gemini-4-carbon', 'high', 'google', 1048576, '3df18b99f4f2bb84b9c237de1cb199c9e26e9cf651fab7063972e9773950d1c5', withBasis),
    seat('sol', 'gpt-6.2-sol', 'max', 'openai', 1050000, '29d827b7dd2f12c2eb61d08ae1ae27d9e22275c7bb3016f4584f36241b0d804a', withBasis),
  ];
}

/** config/presets single-provider: every seat on openai, so Sol and Opus share one family. */
function singleProviderSeats(): ServerDriver[] {
  return [
    seat('claude', 'gpt-6.2-astra', 'max', 'openai', 1050000, '261396576a7cd7f5285bfc1fd650be479355b00db60ae230103de220c7da06b1', false),
    seat('astra', 'gpt-6.2-astra', 'max', 'openai', 1050000, '3b1b266efc0c0b582b3816f00c132eb7483c7b3f8d8df7d63a5d036a648675dd', false),
    seat('opus', 'gpt-6.1-terra', 'max', 'openai', 1050000, '1707a99bfb6cb2bce1f354a762a13c2b2e33029428efc0a89b3e54503dea9613', false),
    seat('carbon', 'gpt-6-luna', 'high', 'openai', 1050000, '425275771600b4db93f91531d3cd22c3a0588a6aa8bb2a47aafdd2e899b715fe', false),
    seat('sol', 'gpt-6.2-sol', 'max', 'openai', 1050000, '29d827b7dd2f12c2eb61d08ae1ae27d9e22275c7bb3016f4584f36241b0d804a', false),
  ];
}

/**
 * The five API seats, all available. Chat snapshots (GET /api/chats/:id) carry the same array in `capabilities`,
 * as the real server fills it (http.ts:107). A new array per call.
 */
export function demoDrivers(): DriverCapability[] {
  return flagshipSeats(true);
}

/** The real reason runtime.ts gives for single-provider (the server's capability snapshot). */
export const SINGLE_FAMILY_REASON = '完整流水线需要 Sol 与 Opus 来自不同厂商家族';

/** ChatCapabilities.apiConfiguration: every key configured, every model verified, flagship available. */
export function apiConfiguration() {
  return {
    mode: 'api' as const,
    keyReadiness: [
      { provider: 'anthropic', env: 'ANTHROPIC_API_KEY', configured: true },
      { provider: 'openai', env: 'OPENAI_API_KEY', configured: true },
      { provider: 'google', env: 'GEMINI_API_KEY', configured: true },
      { provider: 'xai', env: 'XAI_API_KEY', configured: true },
      { provider: 'deepseek', env: 'DEEPSEEK_API_KEY', configured: true },
    ],
    modelChecks: ([
      ['claude-fable-5-2', 'anthropic'], ['claude-opus-5-5', 'anthropic'], ['claude-sonnet-5-5', 'anthropic'], ['claude-haiku-5-5', 'anthropic'],
      ['gpt-6.2-astra', 'openai'], ['gpt-6.2-sol', 'openai'], ['gpt-6-astra', 'openai'], ['gpt-6.1-sol', 'openai'], ['gpt-6.1-terra', 'openai'], ['gpt-6-luna', 'openai'],
      ['gemini-4-carbon', 'google'], ['gemini-4-hydrogen', 'google'], ['grok-4.7', 'xai'], ['deepseek-v4-pro', 'deepseek'], ['deepseek-flash', 'deepseek'],
    ] as const).map(([id, provider]) => ({ id, provider, status: 'verified' as const })),
    presets: [
      { id: 'flagship', rootSeat: 'claude', available: true, seats: flagshipSeats(false) },
      { id: 'single-provider', rootSeat: 'claude', available: false, reason: SINGLE_FAMILY_REASON, seats: singleProviderSeats() },
    ],
  };
}

/** ChatCapabilities.runner as the server sends it (platforms and commands are server-only fields). */
export const RUNNER = { available: true, platforms: [{ platform: 'windows', available: true }, { platform: 'linux', available: true }], commands: [] as string[] };
export const DATA_ROOT = 'D:\\workbench\\data\\chat';

// ---------------------------------------------------------------- chat settings

/** The settings the demo starts with on every page load (the server's settings shape). Consistent with the services list. */
export function initialSettings(): ChatSettings {
  return {
    version: 1,
    skills: [{ id: 'team-playbook', root: 'D:\\Projects\\skills\\team-playbook', enabled: true }],
    mcp: [{
      id: 'docs', enabled: true, transport: 'http', url: 'http://127.0.0.1:3100/mcp',
      toolAllowlist: ['search', 'fetch_page'], toolAccess: { search: 'read', fetch_page: 'read' },
      allowWrites: false, writeToolAllowlist: [], timeoutMs: 30000, maxOutputBytes: 262144, searchTool: 'search',
    }],
    media: {
      vision: { enabled: true, endpoint: 'https://media.example.com/v1', model: 'vision-large', apiKeyEnv: 'VISION_API_KEY', allowPaidCalls: true, timeoutMs: 30000, maxOutputBytes: 33554432 },
      image: { enabled: true, endpoint: 'https://media.example.com/v1/images', editEndpoint: 'https://media.example.com/v1/images/edits', model: 'image-studio', apiKeyEnv: 'IMAGE_API_KEY', allowPaidCalls: true, timeoutMs: 60000, maxOutputBytes: 33554432 },
    },
    documentWorker: { enabled: true, url: 'http://127.0.0.1:18781' },
  };
}

// ---------------------------------------------------------------- environment check (POST /api/probe)

/**
 * The free read-only check, all green. The real server always adds a 'cursor.capabilities' warn or error; the demo
 * leaves it out (README.md "System endpoints"). `at` is the time of the request.
 */
export function probeReport(): ProbeReport {
  return {
    at: new Date().toISOString(),
    platform: 'win32 10.0.26100',
    node: '22.12.0',
    findings: [
      { id: 'node', level: 'ok', message: 'Node.js 22.12.0' },
      { id: 'dataDir', level: 'ok', message: '数据目录可写：D:\\workbench\\data' },
      { id: 'claude.version', level: 'ok', message: 'Claude Code 2.1.300' },
      { id: 'claude.auth', level: 'ok', message: 'Claude Code 已登录（方式：claude.ai）' },
      { id: 'codex.version', level: 'ok', message: 'Codex CLI codex-cli 0.130.0' },
      { id: 'codex.auth', level: 'ok', message: 'Codex 已登录：Logged in using ChatGPT' },
      { id: 'git', level: 'ok', message: 'git 可用：git version 2.47.1.windows.1' },
      { id: 'codex.sandbox', level: 'ok', message: 'Codex Windows 沙箱：elevated' },
      { id: 'win.longpaths', level: 'ok', message: '已启用 Windows 长路径' },
      { id: 'workspaces', level: 'ok', message: 'Sol 工作区根目录：D:\\dmw-ws' },
    ],
    tools: {
      claude: { path: 'C:\\Tools\\claude\\claude.exe', via: 'direct', version: '2.1.300 (Claude Code)' },
      codex: { path: 'C:\\Tools\\codex\\codex.exe', via: 'direct', version: 'codex-cli 0.130.0' },
      cursor: { path: 'C:\\Tools\\cursor-agent\\cursor-agent.exe', via: 'direct', version: '2026.11.12-a1b2c3d' },
      git: { path: 'C:\\Program Files\\Git\\cmd\\git.exe', via: 'direct', version: 'git version 2.47.1.windows.1' },
    },
  };
}

// ---------------------------------------------------------------- legacy run config (GET /api/config)

/** src/core/criteria.ts DEFAULT_CRITERIA (weights sum to 1). */
const CRITERIA: AppConfig['criteria'] = [
  { id: 'fit', name: '需求适配', weight: 0.3, anchors: ['无法满足核心流程（通常已被硬约束淘汰）', '多个核心流程只能部分满足', '有一个核心流程只能部分满足', '满足全部核心流程，但至少一个依赖变通或额外组件', '满足全部核心流程，只有次要需求需要变通', '满足全部硬约束与核心流程，设计直接支撑每个核心流程，无已知冲突'] },
  { id: 'cost', name: '开发与维护成本', weight: 0.25, anchors: ['超出可承受的成本', '需要专门运维或多人协作才能维护', '多项新技术或多个常驻服务，或依赖不够成熟', '需要学习一项新技术或维护一个常驻服务', '少量新技术或少量运维工作', '单人可在现有技能内维护；依赖少且成熟；无额外运维'] },
  { id: 'reliability', name: '可靠性与可验证性', weight: 0.25, anchors: ['核心行为不可验证', '多个关键路径不可验证或没有失败处理', '存在已知单点故障或难以测试的关键路径', '失败处理一般，部分关键行为难以自动化验证', '主要失败场景有处理，自动化测试可覆盖大部分关键行为', '关键失败场景有明确处理，核心行为可被自动化测试覆盖，有可观测性'] },
  { id: 'performance', name: '性能与资源成本', weight: 0.1, anchors: ['无法满足目标负载', '存在已知瓶颈，难以满足', '需要专门优化才能满足', '刚好满足目标负载', '满足目标并有余量', '明显超出目标负载要求，资源占用低'] },
  { id: 'evolution', name: '后续演进', weight: 0.1, anchors: ['无法演进', '预期变化需要重写主要部分', '预期变化需要较大重构', '部分预期变化需要跨模块修改', '大部分预期变化可局部修改', '模块边界清晰，主要变化方向都可局部修改'] },
];

/** The full ContextBudgetOptions defaults the server sends (src/core/context-budget.ts); the UI reads only `enabled`. */
const CONTEXT_BUDGET = {
  enabled: false,
  contextWindows: { 'claude-opus-5-5': null, 'gpt-6.2-astra': null, 'gpt-6.2-sol': null, 'grok-4.7-high-fast': null },
  softRatio: 0.6, promptMaxRatio: 0.25, compactRatio: 0.85, resumeMaxRatio: 0.5, charsPerToken: 2.5, milestoneMaxMinutes: 35, maxMilestones: 12,
};

const CURSOR_REASON = '在线演示不连接本机 Cursor';

/** GET /api/config: the server shape (src/server/app.ts:129-147) with the defaults of src/config.ts. */
export function appConfig(): AppConfig {
  return {
    models: {
      claude: { role: 'claude', adapter: 'claude-code', model: 'claude-opus-5-5', effort: 'max' },
      astra: { role: 'astra', adapter: 'codex', model: 'gpt-6.2-astra', effort: 'max' },
      sol: { role: 'sol', adapter: 'codex', model: 'gpt-6.2-sol', effort: 'max' },
      grok: { role: 'grok', adapter: 'cursor', model: 'grok-4.7-high-fast', effort: 'high' },
    },
    docWriter: { role: 'claude', effort: 'xhigh', model: 'claude-opus-5-5' },
    preflight: { enabled: true },
    build: { autoRework: false, maxRounds: 3, maxWriterSessions: 12, maxModelCalls: 20, maxActiveMinutes: 360, resumePolicy: 'never', lightReworkEnabled: false, lightReworkMinutes: 5 },
    evaluator: { enabled: false, effort: 'max', timeoutMinutes: 30 },
    finalReview: { enabled: false, effort: 'xhigh', timeoutMinutes: 30 },
    contextBudget: CONTEXT_BUDGET,
    chores: { digest: false, qgroup: false },
    cursorCapabilities: { available: false, reason: CURSOR_REASON, model: 'grok-4.7-high-fast', verifiedAt: null, cliVersion: null, capabilities: null },
    cursorWriteCapabilities: { available: false, reason: CURSOR_REASON },
    criteria: CRITERIA.map(item => ({ ...item, anchors: [...item.anchors] })),
    decision: { tieMargin: 0.25, disagreementThreshold: 2, singleJudgeBand: 1, preferredOrigin: 'claude', tiebreakCriterionId: 'cost', tiebreakMinGap: 1 },
    limits: { maxQuestionsPerTask: 12, maxProposalsPerModel: 3, maxConcurrentModelTasks: 2, maxConcurrentJobs: 2 },
    targetPlatform: 'Windows 11 x64（PowerShell）',
    referenceLimits: { maxDocuments: 20, maxArchives: 5, maxDocumentChars: 50000, maxTotalChars: 100000, maxFileBytes: 524288, maxZipBytes: null, maxArchiveEntries: 1000, maxExpandedBytes: 104857600, maxEntryBytes: 20971520 },
  };
}
