/**
 * 工作台配置：默认值 + config/workbench.config.json 覆盖。
 * 原则：型号与强度必须显式；不允许静默降级或使用会漂移的别名。
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod/v4';
import { DEFAULT_CLAUDE_OPTIONS, type ClaudeCodeOptions } from './adapters/claude-code.js';
import { DEFAULT_CODEX_OPTIONS, type CodexOptions } from './adapters/codex.js';
import { FORBIDDEN_MODEL_ALIASES } from './adapters/types.js';
import { DEFAULT_CRITERIA } from './core/criteria.js';
import { DEFAULT_DECISION_PARAMS } from './core/decision-engine.js';
import type { BuildOptions, Criterion, DecisionParams, ModelConfig, ReviewOptions } from './core/types.js';
import { BuildOptionsZ, ReviewInputZ } from './core/schemas.js';
import { DEFAULT_CONTEXT_BUDGET, type ContextBudgetOptions } from './core/context-budget.js';
import { DEFAULT_CURSOR_OPTIONS, type CursorOptions } from './adapters/cursor.js';
import type { CursorWriteCapabilities } from './adapters/cursor-writer.js';

export interface WorkbenchConfig {
  host: string;
  port: number;
  dataDir: string;
  /** Sol 构建作业的工作区根目录。Windows 默认放在短路径下，避免 node_modules 触发 260 字符路径限制 */
  workspacesRoot: string;
  targetPlatform: string;
  models: { claude: ModelConfig; astra: ModelConfig; sol: ModelConfig; grok: ModelConfig };
  docWriter: { role: 'claude' | 'astra' | 'sol'; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' };
  preflight: { enabled: boolean };
  build: BuildOptions;
  evaluator: Omit<ReviewOptions, 'model'>;
  finalReview: Omit<ReviewOptions, 'model'>;
  contextBudget: ContextBudgetOptions;
  chores: { digest: boolean; qgroup: boolean };
  adapters: { claude: ClaudeCodeOptions; codex: CodexOptions; cursor: CursorOptions; cursorWriter: { capabilities: CursorWriteCapabilities | null }; mock: { delayMs: number } };
  timeoutsMinutes: { clarify: number; propose: number; review: number; recheck: number; docs: number; buildExtra: number; probe: number };
  limits: { maxQuestionsPerTask: number; maxProposalsPerModel: number; maxConcurrentModelTasks: number; maxConcurrentJobs: number };
  decision: DecisionParams;
  criteria: Criterion[];
  /** 开发模式下 Vite 开发服务器的来源，例如 http://localhost:5173 */
  devOrigins: string[];
}

export function defaultConfig(cwd = process.cwd()): WorkbenchConfig {
  const win = process.platform === 'win32';
  return {
    host: '127.0.0.1',
    port: 5170,
    dataDir: path.join(cwd, 'data'),
    workspacesRoot: win ? path.join(os.homedir(), 'dmw-ws') : path.join(cwd, 'data', 'workspaces'),
    targetPlatform: 'Windows 11 x64（PowerShell）',
    models: {
      claude: { role: 'claude', adapter: 'claude-code', model: 'claude-opus-5-5', effort: 'max' },
      astra: { role: 'astra', adapter: 'codex', model: 'gpt-6.2-astra', effort: 'max' },
      sol: { role: 'sol', adapter: 'codex', model: 'gpt-6.2-sol', effort: 'max' },
      grok: { role: 'grok', adapter: 'cursor', model: 'grok-4.7-high-fast', effort: 'high' },
    },
    docWriter: { role: 'claude', effort: 'xhigh' },
    preflight: { enabled: true },
    build: { autoRework: false, maxRounds: 3, maxWriterSessions: 12, maxModelCalls: 20, maxActiveMinutes: 360, resumePolicy: 'never', lightReworkEnabled: false, lightReworkMinutes: 5 },
    evaluator: { enabled: false, effort: 'max', timeoutMinutes: 30 },
    finalReview: { enabled: false, effort: 'xhigh', timeoutMinutes: 30 },
    contextBudget: structuredClone(DEFAULT_CONTEXT_BUDGET),
    chores: { digest: false, qgroup: false },
    adapters: { claude: { ...DEFAULT_CLAUDE_OPTIONS }, codex: { ...DEFAULT_CODEX_OPTIONS }, cursor: structuredClone(DEFAULT_CURSOR_OPTIONS), cursorWriter: { capabilities: null }, mock: { delayMs: 800 } },
    timeoutsMinutes: { clarify: 30, propose: 60, review: 60, recheck: 30, docs: 60, buildExtra: 30, probe: 10 },
    limits: { maxQuestionsPerTask: 12, maxProposalsPerModel: 3, maxConcurrentModelTasks: 2, maxConcurrentJobs: 2 },
    decision: { ...DEFAULT_DECISION_PARAMS },
    criteria: DEFAULT_CRITERIA.map((c) => ({ ...c, anchors: [...c.anchors] })),
    devOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  };
}

const EffortZ = z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const ModelZ = z.object({
  adapter: z.enum(['claude-code', 'codex', 'cursor', 'mock']).optional(),
  model: z
    .string()
    .min(1)
    .refine((m) => !FORBIDDEN_MODEL_ALIASES.includes(m.toLowerCase()), '不允许使用会静默变化的型号别名，请写完整型号 ID')
    .optional(),
  effort: EffortZ.optional(),
});
const CommandZ = z.object({ command: z.string().min(1), args: z.array(z.string()).optional() }).nullable();
const PhaseZ = z.enum(['clarify', 'propose', 'review', 'recheck', 'adjudicate', 'build', 'evaluate', 'final_review', 'prd', 'handbook', 'devdoc', 'probe']);

const OverrideFileZ = z
  .object({
    host: z.literal('127.0.0.1').optional(),
    port: z.number().int().min(1024).max(65535).optional(),
    dataDir: z.string().optional(),
    workspacesRoot: z.string().optional(),
    targetPlatform: z.string().optional(),
    models: z.object({ claude: ModelZ.optional(), astra: ModelZ.optional(), sol: ModelZ.optional(), grok: ModelZ.optional() }).optional(),
    docWriter: z.object({ role: z.enum(['claude', 'astra', 'sol']).optional(), effort: EffortZ.optional() }).optional(),
    preflight: z.object({ enabled: z.boolean() }).strict().optional(),
    build: BuildOptionsZ.partial().optional(),
    evaluator: ReviewInputZ.optional(),
    finalReview: ReviewInputZ.optional(),
    contextBudget: z.object({ enabled: z.boolean() }).strict().optional(),
    chores: z.object({ digest: z.boolean(), qgroup: z.boolean() }).strict().optional(),
    adapters: z
      .object({
        claude: z.object({ command: CommandZ.optional(), nativeSchema: z.enum(['auto', 'always', 'never']).optional(), promptOnlySchemaPhases: z.array(PhaseZ).optional(), isolationArgs: z.array(z.string()).optional(), extraArgs: z.array(z.string()).optional(), scrubEnvKeys: z.array(z.string()).optional() }).optional(),
        codex: z.object({ command: CommandZ.optional(), extraArgs: z.array(z.string()).optional(), scrubEnvKeys: z.array(z.string()).optional(), ignoreUserConfig: z.boolean().optional(), promptOnlySchemaPhases: z.array(PhaseZ).optional() }).optional(),
        mock: z.object({ delayMs: z.number().int().min(0).max(60_000).optional() }).optional(),
        cursorWriter: z.object({ capabilities: z.object({
          verifiedAt: z.string().nullable(), cliVersion: z.string().nullable(), model: z.string().nullable(), reportedModel: z.string().nullable(),
          distro: z.string(), machineId: z.string(), nodePath: z.string(), entryPath: z.string(), nodeSha256: z.string(), entrySha256: z.string(), kernel: z.string(),
          bwrapPath: z.string(), bwrapSha256: z.string(), setsidPath: z.string(), setsidSha256: z.string(),
          toolPolicy: z.literal('workspace_edits_only'), commandExitEventsVerified: z.boolean(), fileChangesVerified: z.boolean(),
          workspaceWriteVerified: z.boolean(), isolatedWorkspaceVerified: z.boolean(), terminationVerified: z.boolean(),
        }).strict().nullable() }).strict().optional(),
        cursor: z.object({ command: CommandZ.optional(), extraArgs: z.array(z.string()).max(0).optional(),
          scrubEnvKeys: z.array(z.string()).optional(), capabilities: z.object({
            verifiedAt: z.string().nullable(), cliVersion: z.string().nullable(), model: z.string().nullable(),
            reportedModel: z.string().trim().min(1).nullable().optional(), toolPolicy: z.literal('deny_all').nullable().optional(),
            commandBinding: z.object({ file: z.string().min(1), prefixArgs: z.array(z.string()) }).strict().nullable().optional(),
            stdinPromptVerified: z.boolean(), readOnlyToolsVerified: z.boolean(), commandExitEventsVerified: z.boolean(), fileChangesVerified: z.boolean(),
          }).strict().nullable().optional() }).strict().optional(),
      })
      .optional(),
    timeoutsMinutes: z.record(z.string(), z.number().positive().max(24 * 60)).optional(),
    limits: z.record(z.string(), z.number().int().positive().max(50)).optional(),
    decision: z
      .object({
        tieMargin: z.number().min(0).max(2).optional(),
        disagreementThreshold: z.number().min(1).max(5).optional(),
        singleJudgeBand: z.number().min(0).max(5).optional(),
        preferredOrigin: z.enum(['claude', 'astra', 'none']).optional(),
        tiebreakCriterionId: z.string().nullable().optional(),
        tiebreakMinGap: z.number().min(0).max(5).optional(),
      })
      .optional(),
    criteriaWeights: z.record(z.string(), z.number().min(0).max(1)).optional(),
    devOrigins: z.array(z.string()).optional(),
  })
  .strict();

export function loadConfig(file = path.join(process.cwd(), 'config', 'workbench.config.json'), cwd = process.cwd()): WorkbenchConfig {
  const cfg = defaultConfig(cwd);
  if (!existsSync(file)) return cfg;
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  const o = OverrideFileZ.parse(raw);
  if (o.port) cfg.port = o.port;
  if (o.dataDir) cfg.dataDir = path.resolve(cwd, o.dataDir);
  if (o.workspacesRoot) cfg.workspacesRoot = path.resolve(cwd, o.workspacesRoot.replace(/^~(?=$|[\\/])/, os.homedir()));
  if (o.targetPlatform) cfg.targetPlatform = o.targetPlatform;
  for (const role of ['claude', 'astra', 'sol', 'grok'] as const) {
    const m = o.models?.[role];
    if (m) cfg.models[role] = { ...cfg.models[role], ...Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined)) } as ModelConfig;
  }
  if (o.docWriter?.role) cfg.docWriter.role = o.docWriter.role;
  if (o.preflight) cfg.preflight = o.preflight;
  if (o.build) cfg.build = { ...cfg.build, ...o.build };
  if (o.evaluator) cfg.evaluator = { ...cfg.evaluator, ...o.evaluator };
  if (o.finalReview) cfg.finalReview = { ...cfg.finalReview, ...o.finalReview };
  if (o.contextBudget) cfg.contextBudget = { ...cfg.contextBudget, ...o.contextBudget };
  if (o.chores) cfg.chores = o.chores;
  if (o.adapters?.cursor) cfg.adapters.cursor = { ...cfg.adapters.cursor, ...o.adapters.cursor };
  if (o.adapters?.cursorWriter) cfg.adapters.cursorWriter = o.adapters.cursorWriter;
  if (cfg.finalReview.effort === 'ultra') throw new Error('Claude 终审不支持 ultra 强度');
  if (o.docWriter?.effort) cfg.docWriter.effort = o.docWriter.effort;
  if (cfg.models[cfg.docWriter.role].adapter === 'claude-code' && cfg.docWriter.effort === 'ultra') {
    throw new Error('config.docWriter：Claude Code 不支持强度 ultra（可用 low/medium/high/xhigh/max）');
  }
  if (o.adapters?.claude) cfg.adapters.claude = { ...cfg.adapters.claude, ...Object.fromEntries(Object.entries(o.adapters.claude).filter(([, v]) => v !== undefined)) } as ClaudeCodeOptions;
  if (o.adapters?.codex) cfg.adapters.codex = { ...cfg.adapters.codex, ...Object.fromEntries(Object.entries(o.adapters.codex).filter(([, v]) => v !== undefined)) } as CodexOptions;
  if (o.adapters?.mock?.delayMs !== undefined) cfg.adapters.mock.delayMs = o.adapters.mock.delayMs;
  if (o.timeoutsMinutes) Object.assign(cfg.timeoutsMinutes, o.timeoutsMinutes);
  if (o.limits) Object.assign(cfg.limits, o.limits);
  if (o.decision) cfg.decision = { ...cfg.decision, ...Object.fromEntries(Object.entries(o.decision).filter(([, v]) => v !== undefined)) } as DecisionParams;
  if (o.criteriaWeights) {
    for (const c of cfg.criteria) if (o.criteriaWeights[c.id] !== undefined) c.weight = o.criteriaWeights[c.id]!;
    const sum = cfg.criteria.reduce((a, c) => a + c.weight, 0);
    if (Math.abs(sum - 1) > 1e-3) throw new Error(`config.criteriaWeights 之和必须为 1（当前 ${sum}）`);
  }
  if (o.devOrigins) cfg.devOrigins = o.devOrigins;
  return cfg;
}
