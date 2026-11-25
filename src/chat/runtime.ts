import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod/v4';
import type { RunnerCommandInfo } from './runner-contract.js';
import { HttpError } from '../orchestrator/errors.js';
import { apiPromptVersion, buildContext, checkpoint, PROMPT_VERSION } from './context.js';
import { ChatStore } from './store.js';
import { sourcePlan, readSource, sourceCoverageIssues } from './source-context.js';
import type { ChatCapabilityHost, CapabilityReply } from './capability-contract.js';
import { SessionFiles } from './session-files.js';
import { PlanCompletionError, safePlanFeedback, updatePlan, planCompletionIssues, planCompletionDetails, settlePlans } from './plans.js';
import { professionalProfiles, profileAllows } from './profiles.js';
import type { ProjectExport, ProjectOutputStore } from '../artifacts/project-output.js';
import { executionRoot, hasFullPageChain, isExecutionReviewTask, latchExecutionReview, reviewerCanReadTask, reviewReadinessIssues, materializeExecutionView, executionCompletionIssues, submitExecutionReview } from './execution.js';
import { CHAT_LIMITS, terminalTask, type AgentTask, type ChatDriver, type ChatEvent, type ChatMessage, type ChatRecord, type ChatRole, type DriverInput, type Invocation, type ProgramDiffArtifact, type ResultReadPage, type RunnerEvidenceMetadata, type ToolDefinition, type ToolReceiptDelivery, type ToolReply, type WaitTicket } from './types.js';
import { allowedDelegateSeats, canDelegateByWeight, chatRoster, CLI_ROSTER, freezeApiRoster, phaseSchema, resolvePool, resolveSeat, seatIdSchema, taskSeat, type ApiChatBinding, type PhaseId, type ResolvedSeat, type Roster } from './roster.js';
import { buildApiTeamConfiguration, buildCliTeamConfiguration, synthesizeApiTeamRoster, synthesizeCliTeamRoster, type ChatTeamConfiguration } from './team.js';
import { contextPolicy } from './window.js';
import { buildHandoff, immutableBlob } from './handoff.js';
import { apiBudgetPatch, estimateUsageUsd, parseApiRunSettings, reserveUsageUsd, type ApiRunSettings } from './api-run-settings.js';
import { ModelThrottle } from './model-throttle.js';
import type { ModelSpec, ProviderUsage } from '../providers/types.js';
import { collectSchema, createFanoutGroup, dispositionSchema, fanoutGoals, fanoutSubmitSchema, mechanicalCollect, selectChildTasks, selectForDisposition, workerReportSchema, workerSubmitSchema, type FanoutGroup } from './fanout.js';
import { execDefinitions, execJobInput, type ExecTools } from '../exec/tools.js';
import { readExecTail } from '../exec/output.js';
import { readExecReceipt, sealExecRecord } from '../exec/records.js';
import type { ExecResult, ExecWorkspace, TaskExecJob } from '../exec/types.js';
import { DemoSourceMissingError } from './gateway.js';
import type { IntegrationResult } from './workspace.js';
import { newPipelineState, pendingPipelineGate, type PipelineGateId, type PipelineSettings } from '../pipeline/state.js';
import { applyPipelineGate, beginArchitectureRevision, validatePipelineGate, type GateAction } from '../pipeline/gates.js';
import { architectureArtifact, architectureDemoEvidence, architectureStepId, carryArchitectureCluster, clusterReadIssues, newArchitecturePlan, observeArchitecturePlan } from '../pipeline/architecture.js';
import { canonicalContractJson, ContractSubmissionZ, validateContractSubmission, type FrozenContract } from '../pipeline/contract.js';
import { buildClusterAggregate, clusterSubmitSchema, createClusterState, nextClusterWave, registerClusterWave, updateClusterTask, type ClusterState, type ClusterSubmitInput } from '../pipeline/cluster.js';
import type { ImplementationState, ManagedPipelineFile, MilestoneAttempt, MilestoneCheck, MilestoneDefinition, MilestoneProof, MilestoneProgress, PipelineMirrorEventInput, PipelineWorkspaceHost } from '../pipeline/implementation-types.js';
import { implementationPlanSchema, milestonePathIssues, milestoneRefinementSchema, pipelineReviewSchema, readyMilestones, validateImplementationPlan, validatePipelineReview } from '../pipeline/implementation.js';
import { buildImplementationTrace } from '../pipeline/trace.js';
import { approvedProposal, commandAcceptances, commandProof, implementationDocuments, readFrozenPipelineContract, readImplementationContract, sealProof } from '../pipeline/implementation-evidence.js';
import { PipelineMirrorCoordinator } from '../pipeline/mirror.js';

type DemoRepairPlan = { fromRevision: number; goal: string; reportRef: string };
type FailedOutcome = { reason: string; result?: string; demoRepair?: DemoRepairPlan };
type Active = { chat: ChatRecord; task: AgentTask; invocation: Invocation; controller: AbortController; toolController: AbortController; reason?: 'wait' | 'rotate' | 'cancel'; timer?: NodeJS.Timeout; done: Promise<void>; complete?: string; failedOutcome?: FailedOutcome; failureSubtree?: Promise<void>[]; progress: string; explicitCheckpoint?: boolean; pendingTools?: Set<Promise<ToolReply>>; toolFailures?: Map<string, { name: string; toolCallIds: Set<string> }>; receiptAcks?: Map<string, () => void> };
export interface WorkspaceToolHost {
  definitions: ToolDefinition[];
  assertWorkspace: (workspaceId: string, version?: number) => { version: number };
  call: (name: string, args: unknown, identity: WorkspaceToolIdentity) => Promise<ToolReply>;
  afterInvocation?: (identity: WorkspaceToolIdentity, exitConfirmed: boolean) => Promise<{ ticketId: string; reply: ToolReply }[]>;
  completionIssues?: (chat: ChatRecord, task: AgentTask) => string[];
  takeArtifacts?: (identity: WorkspaceToolIdentity) => Promise<ProgramDiffArtifact[]>;
  commandInfo?: () => RunnerCommandInfo[];
  resultReadBaseline?: (chat: ChatRecord, task: AgentTask) => { authority: string; sourceRevision: number };
  prepareExec?: (identity: WorkspaceToolIdentity) => ExecWorkspace;
  matchesCurrentSource?: (task: AgentTask, job: Omit<ExecWorkspace, 'copyDir'>) => boolean;
  finishExecWrites?: (identity: WorkspaceToolIdentity, source: Omit<ExecWorkspace, 'copyDir'>) => IntegrationResult | undefined;
  recordExecEvidence?: (identity: WorkspaceToolIdentity, jobId: string, source: Omit<ExecWorkspace, 'copyDir'>,
    platform: 'windows' | 'linux', result: ExecResult) => void;
}
export interface WorkspaceToolIdentity { chat: ChatRecord; task: AgentTask; invocation: Invocation; signal: AbortSignal }
export interface ChatRuntimeOptions {
  store: ChatStore; drivers: Record<ChatRole, ChatDriver>; workspace?: WorkspaceToolHost;
  api?: ApiChatBinding;
  apiRunSettings?: ApiRunSettings;
  executor?: ExecTools;
  browserExecutor?: ExecTools;
  pipelineSettings?: PipelineSettings;
  pipelineRosters?: ReadonlyMap<string, Roster>;
  pipelineWorkspace?: PipelineWorkspaceHost;
  capabilities?: ChatCapabilityHost;
  /** 仅测试可注入无模型驱动；产品仍走已验证能力。 */
  requireCostConfirmation?: boolean; handoffMs?: number;
  /** Production factory enables this only for newly created root tasks. */
  executionPolicyVersion?: 1;
  projectOutputs?: ProjectOutputStore;
}
const time = () => new Date().toISOString();
const textZ = z.string().trim().min(1).max(100_000);
const rawUserTextZ = z.string().min(1).max(100_000).refine(value => value.trim().length > 0, '消息不能为空');
const roleZ = z.enum(['claude', 'astra', 'sol', 'grok']);
const modeZ = z.enum(['read', 'edit', 'verify']);
const demoRepairReceiptSchema = z.object({
  accepted: z.literal(true), action: z.literal('demo_repair'), revision: z.number().int().positive(),
  reportRef: z.string().min(1).max(2000), finalization: z.literal('awaiting_confirmed_process_exit'),
}).strict();
type DemoRepairReceipt = z.infer<typeof demoRepairReceiptSchema>;
const demoReviewFailure = '当前架构修订的 Demo 独立评审未通过';
const { $schema: _workerDraft, ...workerReportInput } = z.toJSONSchema(workerReportSchema);
const { $schema: _contractDraft, ...contractInput } = z.toJSONSchema(ContractSubmissionZ);
const { $schema: _implDraft, ...implementationPlanInput } = z.toJSONSchema(implementationPlanSchema);
const { $schema: _refinementDraft, ...refinementInput } = z.toJSONSchema(milestoneRefinementSchema);
const { $schema: _reviewDraft, ...pipelineReviewInput } = z.toJSONSchema(pipelineReviewSchema);
const milestoneVerifyInput = z.object({ milestoneId: z.string().min(1).max(80) }).strict();
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)])) : value;
const toolFailureKey = (name: string, args: unknown) => createHash('sha256').update(JSON.stringify([name, canonical(args)])).digest('hex');
const resultReadCandidate = Symbol('resultReadCandidate');
const toolTerminalCommitUnknown = Symbol('toolTerminalCommitUnknown');
type ResultReadCandidate = ResultReadPage & { digest: string; legacyDigest: string; runnerEvidenceCandidate?: RunnerEvidenceMetadata };
type RuntimeToolReply = CapabilityReply & { [resultReadCandidate]?: ResultReadCandidate };
const runnerEvidenceZ = z.object({
  ok: z.boolean(),
  result: z.object({ exitCode: z.number().int().nullable(), timedOut: z.boolean(), cancelled: z.boolean(), spawnError: z.string().nullable() }).passthrough(),
  testSnapshotId: z.string().min(1).max(160).optional(), sourceSnapshotId: z.string().regex(/^wsnap-[A-Za-z0-9-]{1,150}$/),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/), platform: z.enum(['windows', 'linux']),
}).passthrough();
const storedRunnerEvidenceZ = z.object({
  ok: z.boolean(), platform: z.enum(['windows', 'linux']), sourceSnapshotId: z.string().regex(/^wsnap-[A-Za-z0-9-]{1,150}$/),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/), testSnapshotId: z.string().min(1).max(160).optional(), exitCode: z.number().int().nullable(),
  timedOut: z.boolean(), cancelled: z.boolean(), spawnError: z.string().nullable(), processExitConfirmed: z.literal(true),
  bodyFirstInvocationId: z.string().min(1), bodyFirstToolCallId: z.string().min(1),
}).strict();
const parseRunnerEvidence = (text: string, bodyFirstInvocationId: string, bodyFirstToolCallId: string): RunnerEvidenceMetadata | undefined => {
  let value: unknown; try { value = JSON.parse(text); } catch { return undefined; }
  const parsed = runnerEvidenceZ.safeParse(value); if (!parsed.success) return undefined;
  return { ok: parsed.data.ok, platform: parsed.data.platform, sourceSnapshotId: parsed.data.sourceSnapshotId, sourceFingerprint: parsed.data.sourceFingerprint,
    ...(parsed.data.testSnapshotId ? { testSnapshotId: parsed.data.testSnapshotId } : {}), exitCode: parsed.data.result.exitCode,
    timedOut: parsed.data.result.timedOut, cancelled: parsed.data.result.cancelled, spawnError: parsed.data.result.spawnError, processExitConfirmed: true,
    bodyFirstInvocationId, bodyFirstToolCallId };
};
const compactResultPage = (page: ResultReadPage) => ({ ref: page.ref, hash: page.hash, offset: page.offset, next: page.next, workspaceVersion: page.workspaceVersion, sourceRevision: page.sourceRevision, baselineAuthority: page.baselineAuthority, coverageIndex: page.coverageIndex, firstInvocationId: page.firstInvocationId, firstToolCallId: page.firstToolCallId });
const compactRunnerEvidence = (page: ResultReadPage, currentAuthority: string) => ({ ...compactResultPage(page), currentBaseline: page.baselineAuthority === currentAuthority, bodyProvided: true, metadata: page.runnerEvidence });
const objectSchema = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const str = { type: 'string' };
const definitions: ToolDefinition[] = [
  { name: 'plan_read', description: '读取当前任务的公开计划、revision和证据。计划是执行清单，不是隐式思维过程。', inputSchema: objectSchema({}, []) },
  { name: 'execution_read', description: '恢复长任务契约、当前哈希、完整viewRef和评审状态。section:steps/evidence按offset/next分页恢复工作定义或证据元数据，换段后无需猜ID；这些元数据不代替result_read完整viewRef及实际证据，不能验收工作。', inputSchema: objectSchema({ section: { type: 'string', enum: ['overview','steps','evidence'] }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, []) },
  { name: 'execution_submit_review', description: '仅指定Astra独立评审者提交当前契约的逐步骤评审。先完整读取execution_read的viewRef与证据，发布自己kind:report的真实报告。outcome为passed/failed/insufficient，stepVerdicts精确覆盖全部工作步骤；评审在工作计划之外。', inputSchema: objectSchema({ contractHash: str, evidenceHash: str, outcome: { type: 'string', enum: ['passed','failed','insufficient'] }, stepVerdicts: { type: 'array', maxItems: 32, items: objectSchema({ stepId: str, outcome: { type: 'string', enum: ['passed','failed','insufficient'] } }, ['stepId','outcome']) }, reportArtifactId: str }, ['contractHash','evidenceHash','outcome','stepVerdicts','reportArtifactId']) },
  { name: 'plan_update', description: '按revision逐步骤更新公开计划。pending可改草稿和补设验收；开始后text/dependsOn/verification锁定，不能退回pending；关联子任务和证据只可追加，省略数组保留原值。completed/failed为不可改写的终态，失败重试须另建任务。verification只能是artifact+准确name、真实工作tool+toolName或task+真实linkedTaskIds；task_evidence、result_read、task_state、file_list等协调/取证查询不能验收工作。完成时引用各自真实证据，例如child用task+linkedTaskIds，根集成/测试用integrate_edit或test_submit及其实际ref；不得重复用一条证据完成不同步骤。', inputSchema: objectSchema({ revision: { type: 'integer', minimum: 0 }, steps: { type: 'array', maxItems: 32, items: objectSchema({ id: str, text: str, status: { type: 'string', enum: ['pending','in_progress','completed','failed'] }, dependsOn: { type: 'array', items: str }, linkedTaskIds: { type: 'array', items: str }, evidenceRefs: { type: 'array', items: str }, verification: objectSchema({ kind: { type: 'string', enum: ['artifact','tool','task'] }, name: str, toolName: str }, ['kind']) }, ['id','text','status']) } }, ['revision','steps']) },
  { name: 'session_file_list', description: '列出本聊天已发送附件和生成文件，返回不可变ID/名称/哈希。与授权项目文件分开。', inputSchema: objectSchema({ offset: { type: 'integer', minimum: 0 } }, []) },
  { name: 'session_file_read', description: '按fileId分页读取文本附件。Office/PDF用document_read，图片用image_read；路径文字不代表图像已传入。', inputSchema: objectSchema({ fileId: str, offset: { type: 'integer', minimum: 0 } }, ['fileId']) },
  { name: 'session_file_write', description: '在本聊天输出目录生成新的文本文件；不覆盖原项目。程序保存字节与哈希并发布下载。', inputSchema: objectSchema({ name: str, text: str }, ['name','text']) },
  { name: 'task_state', description: '查询程序持有的紧凑任务状态、直属子任务/票据计数、检查点、最近安全回执和可用能力。截断项按 recovery 提示查询，不能用模型摘要替代。', inputSchema: objectSchema({}, []) },
  { name: 'task_evidence', description: '分页查询自身或直接子任务的程序回执引用：offset默认0，limit默认10且仅允许1..20；严格按返回next翻页。用 result_read 读取原始内容；model 产物不能代替 runner/workspace 证据。', inputSchema: objectSchema({ taskId: str, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, []) },
  { name: 'user_source_list', description: '分页列出完整用户原文及当前目标来源的ID、哈希和页数。大材料保留原文，先核对全部必保来源再修改或完成。', inputSchema: objectSchema({ offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 40 } }, []) },
  { name: 'user_source_read', description: '按来源ID和next偏移读取必保原文。原文完整保存在宿主；实际回执后程序登记已提供的来源页。', inputSchema: objectSchema({ sourceId: str, offset: { type: 'integer', minimum: 0 } }, ['sourceId']) },
  { name: 'agent_submit', description: '委派Astra协作分析/独立验收或Sol实现/集成。架构围绕Claude主导的同一方案补充，目标附当前方案与已定约束，不重复独立提案。全部工作步骤完成后root Claude用Astra+verify+purpose:execution_review创建独立执行评审；评审本身不列工作步骤。普通委派不填purpose；可指定专业profileId，模型角色保持不变。', inputSchema: objectSchema({ role: { type: 'string', enum: ['astra', 'sol'] }, goal: str, mode: { type: 'string', enum: ['read', 'edit', 'verify'] }, profileId: { type: 'string', enum: Object.keys(professionalProfiles) }, purpose: { type: 'string', enum: ['execution_review'] } }, ['role', 'goal']) },
  { name: 'grok_submit', description: '提交 Grok 子任务，每批最多32项。无累计调用预算；完成本批可继续。edit使用独立副本。', inputSchema: objectSchema({ tasks: { type: 'array', maxItems: 32, items: objectSchema({ goal: str, mode: { type: 'string', enum: ['read', 'edit', 'verify'] } }, ['goal']) } }, ['tasks']) },
  { name: 'grok_collect', description: '收集自己的子任务（含 Astra/Sol）结果摘要及完整引用，最多8项。wait=true时保存等待票据、释放本段；子任务到达后另开上下文。', inputSchema: objectSchema({ taskIds: { type: 'array', items: str, maxItems: 8 }, wait: { type: 'boolean' } }, []) },
  { name: 'grok_disposition', description: '声明一个已完成子任务的结果被采用、仅参考或拒绝。不得冒充真实测试。', inputSchema: objectSchema({ taskId: str, disposition: { type: 'string', enum: ['adopted', 'reference', 'rejected'] } }, ['taskId', 'disposition']) },
  { name: 'ask_user', description: '仅 Claude 根任务统一提问；先复用共享澄清记录，合并子任务缺口，只询问尚未回答且确实阻塞的信息或授权，随后释放模型进程。', inputSchema: objectSchema({ question: str, options: { type: 'array', items: str, maxItems: 6 } }, ['question']) },
  { name: 'task_yield', description: '保存交接说明，结束当前调用段，任务继续。程序保存真实状态与约束。', inputSchema: objectSchema({ next: str, note: str }, ['next']) },
  { name: 'task_complete', description: '提交已核实结果；程序检查子任务/票据/进程退出后才标记完成。', inputSchema: objectSchema({ result: str }, ['result']) },
  { name: 'task_fail', description: '仅在当前任务目标确实无法完成、必须以失败停止时提交原因和可选失败报告；参数或查询错误可纠正，不应据此失败。独立评审完成并得出不通过结论仍可正常交付评审报告，由父任务决定其目标是否失败。程序会先停止本任务未完成子树并确认相关进程退出，绝不把失败当成功。', inputSchema: objectSchema({ reason: { type: 'string', minLength: 1, maxLength: 2000 }, result: { type: 'string', minLength: 1, maxLength: 100000 } }, ['reason']) },
  { name: 'artifact_publish', description: '将文本产物保存为可下载文件；文件名不含路径。', inputSchema: objectSchema({ name: str, text: str, kind: { type: 'string', enum: ['file', 'diff', 'test', 'report'] } }, ['name', 'text']) },
  { name: 'result_read', description: '分页读取完整引用。首次提供时首行明确offset/next且正文格式不变；同任务同权威基线的同ref/hash/offset重复请求只返回alreadyProvided控制notice和next，不再次返回原文，也不表示模型已理解或工作已验收。', inputSchema: objectSchema({ ref: str, offset: { type: 'integer', minimum: 0 } }, ['ref']) },
];

/** 程序持有任务、等待、序号、权限与完成判定；模型仅提出工具请求。 */
export class ChatRuntime {
  readonly store: ChatStore;
  readonly files: SessionFiles;
  private readonly chats = new Map<string, ChatRecord>();
  private readonly active = new Map<string, Active>();
  private readonly finishing = new Set<Promise<void>>();
  private readonly jobs = new Map<string, Active>();
  private readonly listeners = new Map<string, Set<(event: ChatEvent) => void>>();
  private stopping = false;
  private pumping = false;
  private lastGrokParent = '';
  private readonly apiSettings: ApiRunSettings;
  private readonly modelThrottle = new ModelThrottle();
  private readonly parentSlotOrder = new Map<string, number>();
  private slotOrder = 0;
  private readonly handoffMs: number;
  private readonly pipelineMirror?: PipelineMirrorCoordinator;
  constructor(private readonly options: ChatRuntimeOptions) {
    this.store = options.store;
    this.files = new SessionFiles(this.store, options.projectOutputs);
    this.handoffMs = Math.min(options.handoffMs ?? CHAT_LIMITS.handoffMs, CHAT_LIMITS.handoffMs);
    this.apiSettings = options.apiRunSettings ?? parseApiRunSettings();
    if (options.pipelineWorkspace) this.pipelineMirror = new PipelineMirrorCoordinator(this.store, options.pipelineWorkspace);
  }
  capabilities() {
    const api = this.options.api;
    if (!api) return Object.values(this.options.drivers).map(driver => driver.capability);
    return api.roster.seats.map(seat => api.resolveDriver(resolveSeat(api.roster, seat.id)!).capability);
  }
  chatCapabilities(id: string) {
    const chat = this.get(id);
    const api = this.options.api;
    if (chat.apiRoster && api) {
      return chat.apiRoster.roster.seats.map(seat =>
        this.driverFor(chat, seat.id)?.capability ?? api.resolveDriver(resolveSeat(chat.apiRoster!.roster, seat.id)!).capability,
      );
    }
    if (chat.cliRoster) {
      return chat.cliRoster.seats.map(seat => this.options.drivers[seat.id]?.capability ?? {
        role: seat.id, available: false, reason: '本地 CLI 驱动未配置', isolationVerified: false,
        model: seat.bindings.default.model, effort: seat.bindings.default.effort,
      });
    }
    return this.capabilities();
  }
  teamConfiguration(): ChatTeamConfiguration {
    return this.options.api ? buildApiTeamConfiguration(this.options.api) : buildCliTeamConfiguration(this.options.drivers);
  }
  serviceCapabilities() { return this.options.capabilities?.status() ?? Promise.resolve([]); }
  /** Expose only public model metadata and environment variable presence. */
  apiConfiguration(exec?: { backend: string | null; available: boolean; reason?: string; unsafe?: boolean }) {
    const api = this.options.api;
    if (!api) return { mode: 'cli' as const, keyReadiness: [], modelChecks: [], presets: [] };
    const models = [...api.registry.values()];
    const keys = new Map<string, { provider: string; env: string; configured: boolean }>();
    for (const model of models) {
      keys.set(`${model.provider}:${model.apiKeyEnv}`, { provider: model.provider, env: model.apiKeyEnv,
        configured: Boolean(process.env[model.apiKeyEnv]?.trim()) });
    }
    const rosters = this.options.pipelineRosters ?? new Map([['flagship', api.roster]]);
    const presets = [...rosters].map(([id, roster]) => {
      const seats = roster.seats.map(item => api.resolveDriver(resolveSeat(roster, item.id)!).capability);
      const families = ['sol', 'opus'].map(role => {
        const binding = resolveSeat(roster, role, 'implementation')?.binding;
        return binding && api.registry.get(binding.model)?.family;
      });
      const crossFamily = !families.includes(undefined) && new Set(families).size === 2;
      const scope: 'full' | 'architecture_only' = crossFamily ? 'full' : 'architecture_only';
      const unavailable = seats.find(seat => !seat.available);
      const isolatedExecReady = !exec || (exec.available && !exec.unsafe);
      const architectureAvailable = !unavailable && isolatedExecReady;
      const reason = unavailable ? `${unavailable.role}：${unavailable.reason ?? '型号不可用'}`
        : !crossFamily ? '完整流水线需要 Sol 与 Opus 来自不同厂商家族'
          : exec && (!exec.available || exec.backend !== 'docker') ? exec.reason ?? '完整流水线需要 Docker 沙箱' : undefined;
      return { id, rootSeat: roster.rootSeat, seats, available: !reason, scope, architectureAvailable, ...(reason ? { reason } : {}) };
    });
    return { mode: 'api' as const, keyReadiness: [...keys.values()], modelChecks: models.map(model => ({
      id: model.id, provider: model.provider, status: api.modelCheckStatus?.(model) ?? 'unchecked',
    })), presets };
  }
  execCapabilities() {
    return this.options.executor?.capabilities() ?? Promise.resolve({ backend: null, available: false, reason: '当前运行层没有配置 API 执行后端', unsafe: false });
  }
  serviceSettings() { return this.options.capabilities?.settings?.() ?? {}; }
  async configureServices(input: unknown) {
    if (this.jobs.size || this.list().some(item => !terminalTask(item.status as AgentTask['status']))) throw new HttpError(409, '请先结束或取消正在执行/等待的任务，再修改能力配置');
    if (!this.options.capabilities?.configure) throw new HttpError(503, '扩展配置不可用');
    return this.options.capabilities.configure(input);
  }
  streams(id: string) {
    const chat = this.get(id); const finalTasks = new Set(chat.tasks.filter(task => !task.parentTaskId && task.status === 'completed').map(task => task.id));
    return chat.invocations.filter(inv => !finalTasks.has(inv.taskId)).slice(-8).flatMap(inv => {
      const task = chat.tasks.find(t => t.id === inv.taskId); const text = this.store.readStream(id, inv.id);
      return task && text ? [{ invocationId: inv.id, taskId: task.id, role: task.role, text, status: inv.status }] : [];
    });
  }
  upload(id: string, input: { name: string; base64: string; clientUploadId: string }) {
    const chat = this.get(id); const item = this.files.upload(chat, input); this.emit(chat, 'attachment', item); return item;
  }
  removeUpload(id: string, fileId: string) { const chat = this.get(id); this.files.remove(chat, fileId); this.emit(chat, 'attachment_removed', { id: fileId }); }
  list() { return this.store.list(); }
  get(id: string): ChatRecord {
    let chat = this.chats.get(id);
    if (!chat) { try { chat = this.store.get(id); } catch { throw new HttpError(404, '聊天不存在或记录损坏'); } this.chats.set(id, chat); }
    return chat;
  }
  create(input: { title?: string; workspaceId?: string; pipeline?: unknown; team?: unknown }): ChatRecord {
    if (this.stopping) throw new HttpError(503, '工作台正在关闭');
    if (input.workspaceId) this.options.workspace?.assertWorkspace(input.workspaceId);
    if (input.workspaceId && !this.options.workspace) throw new HttpError(409, '本地文件能力不可用');
    if (input.team !== undefined && input.pipeline !== undefined) {
      throw new HttpError(400, '自定义多 Agent 团队配置暂不支持与固定流水线同时启用，请使用普通聊天模式');
    }
    const api = this.options.api;
    const pipeline = input.pipeline === undefined ? undefined : newPipelineState(input.pipeline, this.options.pipelineSettings);
    if (pipeline && (!api || !input.workspaceId)) throw new HttpError(409, '流水线需要 API 驱动和已授权的项目目录');
    let roster = pipeline
      ? (this.options.pipelineRosters?.get(pipeline.preset) ?? (pipeline.preset === 'flagship' ? api?.roster : undefined))
      : api?.roster;
    if (pipeline && !roster) throw new HttpError(400, '没有对应的流水线名册预设');
    let cliRoster: Roster | undefined;
    let team: ChatRecord['team'];
    if (input.team !== undefined) {
      if (api) {
        const synthesized = synthesizeApiTeamRoster(input.team, api);
        roster = synthesized.roster;
        team = synthesized.team;
      } else {
        const synthesized = synthesizeCliTeamRoster(input.team, this.options.drivers);
        cliRoster = synthesized.roster;
        team = synthesized.team;
      }
    }
    const { title, workspaceId } = input;
    const chat = this.store.create({ title, workspaceId, ...(api && roster ? { apiRoster: freezeApiRoster(roster, api.registry, api.context) } : {}),
      ...(cliRoster ? { cliRoster } : {}), ...(team ? { team } : {}), ...(pipeline ? { pipeline } : {}) });
    this.chats.set(chat.id, chat);
    return chat;
  }
  subscribe(id: string, fn: (event: ChatEvent) => void) { this.get(id); const set = this.listeners.get(id) ?? new Set(); set.add(fn); this.listeners.set(id, set); return () => { set.delete(fn); if (!set.size) this.listeners.delete(id); }; }
  private eventInput(type: string, data: unknown, task?: AgentTask, invocation?: Invocation): PipelineMirrorEventInput {
    return { type, data, ...(task ? { taskId: task.id, parentTaskId: task.parentTaskId, turnId: task.turnId } : {}), ...(invocation ? { invocationId: invocation.id } : {}) };
  }
  private publishEvent(event: ChatEvent): void {
    for (const fn of this.listeners.get(event.chatId) ?? []) { try { fn(event); } catch { /* 客户端断开不改变任务结果。 */ } }
  }
  private commitEventInput(chat: ChatRecord, input: PipelineMirrorEventInput): ChatEvent {
    const buffered = Boolean(chat.apiRoster && input.type !== 'stream_delta');
    const event = buffered ? this.store.commitEvent(chat, input) : this.store.appendEvent(chat, input);
    if (!chat.apiRoster && input.type !== 'stream_delta') this.store.save(chat);
    this.publishEvent(event);
    return event;
  }
  private emit(chat: ChatRecord, type: string, data: unknown, task?: AgentTask, invocation?: Invocation) {
    return this.commitEventInput(chat, this.eventInput(type, data, task, invocation));
  }
  private update(chat: ChatRecord, task: AgentTask) { task.updatedAt = time(); settlePlans(chat, task); const turn = chat.turns.find(t => t.id === task.turnId); if (turn?.rootTaskId === task.id) { turn.status = task.status; if (terminalTask(task.status)) turn.completedAt = time(); } this.emit(chat, 'task_updated', task, task); }
  private driverFor(chat: ChatRecord, role: ChatRole, phase?: PhaseId, poolProvider?: string): ChatDriver | undefined {
    if (!chat.apiRoster) return Object.hasOwn(this.options.drivers, role) ? this.options.drivers[role] : undefined;
    const seat = resolveSeat(chat.apiRoster.roster, role, phase) ?? resolvePool(chat.apiRoster.roster, role, phase, poolProvider);
    if (!seat || !Object.hasOwn(chat.apiRoster.modelHashes, seat.binding.model)) return undefined;
    return this.options.api?.resolveDriver(seat, chat.apiRoster.modelHashes[seat.binding.model], contextPolicy(chat.apiRoster.context, seat.id, seat.kind === 'worker'));
  }
  private apiPolicy(chat: ChatRecord, task: AgentTask) {
    return chat.apiRoster ? contextPolicy(chat.apiRoster.context, task.role, taskSeat(chat, task)?.kind === 'worker') : undefined;
  }
  private rootRole(chat: ChatRecord): ChatRole {
    return chatRoster(chat).rootSeat;
  }
  private delegatedPhases(task: AgentTask): PhaseId[] {
    const phase = task.phase ?? 'architecture';
    if (task.parentTaskId) return [phase];
    if (phase === 'architecture') return [phase, 'cluster', 'demo', 'acceptance'];
    if (phase === 'implementation') return [phase, 'acceptance'];
    return [phase];
  }
  private availablePools(chat: ChatRecord, task: AgentTask): string[] {
    const roster = chat.apiRoster?.roster;
    const seat = taskSeat(chat, task);
    if (!roster || !seat) return [];
    const layer = task.phase === 'implementation' || (task.phase === 'acceptance' && chat.tasks.some(item => item.turnId === task.turnId && item.phase === 'implementation'))
      ? 'implementation' : 'architecture';
    return roster.layers[layer].pools.filter(id => roster.pools.some(pool => pool.id === id && canDelegateByWeight(seat, pool)));
  }
  private clusterModes(chat: ChatRecord, seat: ResolvedSeat): ClusterSubmitInput['mode'][] {
    const roster = chat.apiRoster?.roster;
    if (!roster || seat.delegationWeight === undefined) return clusterSubmitSchema.shape.mode.options;
    const targets = allowedDelegateSeats(roster, seat);
    if (!targets.includes('astra') || !targets.includes('opus')) return [];
    return targets.includes('carbon') ? ['pair', 'full'] : ['pair'];
  }
  private assertApiDispatch(chat: ChatRecord, parent: AgentTask, items: readonly { goal: string }[], batchLimit: number | null) {
    const scheduler = this.apiSettings.scheduler;
    if (batchLimit !== null && items.length > batchLimit) throw new HttpError(429, '本批子任务超过配置上限');
    const open = this.children(chat, parent).filter(task => !terminalTask(task.status));
    if (scheduler.parentOutstanding !== null && open.length + items.length > scheduler.parentOutstanding) throw new HttpError(429, '当前父任务的未完成任务达到配置上限');
    if (scheduler.queued !== null) {
      const queued = [...this.chats.values()].reduce((sum, item) => sum + item.tasks.filter(task => task.status === 'queued').length, 0);
      if (queued + items.length > scheduler.queued) throw new HttpError(429, '全局队列达到配置上限');
    }
    let depth = 1;
    for (let ancestor: AgentTask | undefined = parent; ancestor?.parentTaskId; depth++) {
      ancestor = chat.tasks.find(task => task.id === ancestor!.parentTaskId);
    }
    if (depth > 3) throw new HttpError(409, '委派深度达到三层，需由上层任务重新分工');
    const recent = new Map<string, number>();
    const lastMinute = Date.now() - 60_000;
    for (const task of this.children(chat, parent)) {
      if (Date.parse(task.createdAt) >= lastMinute) recent.set(task.goal, (recent.get(task.goal) ?? 0) + 1);
    }
    for (const item of items) {
      const count = (recent.get(item.goal) ?? 0) + 1;
      if (count > 16) throw new HttpError(409, '相同目标短时间内派发过多，需核对委派');
      recent.set(item.goal, count);
    }
  }
  private enqueuePool(chat: ChatRecord, parent: AgentTask, poolId: string, items: readonly { goal: string; mode: AgentTask['mode'] }[], group?: FanoutGroup, reductionLevel?: number): AgentTask[] {
    const roster = chat.apiRoster!.roster;
    if (!this.availablePools(chat, parent).includes(poolId)) throw new HttpError(403, '该 Worker 池不在当前任务允许的委派目标中');
    const phase = parent.phase ?? 'architecture';
    const parentModel = taskSeat(chat, parent)?.binding.model;
    const poolProvider = parentModel ? this.options.api?.registry.get(parentModel)?.provider : undefined;
    const target = resolvePool(roster, poolId, phase, poolProvider);
    if (items.some(item => item.mode !== 'read')) {
      const canDelegateEdit = parent.mode === 'edit' || (!parent.parentTaskId && parent.role === this.rootRole(chat));
      if (!parent.workspaceId || !canDelegateEdit || parent.mode === 'verify') throw new HttpError(403, '编辑或验证型子任务需要授权的独立工作副本');
    }
    const driver = target ? this.driverFor(chat, poolId, phase, poolProvider) : undefined;
    const created = items.map(item => {
      const child = this.newTask(chat, poolId, item.goal, parent.turnId, parent, item.mode, phase);
      if (poolProvider) child.poolProvider = poolProvider;
      if (group) child.groupId = group.id;
      if (reductionLevel !== undefined) child.reductionLevel = reductionLevel;
      if (!driver?.capability.available) {
        child.status = 'failed';
        child.errorCode = 'POOL_MODEL_UNAVAILABLE';
        child.error = driver?.capability.reason ?? '没有匹配父席位厂商且可用的池型号';
      }
      return child;
    });
    if (group && reductionLevel === undefined) (chat.fanoutGroups ??= []).push(group);
    latchExecutionReview(chat, parent);
    this.emit(chat, group ? 'fanout_queued' : 'workers_queued', {
      ...(group ? { groupId: group.id } : {}), pool: poolId, count: created.length, reductionLevel,
    }, parent);
    this.schedule();
    return created;
  }
  private collectReduction(chat: ChatRecord, parent: AgentTask, group: FanoutGroup, children: AgentTask[]): AgentTask[] {
    if (!group.reduce || !children.length || children.some(child => !terminalTask(child.status))) return children;
    const level = children.reduce((max, child) => Math.max(max, child.reductionLevel ?? 0), 0);
    const last = children.filter(child => (child.reductionLevel ?? 0) === level);
    if (level && (last.length === 1 || last.some(child => child.status !== 'completed'))) return children;
    const goals: Array<{ goal: string; mode: 'read' }> = [];
    for (let index = 0; index < last.length; index += 16) {
      const sources = last.slice(index, index + 16).map(child => ({ id: child.id, status: child.status, ref: child.resultRef ?? null, hash: child.resultHash ?? null }));
      goals.push({ mode: 'read', goal: `归并指令：${group.reduce}\n按登记 ref 读取结果。模型归并只供参考，保留原始来源。组 ${group.id}，批 ${index / 16 + 1}。\n${JSON.stringify(sources)}` });
    }
    this.assertApiDispatch(chat, parent, goals, null);
    return [...children, ...this.enqueuePool(chat, parent, group.pool, goals, group, level + 1)];
  }
  private newTask(chat: ChatRecord, role: ChatRole, goal: string, turnId: string, parent?: AgentTask, mode: AgentTask['mode'] = 'read', phase?: PhaseId): AgentTask {
    const grant = chat.workspaceId ? this.options.workspace?.assertWorkspace(chat.workspaceId) : undefined;
    const task: AgentTask = { id: randomUUID(), turnId, ...(parent ? { parentTaskId: parent.id } : {}), role, goal, status: 'queued', createdAt: time(), updatedAt: time(), segment: 0, invocationIds: [], noProgressSegments: 0, mode,
      ...(chat.apiRoster ? { phase: phase ?? parent?.phase ?? 'architecture' } : {}),
      ...(chat.workspaceId ? { workspaceId: chat.workspaceId, workspaceVersion: grant!.version } : {}),
      ...(!parent && (this.options.executionPolicyVersion === 1 || chat.pipeline) ? { executionPolicyVersion: 1 as const } : {}) };
    chat.tasks.push(task); return task;
  }
  send(id: string, input: { text: string; clientMessageId: string; confirmCost?: boolean; attachmentIds?: string[] }): { chat: ChatRecord; message: ChatMessage } {
    if (this.stopping) throw new HttpError(503, '工作台正在关闭');
    const chat = this.get(id);
    if (Boolean(chat.apiRoster) !== Boolean(this.options.api)) throw new HttpError(409, '请切换到该聊天创建时使用的驱动模式再继续');
    if (chat.blockedReason) throw new HttpError(409, chat.blockedReason);
    if (this.options.requireCostConfirmation && input.confirmCost !== true) throw new HttpError(400, '发送会调用已登录的模型并消耗额度，请确认');
    const text = rawUserTextZ.parse(input.text); const clientMessageId = z.string().min(1).max(100).parse(input.clientMessageId);
    const attachmentIds = input.attachmentIds ?? []; this.files.validateBinding(chat, attachmentIds);
    // 查找客户端幂等键，网络重试不能产生第二轮调用。
    for (let before: number | undefined;;) {
      const page = this.store.messages(id, { before, limit: 50 });
      const existing = page.items.find(m => m.clientMessageId === clientMessageId);
      if (existing) { if (existing.text !== text || JSON.stringify(existing.attachmentIds ?? []) !== JSON.stringify(attachmentIds)) throw new HttpError(409, '相同消息身份对应不同内容'); this.acceptMessage(chat, existing); this.schedule(); return { chat, message: existing }; }
      if (!page.nextBefore) break; before = page.nextBefore;
    }
    if (chat.pipeline) {
      if (pendingPipelineGate(chat.pipeline)) throw new HttpError(409, '请在流水线关卡提交决定');
      if (['completed', 'cancelled'].includes(chat.pipeline.stage)) throw new HttpError(409, '流水线已结束');
      if (['implementation', 'acceptance'].includes(chat.pipeline.stage)) throw new HttpError(409, '实现按冻结契约推进，返工或变更请在关卡提交');
      if (chat.pipeline.stage === 'architecture' && chat.pipeline.contract) throw new HttpError(409, '架构契约已冻结，修订意见请在关卡 A 提交');
      const architecture = chat.tasks.find(task => task.id === chat.pipeline?.architectureTaskId);
      if (chat.pipeline.stage === 'architecture' && architecture && terminalTask(architecture.status)) {
        throw new HttpError(409, '架构任务已停止，请查看结束原因后新建流水线');
      }
    }
    const turn = chat.turns.find(t => !terminalTask(t.status));
    if (!turn) {
      const driver = this.driverFor(chat, this.rootRole(chat), chat.apiRoster ? 'architecture' : undefined);
      if (!driver?.capability.available) throw new HttpError(503, driver?.capability.reason ?? '主导席聊天能力尚未验证');
    }
    const turnId = turn?.id ?? randomUUID();
    const message = this.store.appendMessage(chat, { role: 'user', text, clientMessageId, turnId, accepted: true, ...(attachmentIds.length ? { attachmentIds } : {}) });
    this.acceptMessage(chat, message);
    this.emit(chat, 'message', message); this.schedule(); return { chat, message };
  }
  private acceptMessage(chat: ChatRecord, message: ChatMessage) {
    if (message.role !== 'user' || !message.turnId) throw new HttpError(409, '消息缺少可恢复的轮次身份');
    if (chat.acceptedMessageIds?.includes(message.id)) return;
    this.files.validateBinding(chat, message.attachmentIds ?? []);
    const before = { tasks: [...chat.tasks], turns: [...chat.turns], attachments: chat.attachments?.map(file => ({ ...file, ...(file.messageIds ? { messageIds: [...file.messageIds] } : {}) })), acceptedMessageIds: chat.acceptedMessageIds ? [...chat.acceptedMessageIds] : undefined, title: chat.title,
      pipeline: chat.pipeline ? structuredClone(chat.pipeline) : undefined, todos: chat.todos ? [...chat.todos] : undefined, planRevision: chat.planRevision };
    const existing = chat.turns.find(turn => turn.id === message.turnId);
    let root = existing ? chat.tasks.find(task => task.id === existing.rootTaskId) : undefined;
    if (existing && !root) throw new HttpError(409, '轮次引用的任务缺失，不能重放');
    if (!root) {
      // The user message is a write-ahead intent. No model can start before a task snapshot exists.
      for (let since = 0;;) { const page = this.store.events(chat.id, since); if (page.items.some(event => event.turnId === message.turnId && ['invocation_started','tool_started'].includes(event.type))) throw new HttpError(409, '已存在执行记录但任务状态缺失，禁止重放'); if (!page.hasMore) break; since = page.next; }
      const rootSeat = resolveSeat(chatRoster(chat), this.rootRole(chat), chat.apiRoster ? 'architecture' : undefined);
      const rootMode: AgentTask['mode'] = chat.workspaceId && rootSeat?.can.writeMain ? 'edit' : 'read';
      root = this.newTask(chat, this.rootRole(chat), message.text, message.turnId, undefined, rootMode);
      chat.turns.push({ id: message.turnId, rootTaskId: root.id, status: 'queued', createdAt: message.createdAt });
      if (chat.pipeline && !chat.pipeline.architectureTaskId && chat.pipeline.stage === 'architecture') {
        chat.pipeline.architectureTaskId = root.id;
        chat.pipeline.revisionStartedAt = time();
        (chat.todos ??= []).push(...newArchitecturePlan(root.id, chat.pipeline.revision, time()));
        chat.planRevision = (chat.planRevision ?? 0) + 1;
      }
    }
    this.files.bind(chat, message.attachmentIds ?? [], message.id, false);
    (chat.acceptedMessageIds ??= []).push(message.id);
    if (chat.title === '新聊天') chat.title = message.text.trim().slice(0,40);
    try { this.store.save(chat); } catch (error) { Object.assign(chat,before); throw error; } // Binding, turn and root task commit together, before dispatch.
    if (existing && !terminalTask(root.status)) {
      for (const active of this.active.values()) if (active.chat.id === chat.id && active.task.id === root.id) this.release(active,'rotate');
      if (root.status === 'waiting_user') { const ticket = chat.tickets.find(ticket => ticket.taskId === root!.id && ticket.type === 'user' && !ticket.budget && ticket.status === 'pending'); if (ticket) this.resolveTicket(chat,ticket,message.text,message.id); }
      this.emit(chat,'steering',{messageId:message.id},root);
    } else if (!existing) this.update(chat,root);
  }
  /** Persist a gate decision as an immutable message before applying the transition. */
  decidePipelineGate(id: string, gateId: PipelineGateId, raw: GateAction): ChatRecord {
    const chat = this.get(id);
    this.recordPipelineGate(chat, gateId, raw, false);
    return chat;
  }
  private recordPipelineGate(chat: ChatRecord, gateId: PipelineGateId, raw: GateAction, automatic: boolean) {
    if (!chat.pipeline) throw new HttpError(404, '聊天未启用流水线');
    if (this.stopping || chat.blockedReason || !this.options.api) throw new HttpError(409, chat.blockedReason ?? '流水线当前不能继续');
    let action: GateAction;
    try { action = validatePipelineGate(chat.pipeline, gateId, raw, automatic); }
    catch (error) { throw new HttpError(409, error instanceof Error ? error.message : '关卡决定无效'); }
    if (gateId === 'A' && action.decision === 'confirm') {
      const root = chat.tasks.find(task => task.id === chat.pipeline?.architectureTaskId);
      const issues = root ? [...this.projectOutputIssues(chat, root), ...this.architectureSourceIssues(chat, root)] : [];
      if (issues.length) throw new HttpError(409, issues.join('；'));
    }
    if (gateId === 'B' && action.decision === 'confirm' && chat.pipeline.implementation) {
      const state = chat.pipeline.implementation;
      const reviewer = chat.tasks.find(task => task.id === state.acceptance?.taskId);
      const root = chat.tasks.find(task => task.id === state.rootTaskId);
      if (!reviewer || !root || !state.trace) throw new HttpError(409, '交付缺少最终验收和证据索引');
      const checks = this.productChecks(chat, reviewer);
      if (checks.requiredIds.some(id => !checks.checks.some(proof => proof.checkId === id && proof.ok))) {
        throw new HttpError(409, '成品已变化，请提交返工并复验后再接受');
      }
      const issues = this.projectOutputIssues(chat, root);
      if (issues.length) throw new HttpError(409, issues.join('；'));
    }
    const message = this.store.appendMessage(chat, {
      role: automatic ? 'system' : 'user', ...(automatic ? { auto: true } : {}), accepted: true,
      text: action.feedback ?? `关卡 ${gateId} ${action.decision === 'confirm' ? '确认通过' : '终止'}`,
      turnId: randomUUID(), pipelineGate: { id: gateId, revision: chat.pipeline.revision, decision: action.decision },
    });
    this.acceptPipelineGate(chat, message);
    this.emit(chat, 'message', message);
    this.schedule();
  }
  private acceptPipelineGate(chat: ChatRecord, message: ChatMessage) {
    const state = chat.pipeline;
    const gate = message.pipelineGate;
    if (!gate || !state || !message.turnId) throw new HttpError(409, '关卡消息缺少流水线身份');
    if (state.gateDecisions.some(item => item.messageId === message.id)) return;
    if (state.revision !== gate.revision) throw new HttpError(409, '关卡消息的修订编号已过期');
    const previous = state.architectureTaskId && chat.tasks.find(task => task.id === state.architectureTaskId);
    applyPipelineGate(state, gate.id, { decision: gate.decision, ...(gate.decision === 'revise' ? { feedback: message.text } : {}) },
      message.id, message.auto === true, time());
    if (gate.id === 'A' && gate.decision === 'revise') {
      const goal = `按最新用户反馈修订同一份架构方案。请继承原始需求，核对上一轮方案与集群材料。${previous ? ` 上轮架构任务 ${previous.id}。` : ''}`;
      const root = this.newTask(chat, this.rootRole(chat), goal, message.turnId);
      this.queueArchitectureTurn(chat, root, message.createdAt, previous || undefined);
    }
    if (this.options.pipelineWorkspace && ((gate.id === 'A' && gate.decision === 'confirm') || (gate.id === 'B' && gate.decision === 'revise'))) {
      this.queueImplementation(chat, message);
    }
    this.emit(chat, 'pipeline_gate_decided', state.gateDecisions.at(-1));
  }
  private queueArchitectureTurn(chat: ChatRecord, root: AgentTask, createdAt: string, previous?: AgentTask) {
    const state = chat.pipeline!;
    chat.turns.push({ id: root.turnId, rootTaskId: root.id, status: 'queued', createdAt });
    state.architectureTaskId = root.id;
    const carriesCluster = !!previous && carryArchitectureCluster(chat, state, previous, root, state.revision - 1);
    (chat.todos ??= []).push(...newArchitecturePlan(root.id, state.revision, createdAt, carriesCluster));
    chat.planRevision = (chat.planRevision ?? 0) + 1;
  }
  private advancePipelineGate(chat: ChatRecord) {
    const state = chat.pipeline;
    if (!state || chat.blockedReason) return;
    const root = chat.tasks.find(task => task.id === state.architectureTaskId);
    if (state.stage === 'architecture' && root?.status === 'completed') {
      state.stage = 'gate-a';
      this.emit(chat, 'pipeline_gate_opened', { gateId: 'A', revision: state.revision, mode: state.gates.architecture }, root);
    }
    if (state.stage === 'gate-a' && state.gates.architecture === 'auto' && !this.stopping) {
      this.recordPipelineGate(chat, 'A', { decision: 'confirm' }, true);
    }
    const lead = chat.tasks.find(task => task.id === state.implementation?.rootTaskId);
    if (state.stage === 'acceptance' && lead?.status === 'completed' && state.implementation?.trace) {
      state.stage = 'gate-b';
      this.emit(chat, 'pipeline_gate_opened', { gateId: 'B', revision: state.revision, mode: state.gates.delivery }, lead);
    }
    if (state.stage === 'gate-b' && state.gates.delivery === 'auto' && !this.stopping) {
      this.recordPipelineGate(chat, 'B', { decision: 'confirm' }, true);
    }
  }
  private queueImplementation(chat: ChatRecord, message: ChatMessage) {
    const state = chat.pipeline!;
    if (state.implementation) (state.priorImplementations ??= []).push(state.implementation);
    const root = this.newTask(chat, this.rootRole(chat), '统筹交付冻结契约。等待 Sol 交回后，委派全新 Astra 验收；核对真实回执与 TRACE.json 后交付。',
      message.turnId!, undefined, 'read', 'implementation');
    root.pipelineWork = { kind: 'implementation-lead' };
    const sol = this.newTask(chat, 'sol', '以冻结需求契约为依据，同 Opus 互签实现计划。待每个里程碑审核、集成和程序检查通过后交回。',
      root.turnId, root, 'edit', 'implementation');
    sol.pipelineWork = { kind: 'implementation-sol' };
    root.status = 'waiting_children';
    chat.turns.push({ id: root.turnId, rootTaskId: root.id, status: root.status, createdAt: message.createdAt });
    chat.tickets.push({ id: randomUUID(), taskId: root.id, invocationId: '', childIds: [sol.id], type: 'children', status: 'pending', createdAt: time() });
    state.implementationTaskId = sol.id;
    state.implementation = { version: 1, round: (state.implementation?.round ?? 0) + 1, rootTaskId: root.id, solTaskId: sol.id,
      proposals: [], milestones: [] };
  }
  private prepareImplementation(chat: ChatRecord, sol: AgentTask) {
    const pipeline = chat.pipeline!;
    const state = pipeline.implementation!;
    if (state.prepared) return;
    const families = ['sol', 'opus'].map(role => {
      const seat = resolveSeat(chat.apiRoster!.roster, role, 'implementation');
      return seat && this.options.api?.registry.get(seat.binding.model)?.family;
    });
    if (families.includes(undefined) || new Set(families).size !== 2) {
      throw new HttpError(409, 'Sol 与 Opus 的实现互签需要不同厂商家族，请选择跨厂商名册');
    }
    const previous = pipeline.priorImplementations?.at(-1);
    state.stateFileHash = previous?.stateFileHash;
    state.handoffFileHash = previous?.handoffFileHash;
    state.decisionsFileHash = previous?.decisionsFileHash;
    const requirementIds = readImplementationContract(this.store, chat).requirements.map(item => item.id);
    const decisions = ['# 决策记录', ...pipeline.gateDecisions.map((entry, index) =>
      `- D-${String(index + 1).padStart(3, '0')} 关卡 ${entry.gateId} ${entry.decision} · 来源 ${entry.messageId} · 冻结范围 ${requirementIds.join('、')} · 契约 ${pipeline.contract?.contractSha256}`)].join('\n') + '\n';
    const docs = implementationDocuments(this.store, chat);
    this.options.pipelineWorkspace!.writePipelineFiles(chat, sol, [...docs,
      { path: '.agent/DECISIONS.md', text: decisions, expectedHash: state.decisionsFileHash }]);
    state.decisionsFileHash = createHash('sha256').update(decisions).digest('hex');
    this.persistVerifiedMilestones(chat, sol);
    const baseline = this.options.pipelineWorkspace!.prepareVerification(chat, sol);
    state.baselineCommit = this.options.pipelineWorkspace!.commitMilestone(chat, sol, { snapshotId: baseline.sourceSnapshotId,
      paths: previous ? docs.map(item => item.path) : ['.'], message: `Pipeline round ${state.round} · approved contract` });
    state.prepared = true;
    this.emit(chat, 'implementation_prepared', { round: state.round, contract: pipeline.contract }, sol);
  }
  private implementationStateText(state: ImplementationState): string {
    return JSON.stringify({ version: 1, round: state.round, planHash: state.planHash ?? null,
      proposals: state.proposals.map(item => ({ ref: item.ref, hash: item.hash, reviewTaskId: item.reviewTaskId, review: item.review })),
      milestones: state.milestones, acceptance: state.acceptance, trace: state.trace, error: state.error }, null, 2) + '\n';
  }
  private persistVerifiedMilestones(chat: ChatRecord, sol: AgentTask, event?: PipelineMirrorEventInput) {
    const state = chat.pipeline!.implementation!;
    const text = this.implementationStateText(state);
    const committed = this.pipelineMirror!.stage(chat, sol, [{ path: '.agent/STATE.json', text, expectedHash: state.stateFileHash }], event);
    if (committed) this.publishEvent(committed);
  }
  private mirrorPipelineHandoff(chat: ChatRecord, task: AgentTask, text: string, event?: PipelineMirrorEventInput): boolean {
    const state = chat.pipeline?.implementation;
    if (!task.pipelineWork || !state?.prepared || !this.pipelineMirror) return false;
    const sol = chat.tasks.find(item => item.id === state.solTaskId)!;
    const stateText = this.implementationStateText(state);
    const committed = this.pipelineMirror.stage(chat, sol, [
      { path: '.agent/STATE.json', text: stateText, expectedHash: state.stateFileHash },
      { path: '.agent/HANDOFF.md', text, expectedHash: state.handoffFileHash },
    ], event);
    if (committed) this.publishEvent(committed);
    return Boolean(event);
  }
  private implementationCompletionIssues(chat: ChatRecord, task: AgentTask): string[] {
    const state = chat.pipeline?.implementation;
    const kind = task.pipelineWork?.kind;
    if (!state || !kind) return [];
    if (state.mirrorIntent) return ['流水线镜像意图尚未完成精确字节对账'];
    if (state.error && ['implementation-lead', 'implementation-sol'].includes(kind)) return [state.error];
    if (kind === 'implementation-sol' && (!state.planHash || !state.milestones.length || state.milestones.some(item => item.status !== 'complete'))) {
      return ['实现计划须经互签，每个里程碑须完成独立评审及程序检查'];
    }
    if (kind === 'implementation-lead' && (!state.trace || chat.pipeline!.stage !== 'acceptance')) return ['成品尚无通过的 Astra 验收及 TRACE.json'];
    if (kind === 'plan-review' && !state.proposals.find(item => item.reviewTaskId === task.id)?.review) return ['先提交绑定当前计划的 review_submit'];
    if (kind === 'milestone-review' && !state.milestones.some(item => item.attempts.at(-1)?.review?.reviewerTaskId === task.id)) {
      return ['先提交绑定当前候选的 review_submit'];
    }
    return [];
  }
  private safeCompleted(chat: ChatRecord, task: AgentTask): boolean {
    return task.status === 'completed' && task.invocationIds.length > 0 && task.invocationIds.every(id => {
      const invocation = chat.invocations.find(item => item.id === id);
      return invocation?.status === 'exited' && invocation.exitConfirmed && !this.active.has(id);
    });
  }
  private failMilestone(chat: ChatRecord, item: MilestoneProgress, attempt: MilestoneAttempt, reason: string) {
    attempt.reason = reason;
    const pipeline = chat.pipeline!;
    if (attempt.number <= pipeline.quality.maxReworkRounds) item.status = 'ready';
    else {
      item.status = 'blocked';
      pipeline.implementation!.error = `里程碑 ${item.id} 超过返工上限：${reason}`;
    }
  }
  private inspectAuthorDrift(chat: ChatRecord, task: AgentTask) {
    const work = task.pipelineWork;
    if (work?.kind !== 'milestone-author') return;
    const attempt = chat.pipeline?.implementation?.milestones.find(entry => entry.id === work.milestoneId)?.attempts.at(-1);
    if (!attempt || attempt.authorTaskId !== task.id || !work.baselineSnapshotId) return;
    const issues = milestonePathIssues(work.paths, this.options.pipelineWorkspace!.inspectMilestonePaths(chat, task));
    if (issues.length) this.recordAuthorDrift(chat, task, issues);
  }
  private recordAuthorDrift(chat: ChatRecord, task: AgentTask, issues: string[]) {
    const work = task.pipelineWork;
    if (work?.kind !== 'milestone-author' || !issues.length) return;
    const pipeline = chat.pipeline!;
    const state = pipeline.implementation!;
    const progress = state.milestones.find(item => item.id === work.milestoneId);
    const attempt = progress?.attempts.at(-1);
    const sol = chat.tasks.find(item => item.id === state.solTaskId);
    if (!attempt || !sol || attempt.authorTaskId !== task.id) return;
    attempt.drift = { ...attempt.drift, issues: [...new Set([...(attempt.drift?.issues ?? []), ...issues])].slice(0, 16) };
    if (!attempt.drift.taskId && this.availablePools(chat, sol).includes('hydrogen')) {
      const goal = `只读核对里程碑 ${work.milestoneId}：结合用户原文、冻结契约 ${pipeline.contract?.ref}、范围 ${JSON.stringify(work.paths)}、疑点 ${JSON.stringify(issues)}。worker report.summary 以“一致”或“存疑”开头，列出需求编号。`;
      const [watcher] = this.enqueuePool(chat, sol, 'hydrogen', [{ goal, mode: 'read' }]);
      if (watcher) {
        watcher.pipelineWork = { kind: 'alignment', milestoneId: work.milestoneId, attempt: work.attempt };
        attempt.drift.taskId = watcher.id;
      }
    }
    this.emit(chat, 'milestone_alignment', { milestoneId: work.milestoneId, ...attempt.drift }, task);
  }
  private registerPipelineReference(chat: ChatRecord, task: AgentTask, ref: string, hash: string, bytes: number, name: string) {
    (chat.toolResults ??= []).push({ taskId: task.id, invocationId: '', ref, hash, bytes, name, provenance: 'tool' });
  }
  private advanceImplementation(chat: ChatRecord) {
    const pipeline = chat.pipeline;
    const state = pipeline?.implementation;
    const host = this.options.pipelineWorkspace;
    if (!state || !host || chat.blockedReason || state.mirrorIntent || pipeline?.stage !== 'implementation') return;
    const sol = chat.tasks.find(task => task.id === state.solTaskId)!;
    const lead = chat.tasks.find(task => task.id === state.rootTaskId)!;
    if (terminalTask(sol.status)) {
      if (!this.safeCompleted(chat, sol) || !state.planHash || state.milestones.some(item => item.status !== 'complete')) {
        state.error ??= sol.error ?? '实现任务在全部里程碑核验之前停止';
        sol.disposition = 'rejected';
        return;
      }
      sol.disposition = 'adopted';
      const result = updatePlan(chat, lead, { revision: chat.planRevision ?? 0, steps: [{ id: `implementation-${state.round}`, text: '实现冻结计划并完成全部里程碑核验',
        status: 'completed', linkedTaskIds: [sol.id], verification: { kind: 'task' } }] });
      pipeline.stage = 'acceptance';
      this.emit(chat, 'plan_updated', result, lead);
      this.emit(chat, 'pipeline_stage', { stage: pipeline.stage }, lead);
      return;
    }
    if (state.error || !state.prepared) return;
    const recent = state.proposals.at(-1);
    const planReviewer = recent && chat.tasks.find(task => task.id === recent.reviewTaskId);
    let changed = false;
    if (recent && (!state.planHash || recent.refinesMilestone) && planReviewer && terminalTask(planReviewer.status) && !planReviewer.disposition) {
      planReviewer.disposition = recent.review?.outcome === 'passed' && this.safeCompleted(chat, planReviewer) ? 'adopted' : 'rejected';
      if (planReviewer.disposition === 'adopted') {
        const text = this.store.readBlob(chat.id, recent.ref).toString('utf8');
        if (createHash('sha256').update(text).digest('hex') !== recent.hash) throw new Error('实现计划草案哈希漂移');
        const priorHash = state.planHash ?? pipeline.priorImplementations?.at(-1)?.planHash;
        host.writePipelineFiles(chat, sol, [{ path: '.agent/PLAN.json', text, expectedHash: priorHash }]);
        state.planHash = recent.hash;
        if (!recent.refinesMilestone) state.milestones = recent.plan.milestones.map(item => ({ id: item.id, status: 'ready', attempts: [] }));
      } else if (!recent.refinesMilestone && state.proposals.length >= 2) state.error = '实现计划经过两轮评审仍未互签，已上报主导席';
      changed = true;
    }
    const proposal = approvedProposal(state);
    if (proposal && !state.error) {
      for (const progress of state.milestones) {
        const definition = proposal.plan.milestones.find(item => item.id === progress.id)!;
        if (this.advanceMilestone(chat, sol, definition, progress)) changed = true;
      }
      const programChecking = state.milestones.some(item => item.attempts.at(-1)?.verificationInvocationId);
      if (!state.error) for (const definition of readyMilestones(proposal.plan, state)) {
        if (programChecking && definition.owner === 'sol') continue;
        const progress = state.milestones.find(item => item.id === definition.id)!;
        const previous = progress.attempts.at(-1);
        const number = progress.attempts.length + 1;
        const goal = `实现冻结里程碑 ${definition.id}（第 ${number} 次）。${JSON.stringify(definition)}\n${previous?.reason ? `返工原因 ${previous.reason}` : ''}`;
        const author = this.newTask(chat, definition.owner, goal, sol.turnId, sol, 'edit', 'implementation');
        author.pipelineWork = { kind: 'milestone-author', milestoneId: definition.id, attempt: number, paths: definition.paths };
        progress.attempts.push({ number, authorTaskId: author.id });
        progress.status = 'authoring';
        changed = true;
      }
    }
    if (changed) {
      this.persistVerifiedMilestones(chat, sol, this.eventInput('implementation_updated', {
        round: state.round, planHash: state.planHash,
        milestones: state.milestones.map(item => ({ id: item.id, status: item.status })), error: state.error,
      }, sol));
      this.schedule();
    }
  }
  private advanceMilestone(chat: ChatRecord, sol: AgentTask, definition: MilestoneDefinition, progress: MilestoneProgress): boolean {
    const attempt = progress.attempts.at(-1);
    if (!attempt) return false;
    const author = chat.tasks.find(task => task.id === attempt.authorTaskId)!;
    const watcher = chat.tasks.find(task => task.id === attempt.drift?.taskId);
    let alignmentChanged = false;
    if (watcher && terminalTask(watcher.status) && !attempt.drift?.verdict) {
      let verdict: 'aligned' | 'suspect' = 'suspect';
      try { if (this.safeCompleted(chat, watcher) && JSON.parse(watcher.result ?? '').summary.startsWith('一致')) verdict = 'aligned'; }
      catch { /* Invalid reports cannot clear the mechanical finding. */ }
      attempt.drift!.verdict = verdict;
      watcher.disposition = 'reference';
      progress.suspectStreak = verdict === 'suspect' ? (progress.suspectStreak ?? 0) + 1 : 0;
      if (progress.suspectStreak >= 2) {
        progress.status = 'blocked';
        chat.pipeline!.implementation!.error = `里程碑 ${progress.id} 连续两次对齐存疑，已暂停并上报`;
        return true;
      }
      alignmentChanged = true;
    }
    if (progress.status === 'authoring' && terminalTask(author.status)) {
      if (watcher && !attempt.drift?.verdict) return alignmentChanged;
      author.disposition = this.safeCompleted(chat, author) ? 'adopted' : 'rejected';
      if (author.disposition === 'rejected') this.failMilestone(chat, progress, attempt, author.error ?? '作者任务未安全完成');
      else {
        try {
          const candidate = this.options.pipelineWorkspace!.freezeMilestoneCandidate(chat, author);
          const issues = milestonePathIssues(definition.paths, candidate.changes);
          if (issues.length) { this.recordAuthorDrift(chat, author, issues); throw new Error(issues.join('；')); }
          if (definition.owner === 'opus' && candidate.changes.deleted.length) throw new Error('Opus 集成要求保留既有文件；请把删除操作交给 Sol 并重新互签计划');
          if (Object.values(candidate.changes).every(paths => !paths.length)) throw new Error('未产生可评审改动');
          attempt.candidate = candidate;
          const subject = immutableBlob(this.store, chat.id, `milestone-${author.id}.json`, JSON.stringify(candidate));
          const reviewerRole = definition.owner === 'sol' ? 'opus' : 'sol';
          const reviewer = this.newTask(chat, reviewerRole,
            `独立评审 ${definition.id}。用 result_read 完整接收 ${subject.relativePath}（SHA-256 ${subject.hash}），亲自运行检查 ${JSON.stringify(definition.checks)}，然后提交 review_submit。`,
            sol.turnId, sol, 'verify', 'implementation');
          reviewer.pipelineWork = { kind: 'milestone-review', milestoneId: definition.id, attempt: attempt.number,
            subjectHash: subject.hash, subjectRef: subject.relativePath, snapshotId: candidate.snapshotId };
          this.registerPipelineReference(chat, reviewer, subject.relativePath, subject.hash, subject.bytes, 'milestone_subject');
          attempt.reviewerTaskId = reviewer.id;
          progress.status = 'reviewing';
        } catch (error) {
          const reason = error instanceof Error ? error.message : '无法冻结候选';
          if (attempt.drift?.taskId && !attempt.drift.verdict) { attempt.reason = reason; return true; }
          this.failMilestone(chat, progress, attempt, reason);
        }
      }
      return true;
    }
    const reviewer = chat.tasks.find(task => task.id === attempt.reviewerTaskId);
    if (progress.status === 'reviewing' && reviewer && terminalTask(reviewer.status)) {
      const approved = attempt.review?.outcome === 'passed' && this.safeCompleted(chat, reviewer);
      reviewer.disposition = approved ? 'adopted' : 'rejected';
      if (approved) progress.status = definition.owner === 'opus' ? 'integrating' : 'verifying';
      else this.failMilestone(chat, progress, attempt, attempt.review?.defects.map(item => `${item.id} ${item.description}`).join('；') || reviewer.error || '独立评审未通过');
      return true;
    }
    return alignmentChanged;
  }
  private submitImplementationPlan(active: Active, raw: unknown): ToolReply {
    const { chat, task } = active;
    const state = chat.pipeline!.implementation!;
    if (task.pipelineWork?.kind === 'milestone-author') {
      const work = task.pipelineWork;
      const input = milestoneRefinementSchema.parse(raw);
      const plan = approvedProposal(state)?.plan;
      const definition = plan?.milestones.find(item => item.id === input.milestoneId);
      if (state.error || work.started || !plan || !definition || work.milestoneId !== input.milestoneId || definition.owner !== task.role ||
        state.proposals.some(item => item.refinesMilestone === input.milestoneId)) throw new HttpError(409, '只能细化一次本人尚未开工的里程碑检查');
      if (state.proposals.some(item => !chat.tasks.find(candidate => candidate.id === item.reviewTaskId)?.disposition)) throw new HttpError(409, '等待在途的互签评审');
      if (Object.values(this.options.pipelineWorkspace!.inspectMilestonePaths(chat, task)).some(paths => paths.length)) {
        throw new HttpError(409, '源码已变更，里程碑检查已冻结');
      }
      const milestones = plan.milestones.map(item => item.id === definition.id ? { ...item, checks: input.checks } : item);
      return this.queuePipelinePlanReview(active, { milestones }, definition.owner === 'sol' ? 'opus' : 'sol', definition.id);
    }
    if (state.solTaskId !== task.id || state.planHash || state.error || state.proposals.length >= 2) throw new HttpError(409, '实现计划已冻结或互签已停止');
    const previous = state.proposals.at(-1);
    if (previous && !chat.tasks.find(item => item.id === previous.reviewTaskId)?.disposition) throw new HttpError(409, '等待 Opus 完成当前计划评审');
    return this.queuePipelinePlanReview(active, raw, 'opus');
  }
  private queuePipelinePlanReview(active: Active, raw: unknown, reviewerRole: 'sol' | 'opus', refinesMilestone?: string): ToolReply {
    const { chat, task } = active;
    const state = chat.pipeline!.implementation!;
    const contract = readImplementationContract(this.store, chat);
    const { plan, hash, text } = validateImplementationPlan(raw, contract, contract.sha256);
    if (state.proposals.some(item => item.hash === hash)) throw new HttpError(409, '相同计划已有结论，请按缺陷修改后再提交');
    const blob = immutableBlob(this.store, chat.id, `implementation-plan-${hash}.json`, text);
    const reviewer = this.newTask(chat, reviewerRole, `对冻结契约 ${contract.sha256} 审查${refinesMilestone ? `里程碑 ${refinesMilestone} 的检查细化` : '计划覆盖、分工、路径和检查'}。完整读取 ${blob.relativePath} 后用 review_submit 记录结论。`,
      task.turnId, task, 'read', 'implementation');
    reviewer.pipelineWork = { kind: 'plan-review', subjectHash: hash, subjectRef: blob.relativePath };
    this.registerPipelineReference(chat, reviewer, blob.relativePath, hash, blob.bytes, 'plan_subject');
    state.proposals.push({ plan, hash, ref: blob.relativePath, reviewTaskId: reviewer.id, authorTaskId: task.id, ...(refinesMilestone ? { refinesMilestone } : {}) });
    this.schedule();
    return this.wait(active, { type: 'children', childIds: [reviewer.id] });
  }
  private submitPipelineReview(chat: ChatRecord, task: AgentTask, raw: unknown): ToolReply {
    const binding = task.pipelineWork;
    const state = chat.pipeline!.implementation!;
    if (binding?.kind !== 'plan-review' && binding?.kind !== 'milestone-review') throw new HttpError(403, '当前任务没有实现评审权限');
    if (!hasFullPageChain(task, binding.subjectRef, binding.subjectHash, this.resultReadBaseline(chat, task).authority)) {
      throw new HttpError(409, '先完整读取登记的评审对象');
    }
    const proposal = binding.kind === 'plan-review' ? state.proposals.at(-1) : undefined;
    const milestone = binding.kind === 'milestone-review' ? state.milestones.find(item => item.id === binding.milestoneId) : undefined;
    const definition = approvedProposal(state)?.plan.milestones.find(item => item.id === milestone?.id);
    const attempt = milestone?.attempts.at(-1);
    const expectedReviewer = proposal?.reviewTaskId ?? attempt?.reviewerTaskId;
    if (task.id !== expectedReviewer) throw new HttpError(409, '当前评审对象已失效');
    const author = chat.tasks.find(item => item.id === (attempt?.authorTaskId ?? proposal?.authorTaskId ?? state.solTaskId))!;
    const identity = (item: AgentTask) => {
      const model = taskSeat(chat, item)?.binding.model ?? '';
      return { role: item.role as 'sol' | 'opus', model, family: this.options.api?.registry.get(model)?.family ?? '' };
    };
    const reviewerIdentity = identity(task);
    const authorIdentity = identity(author);
    const data = pipelineReviewSchema.parse(raw);
    const checks = (definition?.checks ?? []).flatMap(check => {
      const proof = commandProof(this.store, chat, task, check, attempt?.candidate?.fingerprint);
      return proof ? [proof] : [];
    });
    if (data.outcome === 'passed' && definition && checks.length !== definition.checks.length) throw new HttpError(409, '先亲自在冻结候选上执行全部里程碑检查');
    const review = validatePipelineReview(data, { subjectHash: binding.subjectHash, reviewerTaskId: task.id,
      reviewer: reviewerIdentity.role, reviewerModel: reviewerIdentity.model, reviewerFamily: reviewerIdentity.family,
      author: authorIdentity.role, authorModel: authorIdentity.model, authorFamily: authorIdentity.family,
      acceptanceIds: definition?.acceptanceIds ?? readImplementationContract(this.store, chat).acceptance.map(item => item.id), checks,
      requireChecks: data.outcome === 'passed' && Boolean(definition) });
    const slot = (proposal ?? attempt)!;
    if (slot.review && JSON.stringify(slot.review) !== JSON.stringify(review)) throw new HttpError(409, '当前评审已登记且不能覆盖');
    slot.review = review;
    this.emit(chat, 'pipeline_review_submitted', review, task);
    const result = { accepted: true, subjectHash: review.subjectHash, outcome: review.outcome };
    return { text: JSON.stringify(result), data: result };
  }
  private integratePipelineMilestone(active: Active, raw: unknown): ToolReply {
    const { chat, task, invocation } = active;
    const input = z.object({ taskId: z.string(), allowedFiles: z.array(z.string()).min(1).max(200) }).strict().parse(raw);
    const state = chat.pipeline!.implementation!;
    const progress = state.milestones.find(item => item.attempts.at(-1)?.authorTaskId === input.taskId);
    const attempt = progress?.attempts.at(-1);
    const definition = approvedProposal(state)?.plan.milestones.find(item => item.id === progress?.id);
    if (!progress || !attempt?.candidate || !definition || definition.owner !== 'opus' || attempt.review?.outcome !== 'passed') {
      throw new HttpError(409, '仅能集成经过交叉评审的本轮 Opus 冻结候选');
    }
    const changed = [...attempt.candidate.changes.created, ...attempt.candidate.changes.modified].sort();
    if (JSON.stringify([...new Set(input.allowedFiles)].sort()) !== JSON.stringify(changed)) throw new HttpError(409, '集成路径须精确匹配评审过的候选改动');
    if (progress.status !== 'integrating' && !attempt.integration) throw new HttpError(409, '当前候选尚未进入集成阶段');
    this.requireStableMain(state);
    attempt.integration ??= this.options.pipelineWorkspace!.integrateMilestone(chat, task, attempt.candidate, changed);
    if (!attempt.integrationCommit) {
      const snapshot = this.options.pipelineWorkspace!.prepareVerification(chat, task);
      attempt.integrationCommit = this.options.pipelineWorkspace!.commitMilestone(chat, task, { snapshotId: snapshot.sourceSnapshotId,
        paths: changed, message: `Integrate ${definition.id} · attempt ${attempt.number}` });
    }
    if (progress.status === 'integrating') progress.status = 'verifying';
    this.emit(chat, 'milestone_integrated', { milestoneId: progress.id, attempt: attempt.number, integration: attempt.integration }, task, invocation);
    return { text: JSON.stringify(attempt.integration), data: attempt.integration };
  }
  private requireStableMain(state: ImplementationState) {
    const plan = approvedProposal(state)?.plan;
    if (state.milestones.some(item => item.status === 'authoring' && plan?.milestones.find(definition => definition.id === item.id)?.owner === 'sol')) {
      throw new HttpError(409, '等待正在写入主工作区的 Sol 作者安全退出，再集成或核验');
    }
    if (state.milestones.some(item => item.status === 'verifying' && item.attempts.at(-1)?.verificationInvocationId)) {
      throw new HttpError(409, '已有程序检查正在使用冻结主工作区');
    }
  }
  private async verifyPipelineMilestone(active: Active, raw: unknown): Promise<ToolReply> {
    const { chat, task, invocation } = active;
    const { milestoneId } = milestoneVerifyInput.parse(raw);
    const state = chat.pipeline!.implementation!;
    if (state.mirrorIntent) {
      try {
        const event = this.pipelineMirror!.reconcile(chat, task);
        if (event) this.publishEvent(event);
      } catch (error) {
        throw new HttpError(409, `里程碑镜像尚未按精确字节对账：${error instanceof Error ? error.message : String(error)}`);
      }
      if (state.mirrorIntent) throw new HttpError(409, '里程碑镜像意图尚未提交');
    }
    const progress = state.milestones.find(item => item.id === milestoneId);
    const attempt = progress?.attempts.at(-1);
    const definition = approvedProposal(state)?.plan.milestones.find(item => item.id === milestoneId);
    if (progress?.status === 'complete' && attempt?.checks) {
      this.advanceImplementation(chat);
      const data = { ok: true, milestoneId, checks: attempt.checks, duplicate: true };
      return { text: JSON.stringify(data), data };
    }
    if (state.error || !definition || progress?.status !== 'verifying' || !attempt?.candidate || attempt.review?.outcome !== 'passed' ||
      (definition.owner === 'opus' && !attempt.integration)) throw new HttpError(409, '先完成冻结候选的交叉评审和所需集成');
    if (attempt.checks) throw new HttpError(409, '当前里程碑检查正在运行或等待中断核对');
    this.requireStableMain(state);
    const checks = attempt.checks = [] as MilestoneProof[];
    attempt.verificationInvocationId = invocation.id;
    let fingerprint: string | undefined;
    let failure: string | undefined;
    this.emit(chat, 'milestone_check_started', { milestoneId, attempt: attempt.number }, task, invocation);
    try {
      const changes = attempt.candidate.changes;
      this.options.pipelineWorkspace!.integrateMilestone(chat, task, attempt.candidate, [...changes.modified, ...changes.created, ...changes.deleted]);
      for (const check of definition.checks) {
        const prepared = this.options.pipelineWorkspace!.prepareVerification(chat, task);
        fingerprint ??= prepared.sourceFingerprint;
        if (prepared.sourceFingerprint !== fingerprint) throw new Error('检查期间主工作区源码发生变化');
        const reply = await this.dispatchExec(active, 'exec', { argv: check.argv, cwd: check.cwd, timeoutMs: check.timeoutMs, purpose: 'test' }, prepared);
        const { jobId } = reply.data as { jobId: string };
        const proof = commandProof(this.store, chat, task, check, fingerprint, jobId);
        if (!proof) throw new Error(`检查 ${check.id} 缺少真实 Docker 回执`);
        checks.push(proof);
        if (!proof.ok) failure ??= `检查 ${check.id} 未通过`;
        if (!this.options.workspace?.matchesCurrentSource?.(task, prepared)) throw new Error('检查期间主工作区源码发生变化');
      }
      if (!failure) {
        const last = checks.at(-1)!;
        attempt.commit = this.options.pipelineWorkspace!.commitMilestone(chat, task, { snapshotId: last.snapshotId,
          paths: [...changes.modified, ...changes.created, ...changes.deleted], message: `Verify ${definition.id} · attempt ${attempt.number}` });
      }
    } catch (error) { failure = error instanceof Error ? error.message : '检查失败'; }
    delete attempt.verificationInvocationId;
    if (failure) this.failMilestone(chat, progress, attempt, failure);
    else progress.status = 'complete';
    this.persistVerifiedMilestones(chat, task, this.eventInput('milestone_verified', {
      milestoneId, attempt: attempt.number, status: progress.status, checks, error: failure,
    }, task, invocation));
    this.advanceImplementation(chat);
    const data = { ok: !failure, milestoneId, checks, status: progress.status, error: failure };
    return { text: JSON.stringify(data), data };
  }
  private productChecks(chat: ChatRecord, reviewer: AgentTask) {
    const contract = readImplementationContract(this.store, chat);
    const required = commandAcceptances(contract);
    const checks = required.flatMap(check => {
      const proof = commandProof(this.store, chat, reviewer, check);
      const job = proof && chat.execJobs?.find(item => item.taskId === reviewer.id && item.receiptRef === proof.ref);
      return proof && job && this.options.workspace?.matchesCurrentSource?.(reviewer, job) ? [proof] : [];
    });
    const uiIds = contract.acceptance.filter(item => item.kind === 'ui').map(item => item.id);
    for (const id of uiIds) {
      const job = chat.execJobs?.findLast(item => item.taskId === reviewer.id && item.uiAcceptanceId === id && item.state === 'finished' && item.backend === 'docker');
      if (!job || !this.options.workspace?.matchesCurrentSource?.(reviewer, job)) continue;
      const proof = sealProof(this.store, chat, job, id);
      if (proof) checks.push(proof);
    }
    return { requiredIds: [...required.map(item => item.id), ...uiIds], checks, manualIds: contract.acceptance.filter(item => item.kind === 'manual').map(item => item.id) };
  }
  private publishPipelineTrace(active: Active, reviewer: AgentTask) {
    const { chat, task, invocation } = active;
    const state = chat.pipeline!.implementation!;
    if (state.trace || state.acceptance?.taskId !== reviewer.id || reviewer.pipelineWork?.kind !== 'product-review') return state.trace;
    if (task.executionReviewAttempts?.at(-1)?.review?.outcome !== 'passed' || !this.safeCompleted(chat, reviewer)) return undefined;
    const { trace, text, hash } = buildImplementationTrace(readImplementationContract(this.store, chat), state);
    if (trace.failed.length) throw new HttpError(409, `成品验收未通过：${trace.failed.join('、')}`);
    const output = this.publishArtifact(chat, task, invocation, { name: 'TRACE.json', text, kind: 'file' }, 'workspace');
    if (output.hash !== hash) throw new Error('TRACE.json 与计算的证据索引哈希不一致');
    state.trace = { ref: output.relativePath, hash, artifactId: output.id };
    const sol = chat.tasks.find(item => item.id === state.solTaskId)!;
    this.persistVerifiedMilestones(chat, sol, this.eventInput('pipeline_trace_published', {
      ...state.trace, unverified: trace.unverified,
    }, task, invocation));
    return { ...state.trace, unverified: trace.unverified };
  }
  answer(id: string, input: { ticketId: string; text: string; clientMessageId: string }): ChatRecord {
    const chat = this.get(id); const ticket = chat.tickets.find(t => t.id === input.ticketId && t.type === 'user');
    if (!ticket) throw new HttpError(404, '问题不存在');
    const answer = rawUserTextZ.parse(input.text);
    if (ticket.status === 'resolved') { if (ticket.answer !== answer) throw new HttpError(409, '该问题已经回答'); return chat; }
    if (ticket.status !== 'pending' || chat.blockedReason || this.stopping) throw new HttpError(409, '该问题已失效或运行尚未安全恢复');
    if (ticket.budget) {
      let parsed: unknown;
      try { parsed = JSON.parse(answer); } catch { throw new HttpError(400, '请提交包含 maxUsd 或 maxTokens 的预算设置'); }
      const update = apiBudgetPatch.safeParse(parsed);
      if (!update.success) throw new HttpError(400, '预算必须为正数或 null，token 上限必须为整数');
      const next = { ...(chat.apiBudget ?? this.apiSettings.budget), ...update.data };
      if (!this.canReserveBudget(chat, next, ticket.budget)) throw new HttpError(409, '新的预算仍不足以继续当前窗口');
      chat.apiBudget = next;
      ticket.status = 'resolved';
      ticket.resolvedAt = time();
      ticket.answer = answer;
      this.emit(chat, 'ticket_updated', ticket, chat.tasks.find(task => task.id === ticket.taskId));
      this.schedule();
      return chat;
    }
    const task = chat.tasks.find(t => t.id === ticket.taskId)!;
    if (terminalTask(task.status)) throw new HttpError(409, '任务已停止');
    const message = this.store.appendMessage(chat, { role: 'user', text: answer, clientMessageId: z.string().min(1).max(100).parse(input.clientMessageId), turnId: task.turnId });
    this.resolveTicket(chat, ticket, answer, message.id); this.emit(chat, 'message', message, task); this.schedule(); return chat;
  }
  private resolveTicket(chat: ChatRecord, ticket: WaitTicket, answer?: string, answerMessageId?: string) {
    if (ticket.status !== 'pending') return;
    ticket.status = 'resolved'; ticket.resolvedAt = time(); ticket.answer = answer;
    if (answerMessageId) ticket.answerMessageId = answerMessageId;
    this.emit(chat, 'ticket_updated', ticket, chat.tasks.find(t => t.id === ticket.taskId));
    const task = chat.tasks.find(t => t.id === ticket.taskId)!;
    if (!terminalTask(task.status) && !this.pending(chat, task).length) { task.status = 'queued'; this.update(chat, task); }
  }
  private pending(chat: ChatRecord, task: AgentTask) { return chat.tickets.filter(t => t.taskId === task.id && t.status === 'pending'); }
  private pendingBudget(chat: ChatRecord) {
    return chat.tickets.find(ticket => ticket.budget && ticket.status === 'pending');
  }
  private canReserveBudget(chat: ChatRecord, budget: ApiRunSettings['budget'], request: NonNullable<WaitTicket['budget']>): boolean {
    const usage = chat.apiUsage ?? { tokens: 0, usd: 0, unpriced: 0 };
    const unresolved = chat.apiUnresolvedUsage;
    let reservedTokens = request.requestedTokens + (unresolved?.tokens ?? 0);
    let reservedUsd = request.requestedUsd === null || unresolved?.unpriced ? null : request.requestedUsd + (unresolved?.usd ?? 0);
    for (const invocation of chat.invocations) {
      const pending = invocation.budgetReservation;
      if (!pending) continue;
      reservedTokens += pending.tokens;
      reservedUsd = reservedUsd === null || pending.usd === null ? null : reservedUsd + pending.usd;
    }
    return (budget.maxTokens === null || usage.tokens + reservedTokens <= budget.maxTokens) &&
      (budget.maxUsd === null || (reservedUsd !== null && usage.unpriced === 0 && usage.usd + reservedUsd <= budget.maxUsd));
  }
  private reserveApiRequest(active: Active, model: ModelSpec, inputTokens: number, outputTokens: number): boolean {
    const { chat, task, invocation } = active;
    if (this.pendingBudget(chat)) return false;
    const requested = { requestedTokens: inputTokens + outputTokens, requestedUsd: reserveUsageUsd(model, inputTokens, outputTokens) };
    const budget = chat.apiBudget ?? this.apiSettings.budget;
    if (budget.maxUsd === null && budget.maxTokens === null) return true;
    if (this.canReserveBudget(chat, budget, requested)) {
      invocation.budgetReservation = { tokens: requested.requestedTokens, usd: requested.requestedUsd };
      this.store.save(chat);
      return true;
    }
    const root = chat.tasks.find(item => item.id === chat.turns.find(turn => turn.id === task.turnId)?.rootTaskId) ?? task;
    const ticket: WaitTicket = {
      id: randomUUID(), taskId: root.id, invocationId: invocation.id, type: 'user', status: 'pending', createdAt: time(), budget: requested,
      question: '模型请求需要更多预算。请设置 maxUsd 或 maxTokens 后继续，金额为估算。',
    };
    chat.tickets.push(ticket);
    this.emit(chat, 'question', ticket, root, invocation);
    return false;
  }
  private settleApiRequest(active: Active, model: ModelSpec, usage?: Omit<ProviderUsage, 'type'>) {
    const { chat, invocation } = active;
    const reserved = invocation.budgetReservation;
    if (!usage && !reserved) return;
    if (usage) {
      const total = chat.apiUsage ??= { tokens: 0, usd: 0, unpriced: 0 };
      const usd = estimateUsageUsd(model, usage);
      total.tokens += usage.input + usage.output;
      if (usd === null) total.unpriced++;
      else total.usd += usd;
    } else this.recordUnresolvedApiUsage(chat, reserved);
    delete invocation.budgetReservation;
    if (chat.pipeline && usage) this.emit(chat, 'api_usage', { ...chat.apiUsage! }, active.task, invocation);
    else this.store.save(chat);
  }
  private recordUnresolvedApiUsage(chat: ChatRecord, reserved: Invocation['budgetReservation']) {
    if (!reserved?.started) return;
    const total = chat.apiUnresolvedUsage ??= { tokens: 0, usd: 0, unpriced: 0 };
    total.tokens += reserved.tokens;
    if (reserved.usd === null) total.unpriced++;
    else total.usd += reserved.usd;
  }
  private startApiRequest(active: Active) {
    const reservation = active.invocation.budgetReservation;
    if (!reservation || reservation.started) return;
    reservation.started = true;
    this.store.save(active.chat);
  }
  private children(chat: ChatRecord, task: AgentTask) { return chat.tasks.filter(t => t.parentTaskId === task.id); }
  private release(active: Active, reason: Active['reason']) {
    if (active.reason === 'cancel') return;
    active.reason = reason;
    if (!active.timer) active.timer = setTimeout(() => active.controller.abort(), this.handoffMs);
  }
  private wait(active: Active, ticket: Omit<WaitTicket, 'id' | 'taskId' | 'invocationId' | 'createdAt' | 'status'>): ToolReply {
    const { chat, task, invocation } = active;
    const saved: WaitTicket = { ...ticket, id: randomUUID(), taskId: task.id, invocationId: invocation.id, createdAt: time(), status: 'pending' };
    chat.tickets.push(saved); task.status = saved.type === 'user' ? 'waiting_user' : 'waiting_children';
    checkpoint(chat, task, invocation, saved.type === 'user' ? '等待用户回答' : '收集子任务结果');
    this.update(chat, task); this.emit(chat, saved.type === 'user' ? 'question' : 'waiting', saved, task, invocation); this.release(active, 'wait');
    return { text: JSON.stringify(saved), stop: 'wait' };
  }
  private progress(chat: ChatRecord, task: AgentTask) { return JSON.stringify({ messages: chat.constraintMessageIds, children: this.children(chat, task).map(t => [t.id, t.status, t.disposition]), artifacts: [...new Set(chat.artifacts.filter(a => a.taskId === task.id && a.provenance !== 'runner').map(a => a.hash))], evidence: task.evidenceHashes, reads: task.evidenceReadCoverage, coverage: task.sourceCoverage, sourceHashes: task.sourceCoverageHashes }); }
  private evidence(task: AgentTask, value: unknown) { const digest = createHash('sha256').update(JSON.stringify(value)).digest('hex'); const hashes = task.evidenceHashes ??= []; if (!hashes.includes(digest)) hashes.push(digest); }
  private evidenceRead(task: AgentTask, value: unknown) { const digest = createHash('sha256').update(JSON.stringify(value)).digest('hex'); const reads = task.evidenceReadCoverage ??= []; if (!reads.includes(digest)) reads.push(digest); }
  private descendants(chat: ChatRecord, task: AgentTask) { const ids = new Set<string>(); let changed = true; while (changed) { changed = false; for (const child of chat.tasks) if (child.parentTaskId && (child.parentTaskId === task.id || ids.has(child.parentTaskId)) && !ids.has(child.id)) { ids.add(child.id); changed = true; } } return chat.tasks.filter(item => ids.has(item.id)); }
  private stopOwnedSubtree(active: Active) {
    const { chat, task } = active; const descendants = this.descendants(chat, task); const ids = new Set(descendants.map(item => item.id)); const pending: Promise<void>[] = [];
    // Abort every owned job before persistence work so a later task/ticket write failure
    // cannot leave an un-aborted child behind while accepting a clean failed outcome.
    for (const job of this.jobs.values()) if (ids.has(job.task.id)) { this.release(job, 'cancel'); job.controller.abort(); job.toolController.abort(); pending.push(job.done); }
    pending.push(...this.stopExecJobs(chat, new Set([task.id, ...ids])));
    for (const child of descendants) if (!terminalTask(child.status)) { child.status = 'cancelled'; this.update(chat, child); }
    for (const ticket of chat.tickets) if (ticket.status === 'pending' && (ticket.taskId === task.id || ids.has(ticket.taskId))) { ticket.status = 'cancelled'; this.emit(chat, 'ticket_updated', ticket, chat.tasks.find(item => item.id === ticket.taskId)); }
    return pending;
  }
  private pendingExec(chat: ChatRecord, taskId: string) {
    return (chat.execJobs ?? []).some(job => job.taskId === taskId && job.state !== 'finished');
  }
  private stopExecJobs(chat: ChatRecord, scope?: ReadonlySet<string>): Promise<void>[] {
    if (!this.options.executor && !this.options.browserExecutor) return [];
    return (chat.execJobs ?? []).filter(job => job.state === 'running' && (!scope || scope.has(job.taskId))).map(async job => {
      const executor = job.uiAcceptanceId ? this.options.browserExecutor : this.options.executor;
      let exitConfirmed = false;
      try { exitConfirmed = (await executor?.jobs.stop(`${chat.id}:${job.taskId}`, job.id))?.result?.exitConfirmed === true; }
      catch { /* An absent driver receipt keeps the exit uncertain. */ }
      job.state = exitConfirmed ? 'finished' : 'exit_unknown';
      const task = chat.tasks.find(item => item.id === job.taskId);
      if (!exitConfirmed) {
        chat.blockedReason ??= '后台作业退出状态未知，已停止后续派发';
        if (task) task.status = 'interrupted';
      }
      this.emit(chat, 'exec_finished', { ...job, cancelled: true, exitConfirmed }, task);
    });
  }
  private schedule() { if (!this.pumping && !this.stopping) { this.pumping = true; queueMicrotask(() => { this.pumping = false; this.pump(); }); } }
  private pump() {
    if (this.stopping) return;
    if (this.options.api) { this.pumpApi(); return; }
    for (const grok of [true, false]) {
      const max = grok ? CHAT_LIMITS.grokConcurrency : CHAT_LIMITS.agentConcurrency;
      let free = max - [...this.active.values()].filter(a => (taskSeat(a.chat, a.task)?.kind === 'worker') === grok).length;
      const queued = [...this.chats.values()].filter(c => !c.blockedReason && Boolean(c.apiRoster) === Boolean(this.options.api)).flatMap(chat => chat.tasks.filter(t => t.status === 'queued' && (taskSeat(chat, t)?.kind === 'worker') === grok && ![...(chat.apiRoster ? this.jobs : this.active).values()].some(a => a.task.id === t.id)).map(task => ({ chat, task })));
      while (free-- > 0 && queued.length) {
        let index = grok ? queued.findIndex(q => q.task.parentTaskId !== this.lastGrokParent) : 0; if (index < 0) index = 0;
        const item = queued.splice(index, 1)[0]!;
        if (grok) this.lastGrokParent = item.task.parentTaskId ?? '';
        this.start(item.chat, item.task);
      }
    }
  }
  private pool(chat: ChatRecord, task: AgentTask) {
    return chat.apiRoster?.roster.pools.find(pool => pool.id === task.role);
  }
  private taskCapacity(chat: ChatRecord, task: AgentTask): { lane: string; limit: number | null } {
    const pool = this.pool(chat, task);
    return pool ? { lane: `pool:${pool.id}`, limit: pool.maxConcurrent }
      : { lane: 'seats', limit: this.apiSettings.scheduler.seatConcurrency };
  }
  private pumpApi() {
    const running = new Map<string, number>();
    const busy = new Set([...this.jobs.values()].map(job => job.task.id));
    for (const job of this.active.values()) {
      const { lane } = this.taskCapacity(job.chat, job.task);
      running.set(lane, (running.get(lane) ?? 0) + 1);
    }
    const queues = [...this.chats.values()]
      .filter(chat => chat.apiRoster && !chat.blockedReason && !this.pendingBudget(chat))
      .flatMap(chat => chat.tasks.filter(task => task.status === 'queued' && !busy.has(task.id))
        .map(task => ({ chat, task, ...this.taskCapacity(chat, task), key: task.parentTaskId ?? task.id })));
    for (;;) {
      let candidate: (typeof queues)[number] | undefined;
      let bestOrder = Number.POSITIVE_INFINITY;
      for (const item of queues) {
        const order = this.parentSlotOrder.get(item.key) ?? 0;
        if (order >= bestOrder || (item.limit !== null && (running.get(item.lane) ?? 0) >= item.limit)) continue;
        candidate = item;
        bestOrder = order;
      }
      if (!candidate) return;
      queues.splice(queues.indexOf(candidate), 1);
      running.set(candidate.lane, (running.get(candidate.lane) ?? 0) + 1);
      this.parentSlotOrder.set(candidate.key, ++this.slotOrder);
      this.start(candidate.chat, candidate.task);
    }
  }
  private start(chat: ChatRecord, task: AgentTask) {
    const binding = chat.apiRoster ? taskSeat(chat, task)?.binding : undefined;
    const invocation: Invocation = { id: randomUUID(), taskId: task.id, segment: ++task.segment, status: 'running', startedAt: time(), toolCount: 0, promptVersion: PROMPT_VERSION, inputEstimate: 0, contextWindow: null, contextUsed: null,
      ...(binding ? { model: binding.model, effort: binding.effort } : {}) };
    chat.invocations.push(invocation); task.invocationIds.push(invocation.id); task.status = 'running';
    latchExecutionReview(chat, task);
    const active: Active = { chat, task, invocation, controller: new AbortController(), toolController: new AbortController(), progress: this.progress(chat, task), done: Promise.resolve() };
    this.active.set(invocation.id, active); this.jobs.set(invocation.id, active); this.update(chat, task);
    active.done = this.execute(active).catch(error => {
      // 无法持久化状态时先中止进程；不能让日志异常把调用悄悄遗留在后台。
      active.controller.abort(); chat.blockedReason = `调用状态无法保存：${error instanceof Error ? error.message : String(error)}`;
    }).finally(() => {
      this.finishing.delete(active.done); this.active.delete(invocation.id); this.jobs.delete(invocation.id);
      if (chat.apiRoster && task.status === 'queued') this.schedule();
    });
    this.finishing.add(active.done);
  }
  private async execute(active: Active) {
    const { chat, task, invocation } = active; let output = ''; let failed: unknown; let exitConfirmed = true; let invoked = false;
    let budgetPaused = false;
    const policy = this.apiPolicy(chat, task);
    const timeout = policy ? Math.min(policy.maxMinutes * 60_000, 2_147_483_647) : CHAT_LIMITS.invocationMs;
    const deadline = setTimeout(() => {
      if (policy) invocation.rotationReason = 'time';
      this.release(active, 'rotate'); active.controller.abort(); active.toolController.abort();
    }, timeout);
    try {
      const driver = this.driverFor(chat, task.role, task.phase, task.poolProvider);
      if (driver?.capability.contextHard !== undefined) invocation.contextHard = driver.capability.contextHard;
      if (!driver?.capability.available || !driver.capability.isolationVerified) throw new Error(driver?.capability.reason ?? `${task.role} 隔离能力未验证`);
      if (chat.apiRoster && task.phase === 'implementation') {
        const execution = await this.execCapabilities();
        if (!execution.available) throw new Error(execution.reason ?? '实现层需要可用的执行后端');
        if (task.pipelineWork && execution.backend !== 'docker') throw new Error('产品实现需要已验证的 Docker 沙箱');
      }
      if (task.workspaceId) this.options.workspace!.assertWorkspace(task.workspaceId, task.workspaceVersion);
      if (task.pipelineWork?.kind === 'implementation-sol') this.prepareImplementation(chat, task);
      if (task.pipelineWork?.kind === 'milestone-author') {
        this.options.pipelineWorkspace!.prepareMilestoneAuthor({ chat, task, invocation, signal: active.toolController.signal });
      }
      const context = buildContext(chat, task, this.store); invocation.inputEstimate = context.inputEstimate;
      if (chat.apiRoster) invocation.promptVersion = apiPromptVersion(chat, task);
      const capabilitySnapshot = { version: 1, tools: this.tools(chat, task), settings: this.serviceSettings(), profile: task.profileId ?? 'general', services: await this.serviceCapabilities() };
      const snapshotBlob = this.store.putBlob(chat.id, `capabilities-${invocation.id}.json`, JSON.stringify(capabilitySnapshot));
      invocation.capabilitySnapshot = snapshotBlob.hash; invocation.capabilitySnapshotRef = snapshotBlob.relativePath;
      if (!policy && driver.capability.contextWindow && context.inputEstimate > driver.capability.contextWindow * .25) throw new Error('初始任务材料超过已验证窗口的25%，需要拆分材料');
      this.emit(chat, 'invocation_started', invocation, task, invocation);
      invoked = true;
      const result = await driver.invoke({ chatId: chat.id, task, invocation, directory: this.store.invocationDirectory(chat.id, invocation.id), ...context,
        tools: capabilitySnapshot.tools, signal: active.controller.signal,
        onText: delta => { if (active.reason || terminalTask(task.status)) return; output += delta; if (output.length > 2_000_000) { failed = new Error('模型输出超过2百万字符'); this.release(active, 'cancel'); return; } this.store.appendStream(chat.id, invocation.id, delta); this.emit(chat, 'stream_delta', { text: delta, role: task.role, channel: task.parentTaskId ? 'agent' : 'answer', mode: taskSeat(chat, task)?.kind === 'worker' ? 'result' : 'delta' }, task, invocation); },
        onContext: usage => {
          if (!Number.isFinite(usage.window) || !Number.isFinite(usage.used) || usage.window <= 0 || usage.used < 0 || active.reason) return;
          invocation.contextWindow = usage.window; invocation.contextUsed = usage.used;
          this.emit(chat, 'context_usage', { window: usage.window, used: usage.used }, task, invocation);
          if (!chat.apiRoster && usage.used >= usage.window * .5) { checkpoint(chat, task, invocation, '当前占用达到窗口50%，新上下文继续'); this.release(active, 'rotate'); active.controller.abort(); }
        },
        ...(policy && driver.capability.model ? {
          requestHooks: this.modelThrottle.hooks(driver.capability.model, this.taskCapacity(chat, task).limit),
          reserveApiRequest: (model: ModelSpec, inputTokens: number, outputTokens: number) => this.reserveApiRequest(active, model, inputTokens, outputTokens),
          startApiRequest: () => this.startApiRequest(active),
          settleApiRequest: (model: ModelSpec, usage?: Omit<ProviderUsage, 'type'>) => this.settleApiRequest(active, model, usage),
        } : {}),
        onReceiptsDelivered: ids => {
          for (const id of ids) {
            active.receiptAcks?.get(id)?.();
            active.receiptAcks?.delete(id);
          }
          this.store.save(chat);
        },
        callTool: (name, args) => this.callTool(chat.id, invocation.id, name, args),
      } satisfies DriverInput);
      if (active.pendingTools?.size) {
        let timer: NodeJS.Timeout | undefined;
        try { const outcomes = await Promise.race([Promise.allSettled([...active.pendingTools]), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('模型结束但工具尚未收口'), { exitConfirmed: false })), 5000); })]); if (outcomes.some(outcome => outcome.status === 'rejected')) failed = new Error('并发工具失败，不能将任务标为完成'); }
        finally { if (timer) clearTimeout(timer); }
      }
      output = result.text || output; exitConfirmed = result.exitConfirmed;
      if (active.toolFailures?.size) failed = new Error(`工具执行失败：${[...new Set([...active.toolFailures.values()].map(item => item.name))].join('、')}；需修复后重新执行`);
      invocation.contextWindow = result.contextWindow ?? invocation.contextWindow; invocation.contextUsed = result.contextUsed ?? invocation.contextUsed; invocation.finishReason = result.finishReason;
      budgetPaused = result.finishReason === 'budget_pause';
      if (chat.apiRoster && !active.reason && !active.complete && !active.failedOutcome && !failed) {
        if (result.finishReason === 'refusal') failed = new Error('供应商拒绝完成本次 API 调用');
        if (this.pool(chat, task) && result.finishReason === 'completed') {
          task.errorCode = 'WORKER_REPORT_REQUIRED';
          failed = new Error('worker 未提交结构化报告');
        }
        if (result.finishReason === 'context_ceiling_breach') {
          this.emit(chat, 'context_incident', { reason: 'context_ceiling_breach', peakUsed: invocation.peakUsed }, task, invocation);
          failed = new Error('供应商报告的窗口占用超过物理天花板，已停止当前任务');
        }
        if (result.finishReason === 'max_output' || result.finishReason === 'context_overflow' || result.finishReason === 'rotate') {
          invocation.rotationReason ??= 'hard';
          const overflow = result.finishReason === 'context_overflow';
          if (overflow) this.emit(chat, 'context_incident', { reason: 'context_overflow' }, task, invocation);
          const next = overflow ? '供应商报告上下文超限，打开新窗口继续' :
            result.finishReason === 'max_output' ? '输出续写再次触顶，打开新窗口继续' : '当前 API 窗口达到占用阈值，打开新窗口继续';
          checkpoint(chat, task, invocation, next);
          active.explicitCheckpoint = true;
          this.release(active, 'rotate');
        }
      }
      if (active.failureSubtree?.length) await Promise.allSettled(active.failureSubtree);
    } catch (error) { failed = error; if (invoked) exitConfirmed = !!error && typeof error === 'object' && (error as { exitConfirmed?: boolean }).exitConfirmed === true; }
    finally { clearTimeout(deadline); if (active.timer) clearTimeout(active.timer); }
    if (failed !== undefined) {
      const raw = failed instanceof Error ? failed.message : String(failed);
      const bounded = raw.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 1000) || '调用失败';
      const phase = failed && typeof failed === 'object' && ((failed as { phase?: unknown }).phase === 'pre_dispatch' || (failed as { phase?: unknown }).phase === 'post_dispatch') ? (failed as { phase: 'pre_dispatch' | 'post_dispatch' }).phase : undefined;
      invocation.failureMessage = bounded; if (phase) invocation.failurePhase = phase; task.error = bounded;
    }
    invocation.endedAt = time(); invocation.exitConfirmed = exitConfirmed; invocation.status = exitConfirmed ? 'exited' : 'exit_unknown';
    // 在释放槽位或异步清理前封锁，避免同一聊天的排队任务从间隙启动。
    if (!exitConfirmed) { chat.blockedReason = chat.apiRoster ? 'API 窗口的宿主工具退出状态未知，已停止后续派发。' : '模型进程树退出状态未知，已停止后续派发；需先核实残留进程与导入日志。'; task.status = 'interrupted'; }
    for (const ticket of chat.tickets.filter(t => t.invocationId === invocation.id && t.type === 'tool' && t.status === 'pending')) ticket.processStatus = exitConfirmed && active.reason !== 'cancel' ? 'running' : 'not_started';
    this.store.save(chat);
    this.emit(chat, 'invocation_ended', invocation, task, invocation);
    if (chat.blockedReason) this.emit(chat, 'state', { blockedReason: chat.blockedReason }, task, invocation);
    if (this.options.workspace?.afterInvocation) {
      // 模型已退出，释放模型并发槽。runner 属于独立队列，不能在 MCP 请求中执行。
      this.active.delete(invocation.id); this.schedule();
      try {
        const receipts = await this.options.workspace.afterInvocation({ chat, task, invocation, signal: active.toolController.signal }, exitConfirmed);
        for (const receipt of receipts) {
          const ticket = chat.tickets.find(t => t.externalId === receipt.ticketId && t.taskId === task.id);
          let data = receipt.reply.data as { ok?: boolean; progressFingerprint?: string; result?: { terminationWarning?: unknown } } | undefined;
          if (!data) { try { data = JSON.parse(receipt.reply.text) as typeof data; } catch { /* 非 JSON 文本不提供进程退出证据。 */ } }
          if (receipt.reply.processExitConfirmed === false || data?.result?.terminationWarning) {
            if (ticket) ticket.processStatus = 'exit_unknown';
            chat.blockedReason = '测试 runner 进程树退出状态未知，已停止后续派发';
            (chat.unsafeProcesses ??= []).push({ id: receipt.ticketId, kind: 'runner', taskId: task.id, reason: chat.blockedReason });
            task.status = 'interrupted'; this.store.save(chat); continue;
          }
          if (ticket) ticket.processStatus = 'exited';
          if (!ticket || ticket.status !== 'pending' || active.reason === 'cancel' || task.status === 'cancelled' || this.stopping) continue;
          const blob = this.store.putBlob(chat.id, `test-${ticket.id}.txt`, receipt.reply.text); ticket.resultRef = blob.relativePath;
          if (exitConfirmed && data?.ok === true) (chat.toolResults ??= []).push({ taskId: task.id, invocationId: ticket.invocationId, name: 'test_submit', provenance: 'runner', ref: blob.relativePath, hash: blob.hash, bytes: blob.bytes });
          const result = data?.result as Record<string, unknown> | undefined;
          this.evidence(task, data?.progressFingerprint && /^[0-9a-f]{64}$/.test(data.progressFingerprint) ? { test: data.progressFingerprint } : result ? { exitCode: result.exitCode, stdout: result.stdoutTail, stderr: result.stderrTail, cancelled: result.cancelled, timedOut: result.timedOut, spawnError: result.spawnError } : receipt.reply.text);
          this.resolveTicket(chat, ticket, receipt.reply.text.slice(0, 3500));
          this.publishArtifact(chat, task, invocation, { name: `测试记录-${ticket.id.slice(0, 8)}.json`, text: receipt.reply.text, kind: 'test' }, 'runner');
          this.emit(chat, 'test_result', { ticketId: ticket.id, ref: blob.relativePath, ok: data?.ok === true, text: receipt.reply.text.slice(0, 3500) }, task, invocation);
        }
      } catch (error) { failed = error; }
      if (exitConfirmed && !chat.unsafeProcesses?.some(p => p.taskId === task.id) && !active.toolController.signal.aborted && this.options.workspace.takeArtifacts) {
        try {
          for (const artifact of await this.options.workspace.takeArtifacts({ chat, task, invocation, signal: active.toolController.signal })) this.publishArtifact(chat, task, invocation, artifact, 'workspace');
        } catch (error) { failed = error; }
      }
    }
    const unsafeFailureSubtree = active.failedOutcome && this.descendants(chat, task).some(child => child.status === 'interrupted' || child.invocationIds.some(id => { const item = chat.invocations.find(candidate => candidate.id === id); return item?.status === 'exit_unknown' || item?.exitConfirmed === false; }));
    if (!exitConfirmed || (task.status === 'interrupted' && !!chat.blockedReason) || chat.unsafeProcesses?.some(p => p.taskId === task.id) || unsafeFailureSubtree) { task.status = 'interrupted'; }
    else if (active.reason === 'cancel' || this.stopping || task.status === 'cancelled') task.status = 'cancelled';
    else if (active.failedOutcome) {
      const repair = active.failedOutcome.demoRepair;
      if (repair && !failed) {
        try { this.startDemoRepair(chat, task, repair); }
        catch (error) {
          active.failedOutcome.reason = error instanceof Error ? error.message : 'Demo 返工初始化失败';
        }
      }
      this.failTask(chat, task, active.failedOutcome);
    }
    else if (failed && (!active.reason || active.reason === 'wait')) { task.status = 'failed'; for (const ticket of this.pending(chat, task)) ticket.status = 'cancelled'; }
    else if (budgetPaused) {
      invocation.rotationReason = 'wait';
      checkpoint(chat, task, invocation, '等待用户调整预算后继续');
      task.status = 'queued';
    }
    else if (active.reason === 'wait' && this.pending(chat, task).length) { /* 等待状态已持久化。 */ }
    else if (active.reason === 'rotate' || active.reason === 'wait') {
      if (!active.explicitCheckpoint) checkpoint(chat, task, invocation, '根据最新用户要求、子任务结果和程序状态继续', policy ? undefined : output.slice(-2000));
      task.noProgressSegments = active.progress === this.progress(chat, task) ? task.noProgressSegments + 1 : 0;
      task.status = task.noProgressSegments >= CHAT_LIMITS.noProgress ? 'failed' : 'queued';
      if (task.status === 'failed') task.error = '连续三段没有新的可核对进展（源码、测试结果、子任务或用户决定），已停止自动续接';
      if (!policy) this.emit(chat, 'context_rotated', { checkpointId: task.checkpointId, nextSegment: task.segment + 1 }, task, invocation);
    } else {
      const children = this.children(chat, task); const pending = children.filter(t => !terminalTask(t.status));
      if (pending.length) this.wait(active, { type: 'children', childIds: pending.map(t => t.id) });
      else if (children.some(t => !t.disposition)) { task.status = 'queued'; checkpoint(chat, task, invocation, '核对子任务结果，并声明采用/参考/拒绝后再完成'); task.noProgressSegments++; if (task.noProgressSegments >= CHAT_LIMITS.noProgress) { task.status = 'failed'; task.error = '子任务结果未收口，已停止无进展续接'; } }
      else this.complete(chat, task, active.complete ?? output);
    }
    if (policy && exitConfirmed && !terminalTask(task.status)) {
      this.inspectAuthorDrift(chat, task);
      const reason = invocation.rotationReason ?? (active.reason === 'wait' ? 'wait' : 'yield');
      const handoff = buildHandoff(chat, task, invocation, reason, this.store);
      invocation.rotationReason = reason;
      invocation.handoffRef = handoff.ref; invocation.handoffHash = handoff.hash;
      invocation.handoffStateRef = handoff.stateRef; invocation.handoffStateHash = handoff.stateHash;
      const pool = chat.apiRoster?.roster.pools.find(item => item.id === task.role);
      const spentWindows = chat.invocations.filter(item => item.taskId === task.id && (item.finishReason !== 'budget_pause' || item.usage)).length;
      if (!budgetPaused && taskSeat(chat, task)?.kind === 'worker' && spentWindows >= (pool?.maxWindowsPerTask ?? 2)) {
        task.status = 'failed'; task.errorCode = 'TASK_TOO_LARGE_NEEDS_SPLIT'; task.error = '任务过大，需要拆分';
        for (const ticket of this.pending(chat, task)) ticket.status = 'cancelled';
      }
      if (active.reason !== 'wait' && !terminalTask(task.status)) {
        const data = { checkpointId: task.checkpointId, nextSegment: task.segment + 1, reason, handoffRef: handoff.ref };
        const input = this.eventInput('context_rotated', data, task, invocation);
        if (!this.mirrorPipelineHandoff(chat, task, handoff.text, input)) this.commitEventInput(chat, input);
      } else this.mirrorPipelineHandoff(chat, task, handoff.text);
    }
    if (terminalTask(task.status) && this.pendingExec(chat, task.id)) {
      await Promise.all(this.stopExecJobs(chat, new Set([task.id])));
    }
    this.active.delete(invocation.id); this.update(chat, task); this.wakeParents(chat); this.advancePipelineGate(chat); this.store.save(chat); this.schedule();
    if (chat.blockedReason) this.emit(chat, 'state', { blockedReason: chat.blockedReason }, task, invocation);
  }
  private complete(chat: ChatRecord, task: AgentTask, result: string) {
    this.observePipelinePlan(chat, task);
    const issues = [...sourceCoverageIssues(chat, task, this.store), ...planCompletionIssues(chat, task), ...(this.options.workspace?.completionIssues?.(chat, task) ?? []), ...this.executionIssues(chat, task), ...this.projectOutputIssues(chat, task), ...clusterReadIssues(chat, task, task.clusterId ? this.resultReadBaseline(chat, task).authority : ''), ...this.implementationCompletionIssues(chat, task)];
    if (this.pendingExec(chat, task.id)) issues.push('请先查询或停止尚未收口的后台作业');
    if (issues.length) {
      task.noProgressSegments++; task.status = task.noProgressSegments >= CHAT_LIMITS.noProgress ? 'failed' : 'queued'; task.error = issues.join('；');
      const invocation = chat.invocations.find(i => i.id === task.invocationIds.at(-1)); if (invocation) checkpoint(chat, task, invocation, '补齐程序验收条件后再提交完成', issues.join('；'));
      return;
    }
    if (!result.trim()) { task.status = 'failed'; task.error = '模型退出但没有提交结果'; return; }
    const blob = this.store.putBlob(chat.id, `result-${task.id}-${task.segment}.txt`, result);
    task.result = result.slice(0, CHAT_LIMITS.collectItemText); task.resultRef = blob.relativePath; task.resultHash = blob.hash; task.status = 'completed';
    if (!task.parentTaskId) { const message = this.store.appendMessage(chat, { role: 'assistant', text: result, turnId: task.turnId, taskId: task.id }); const invocation = chat.invocations.find(i => i.id === task.invocationIds.at(-1)); this.emit(chat, 'message', message, task, invocation); }
  }
  private failTask(chat: ChatRecord, task: AgentTask, outcome: FailedOutcome) {
    task.error = outcome.reason; task.status = 'failed';
    if (outcome.result) { const blob = this.store.putBlob(chat.id, `failure-${task.id}-${task.segment}.txt`, outcome.result); task.result = outcome.result.slice(0, CHAT_LIMITS.collectItemText); task.resultRef = blob.relativePath; task.resultHash = blob.hash; }
  }
  private publishArtifact(chat: ChatRecord, task: AgentTask, invocation: Invocation, input: { name: string; text: string; kind: 'file' | 'diff' | 'test' | 'report'; binding?: ProgramDiffArtifact['binding'] }, provenance: 'model' | 'workspace' | 'runner') {
    const artifact = this.files.publishTextArtifact(chat, task.id, invocation.id, input, provenance);
    latchExecutionReview(chat, task); this.emit(chat, 'artifact', artifact, task, invocation); return artifact;
  }
  private observePipelinePlan(chat: ChatRecord, task: AgentTask) {
    const pipeline = chat.pipeline;
    if (pipeline?.stage !== 'architecture' || pipeline.architectureTaskId !== task.id) return;
    const observed = observeArchitecturePlan(chat, task, pipeline, this.store, this.resultReadBaseline(chat, task).authority,
      (author, job) => this.options.workspace?.matchesCurrentSource?.(author, job) === true);
    if (observed) this.emit(chat, 'plan_updated', observed, task);
  }
  private architectureSourceIssues(chat: ChatRecord, task: AgentTask): string[] {
    const state = chat.pipeline;
    if (!state || state.architectureTaskId !== task.id || !state.contract || task.executionPolicyVersion !== 1) return [];
    return architectureDemoEvidence(chat, task, state, this.store,
      (author, job) => this.options.workspace?.matchesCurrentSource?.(author, job) === true)
      ? [] : ['最新项目源码不再匹配 Demo 已通过的命令回执'];
  }
  private requestDemoRepair(active: Active): ToolReply {
    const { chat, task } = active;
    if (active.pendingTools?.size) throw new HttpError(409, '仍有工具正在执行，请收口后再申请 Demo 返工');
    const repair = this.planDemoRepair(chat, task);
    active.failedOutcome = { reason: demoReviewFailure, demoRepair: repair };
    const data: DemoRepairReceipt = { accepted: true, action: 'demo_repair', revision: repair.fromRevision + 1,
      reportRef: repair.reportRef, finalization: 'awaiting_confirmed_process_exit' };
    return { text: JSON.stringify(data), data, stop: 'completed' };
  }
  private planDemoRepair(chat: ChatRecord, task: AgentTask): DemoRepairPlan {
    const state = chat.pipeline!;
    const frozen = state.contract;
    const attempt = task.executionReviewAttempts?.at(-1);
    const reviewer = chat.tasks.find(candidate => candidate.id === attempt?.taskId);
    const review = attempt?.review;
    const demoStep = architectureStepId(state.revision, 'demo');
    const rejected = review?.stepVerdicts.filter(step => step.outcome !== 'passed');
    if (state.stage !== 'architecture' || task.id !== state.architectureTaskId || frozen?.revision !== state.revision ||
      !reviewer || reviewer.parentTaskId !== task.id || reviewer.executionReviewOfTaskId !== task.id ||
      reviewer.role !== 'astra' || reviewer.mode !== 'verify' || !this.safeCompleted(chat, reviewer) ||
      review?.outcome !== 'failed' || rejected?.length !== 1 || rejected[0]!.stepId !== demoStep || rejected[0]!.outcome !== 'failed' ||
      this.pendingExec(chat, task.id) ||
      this.descendants(chat, task).some(child => !terminalTask(child.status) || child.status === 'interrupted' || this.pendingExec(chat, child.id))) {
      throw new HttpError(409, 'Demo 已随架构契约冻结，当前修订没有可接续返工的独立 Demo 失败评审');
    }
    const view = materializeExecutionView(chat, task, this.store);
    if (view.contractHash !== attempt!.contractHash || view.evidenceHash !== attempt!.evidenceHash || view.viewHash !== attempt!.viewHash) {
      throw new HttpError(409, '架构评审证据已变化，无法以旧评审启动 Demo 返工');
    }
    const report = chat.artifacts.find(item => item.id === review.reportArtifactId && item.taskId === reviewer.id && item.hash === review.reportHash);
    if (!report || createHash('sha256').update(this.store.readBlob(chat.id, report.relativePath)).digest('hex') !== report.hash) {
      throw new HttpError(409, '无法校验触发 Demo 返工的评审报告');
    }
    const guide = architectureArtifact(chat, task, state, 'DEV_GUIDE.md', 'astra');
    if (!guide) throw new HttpError(409, '无法定位当前修订的开发指南');
    const contract = readFrozenPipelineContract(this.store, chat.id, frozen);
    const materials = [report.relativePath, frozen.ref, ...contract.artifacts.map(item => item.ref), guide.relativePath];
    const goal = '接续同一架构方案，只修复独立评审未通过的 Demo。用 result_read 完整读取以下旧修订材料：' +
      materials.join('、') + '。重发继承的 PRD 和架构，由 Astra 重发开发指南；先完整读取已携带的集群汇总。' +
      '委派 Sol 按失败报告修复并用隔离沙箱复测，核对新 Demo 报告和真实回执。沿用旧合约的需求、验收、假设和来源引用，' +
      '重新冻结新修订的合约，再委派全新 Astra 独立评审后提交完成。旧修订的结论和回执只作历史材料。';
    return { fromRevision: state.revision, goal, reportRef: report.relativePath };
  }
  private startDemoRepair(chat: ChatRecord, previous: AgentTask, repair: DemoRepairPlan) {
    const state = chat.pipeline!;
    if (state.stage !== 'architecture' || state.architectureTaskId !== previous.id ||
      state.revision !== repair.fromRevision || state.contract?.revision !== repair.fromRevision) {
      throw new HttpError(409, 'Demo 返工指向的架构修订已变化');
    }
    const root = this.newTask(chat, this.rootRole(chat), repair.goal, randomUUID());
    const now = time();
    beginArchitectureRevision(state, now);
    state.demoRepairFrom = repair.fromRevision;
    this.queueArchitectureTurn(chat, root, now, previous);
  }
  private wakeParents(chat: ChatRecord) {
    if (chat.apiRoster) {
      for (const cluster of chat.pipeline?.clusters ?? []) this.advanceCluster(chat, cluster);
      this.advanceImplementation(chat);
      const tickets = chat.tickets.filter(ticket => ticket.type === 'children' && ticket.status === 'pending');
      if (!tickets.length) return;
      const tasks = new Map(chat.tasks.map(task => [task.id, task]));
      let invocations: Map<string, Invocation> | undefined;
      for (const ticket of tickets) {
        if (ticket.clusterId) {
          const state = chat.pipeline?.clusters.find(cluster => cluster.id === ticket.clusterId);
          if (state?.status === 'completed' || state?.status === 'failed') this.resolveTicket(chat, ticket);
          continue;
        }
        const children = ticket.groupId ? chat.tasks.filter(task => task.groupId === ticket.groupId && task.parentTaskId === ticket.taskId)
          : ticket.childIds?.map(id => tasks.get(id)) ?? [];
        if (!children.length || children.some(child => !child || !terminalTask(child.status) ||
          (child.status === 'interrupted' && !child.interruptionSafe))) continue;
        invocations ??= new Map(chat.invocations.map(invocation => [invocation.id, invocation]));
        if (children.every(child => !chat.unsafeProcesses?.some(process => process.taskId === child!.id) &&
          child!.invocationIds.every(id => invocations!.get(id)?.exitConfirmed === true && !this.active.has(id)))) {
          this.resolveTicket(chat, ticket);
        }
      }
      return;
    }
    for (const ticket of chat.tickets.filter(t => t.type === 'children' && t.status === 'pending')) {
      if (ticket.childIds?.every(id => { const child = chat.tasks.find(t => t.id === id); return child && terminalTask(child.status) && child.status !== 'interrupted'
        && !chat.unsafeProcesses?.some(process => process.taskId === child.id)
        && child.invocationIds.every(invocationId => { const invocation = chat.invocations.find(item => item.id === invocationId); return invocation?.status === 'exited' && invocation.exitConfirmed === true && !this.active.has(invocationId); }); })) this.resolveTicket(chat, ticket);
    }
  }
  private advanceCluster(chat: ChatRecord, prior: ClusterState): ClusterState {
    const pipeline = chat.pipeline!;
    if (prior.status === 'failed' || prior.summaryRef) return prior;
    const parent = chat.tasks.find(task => task.id === prior.rootTaskId);
    if (!parent) return prior;
    let state = prior;
    for (const item of prior.waves.flatMap(wave => wave.tasks)) {
      const task = chat.tasks.find(task => task.id === item.taskId);
      if (!task || task.status === item.status || terminalTask(item.status)) continue;
      if (task.status === 'completed' && task.resultRef && task.resultHash) {
        state = updateClusterTask(state, task.id, { status: task.status, result: { ref: task.resultRef, hash: task.resultHash } });
      } else state = updateClusterTask(state, task.id, { status: task.status === 'completed' ? 'failed' : task.status });
    }
    const wave = state.status === 'failed' || chat.blockedReason || terminalTask(parent.status) ? null : nextClusterWave(state);
    if (wave) {
      const next = wave.tasks.map(item => {
        const goal = `${item.instruction}\n\n主导席架构初稿（待核对材料）\n${state.draft}`;
        const child = this.newTask(chat, item.role, goal, parent.turnId, parent, 'read', 'cluster');
        child.clusterId = state.id;
        child.groupId = state.groupId;
        const wanted = new Set(item.reads.map(ref => ref.ref));
        child.clusterReadTaskIds = state.waves.flatMap(value => value.tasks)
          .filter(previous => previous.result && wanted.has(previous.result.ref)).map(previous => previous.taskId);
        return { slot: item.slot, taskId: child.id };
      });
      state = registerClusterWave(state, wave, next);
    }
    if (state.status === 'completed' && !state.summaryRef) {
      const aggregate = buildClusterAggregate(state);
      const parts = aggregate.entries.map(entry => {
        const bytes = this.store.readBlob(chat.id, entry.ref);
        if (createHash('sha256').update(bytes).digest('hex') !== entry.hash) throw new Error('集群备忘录内容与登记哈希不一致');
        return `\n${JSON.stringify(entry)}\n${bytes.toString('utf8')}\n`;
      });
      const simulated = this.driverFor(chat, parent.role, parent.phase)?.capability.version === 'simulated';
      const summary = [`${simulated ? '模拟数据：' : ''}集群汇总。各段为待核对的模型材料。`, ...parts].join('\n');
      const blob = immutableBlob(this.store, chat.id, `cluster-${state.id}.txt`, summary);
      state = { ...state, summaryRef: blob.relativePath, summaryHash: blob.hash };
      (chat.toolResults ??= []).push({ taskId: parent.id, invocationId: parent.invocationIds.at(-1) ?? '', name: 'cluster_result',
        provenance: 'tool', ref: blob.relativePath, hash: blob.hash, bytes: blob.bytes });
    }
    if (state !== prior) {
      pipeline.clusters[pipeline.clusters.findIndex(cluster => cluster.id === state.id)] = state;
      this.emit(chat, 'cluster_updated', { id: state.id, groupId: state.groupId, mode: state.mode, status: state.status, summaryRef: state.summaryRef }, parent);
      if (wave) this.schedule();
    }
    return state;
  }
  private tools(chat: ChatRecord, task: AgentTask) {
    const seat = taskSeat(chat, task);
    if (!seat) throw new Error('聊天任务的席位未注册');
    const roster = chat.apiRoster?.roster;
    const cliRoster = chat.cliRoster;
    const api = Boolean(roster);
    const activeRoster = roster ?? cliRoster;
    const can = seat.can;
    const worker = seat.kind === 'worker';
    const work = task.pipelineWork?.kind;
    const rawDelegates = activeRoster ? allowedDelegateSeats(activeRoster, seat) : [];
    const phases = this.delegatedPhases(task).filter(phase => chat.pipeline?.stage !== 'architecture' || phase !== 'cluster');
    let rootAvailCache: boolean | undefined;
    const isRootAvailable = () => (rootAvailCache ??= Boolean(this.driverFor(chat, this.rootRole(chat), api ? 'architecture' : undefined)?.capability.available));
    const seatAvailable = (role: string) => api
      ? phases.some(phase => Boolean(this.driverFor(chat, role, phase)?.capability.available))
      : Boolean(this.driverFor(chat, role)?.capability.available);
    const delegates = rawDelegates.length && !chat.team && !chat.pipeline && isRootAvailable()
      ? rawDelegates.filter(seatAvailable)
      : rawDelegates;
    const customReviewDesc = '仅指定的独立验收席位提交当前契约的逐步骤评审。先完整读取execution_read的viewRef与证据，发布自己kind:report的真实报告。outcome为passed/failed/insufficient，stepVerdicts精确覆盖全部工作步骤；评审在工作计划之外。';
    const taskTools = definitions.flatMap(tool => {
      if (!api) {
        if (worker && ['agent_submit', 'grok_submit', 'grok_collect', 'grok_disposition'].includes(tool.name)) return [];
        if (cliRoster) {
          if (tool.name === 'agent_submit') {
            return delegates.length && seat.binding.delegation !== 'none' ? [{
              name: tool.name,
              description: '委派当前团队允许的协作者，说明目标、范围、权限模式和验收证据。',
              inputSchema: objectSchema({ role: { type: 'string', enum: delegates }, goal: str,
                mode: { type: 'string', enum: ['read', 'edit', 'verify'] },
                profileId: { type: 'string', enum: Object.keys(professionalProfiles) },
                purpose: { type: 'string', enum: ['execution_review'] } }, ['role', 'goal']),
            }] : [];
          }
          if (tool.name === 'grok_submit') {
            return delegates.includes('grok') && seat.binding.delegation !== 'none' ? [tool] : [];
          }
          if ((tool.name === 'grok_collect' || tool.name === 'grok_disposition') && seat.binding.delegation === 'none' && !delegates.length) {
            return [];
          }
          if (chat.team && tool.name === 'execution_submit_review') return [{ ...tool, description: customReviewDesc }];
        }
        return [tool];
      }
      if (tool.name === 'grok_submit') return [];
      if (tool.name === 'agent_submit') return delegates.length && phases.length && (!work || work === 'implementation-lead') ? [{
        name: tool.name,
        description: '委派名册允许的席位，说明目标、范围、权限模式和验收证据。根任务可指定 purpose 为 execution_review 委派独立验收。',
        inputSchema: objectSchema({ role: { type: 'string', enum: delegates }, goal: str,
          mode: { type: 'string', enum: ['read', 'edit', 'verify'] }, phase: { type: 'string', enum: phases },
          profileId: { type: 'string', enum: Object.keys(professionalProfiles) },
          purpose: { type: 'string', enum: ['execution_review'] } }, ['role', 'goal']),
      }] : [];
      if (tool.name === 'grok_collect') return worker ? [] : [{ ...tool, name: 'task_collect', description: '收集直属子任务或扇出组的分页索引、统计和结果引用。wait=true 时释放当前窗口。',
        inputSchema: objectSchema({ taskIds: { type: 'array', items: str }, groupId: str, offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 100 }, wait: { type: 'boolean' } }, []) }];
      if (tool.name === 'grok_disposition') return worker ? [] : [{ ...tool, name: 'task_disposition',
        inputSchema: objectSchema({ taskId: str, taskIds: { type: 'array', items: str }, groupId: str,
          disposition: { type: 'string', enum: ['adopted','reference','rejected'] } }, ['disposition']) }];
      if (tool.name === 'task_complete' && this.pool(chat, task)) return [{
        ...tool, description: '提交本 worker 的结构化报告。证据必须引用程序持有的真实记录。',
        inputSchema: objectSchema({ report: workerReportInput }, ['report']),
      }];
      if (tool.name === 'task_yield') return [{ ...tool, inputSchema: objectSchema({ next: str, note: str,
        done: { type: 'array', items: str }, unverified: { type: 'array', items: str }, risks: { type: 'array', items: str },
      }, ['next']) }];
      if (tool.name === 'artifact_publish' && (seat.kind === 'ideator' || worker)) return [];
      if (chat.team && tool.name === 'execution_submit_review') return [{ ...tool, description: customReviewDesc }];
      return [tool];
    });
    if (api) taskTools.push({ name: 'notes_write', description: '整份更新当前任务的模型笔记。每次写入保留版本，笔记不会修改程序事实。',
      inputSchema: objectSchema({ text: { type: 'string', maxLength: 8000 } }, ['text']) });
    if (chat.pipeline?.stage === 'architecture' && chat.pipeline.architectureTaskId === task.id) {
      const modes = this.clusterModes(chat, seat);
      if (modes.length) taskTools.push({ name: 'cluster_submit', description: '对同一份架构初稿发起集群。full 先由 Carbon 给出思路，Astra 和 Opus 再并行互参。',
        inputSchema: objectSchema({ mode: { type: 'string', enum: modes }, draft: str, crossRounds: { type: 'integer', minimum: 1, maximum: 2 } }, ['mode', 'draft']) });
      taskTools.push({ name: 'contract_submit', description: '将 PRD 中的需求、来源与验收编号冻结为 CONTRACT.json。', inputSchema: contractInput });
    }
    if (work === 'implementation-sol') taskTools.push(
      { name: 'impl_plan_submit', description: '提交覆盖冻结验收项的结构化里程碑计划，等待 Opus 互签。', inputSchema: implementationPlanInput },
      { name: 'milestone_verify', description: '在当前主工作区的冻结副本上执行已经互签的检查。', inputSchema: objectSchema({ milestoneId: str }, ['milestoneId']) },
    );
    if (work === 'milestone-author') taskTools.push({ name: 'impl_plan_submit',
      description: '在首次源码变更前提交本里程碑检查的细化，等对方互签后生效。', inputSchema: refinementInput });
    if (work === 'plan-review' || work === 'milestone-review') taskTools.push({ name: 'review_submit',
      description: '对当前冻结哈希登记独立评审和编号缺陷。', inputSchema: pipelineReviewInput });
    if (api && !worker && seat.binding.delegation !== 'none') {
      const allPools = this.availablePools(chat, task);
      let pools = allPools;
      if (allPools.length && !chat.team && !chat.pipeline && isRootAvailable()) {
        const poolProvider = this.options.api?.registry.get(seat.binding.model)?.provider;
        const poolPhase = task.phase ?? 'architecture';
        pools = allPools.filter(poolId => Boolean(this.driverFor(chat, poolId, poolPhase, poolProvider)?.capability.available));
      }
      if (pools.length) {
        const mode = { type: 'string', enum: ['read', 'edit', 'verify'] };
        const pool = { type: 'string', enum: pools };
        taskTools.push(
          { name: 'worker_submit', description: '派发按目标定义的有界 worker 子任务。',
            inputSchema: objectSchema({ pool, tasks: { type: 'array', items: objectSchema({ goal: str, mode }, ['goal']) } }, ['pool', 'tasks']) },
          { name: 'fanout_submit', description: '对同构条目使用 {{item}} 和 {{index}} 模板，返回扇出组引用。可选 reduce 指定归并指令。',
            inputSchema: objectSchema({ pool, mode, template: str, items: { type: 'array', items: {} }, reduce: str }, ['pool', 'template', 'items']) },
        );
      }
    }
    const workspaceTools = (this.options.workspace?.definitions ?? []).filter(tool => {
      if (!task.workspaceId) return false;
      if (!api) {
        if (cliRoster) {
          if (tool.name === 'file_write') return task.mode === 'edit' && (can.writeMain || can.writeIsolated);
          if (tool.name === 'integrate_edit') return task.mode === 'edit' && can.integrate;
          if (tool.name === 'test_submit') return can.exec && task.mode !== 'read';
          return true;
        }
        return !['file_write', 'integrate_edit'].includes(tool.name) || can.writeMain || (can.writeIsolated && task.mode === 'edit');
      }
      if (tool.name === 'test_submit') return !this.options.executor && can.exec && task.mode !== 'read' && Boolean(this.options.workspace?.commandInfo?.().length);
      if (tool.name === 'file_write') return task.mode === 'edit' && (can.writeMain || can.writeIsolated);
      if (tool.name === 'integrate_edit') return task.mode === 'edit' && can.integrate;
      return true;
    });
    const tools = [...taskTools, ...workspaceTools,
      ...(api && can.exec && task.mode !== 'read' && task.workspaceId && this.options.workspace?.prepareExec && this.options.executor ? execDefinitions : []),
      ...(this.options.capabilities?.definitions(task) ?? []).filter(t => profileAllows(task, t.name))]
      .filter(t => t.name !== 'ask_user' || (can.askUser && task.role === this.rootRole(chat) && !task.parentTaskId && chat.pipeline?.gates.clarify !== 'auto'))
      .filter(t => t.name !== 'execution_read' || task.executionPolicyVersion === 1 || !!task.executionReviewOfTaskId)
      .filter(t => t.name !== 'execution_submit_review' || (can.acceptance && task.mode === 'verify' && !!task.executionReviewOfTaskId))
      .filter(t => work !== 'implementation-sol' || !['file_write', 'exec', 'job_start', 'job_output', 'job_stop'].includes(t.name))
      .filter(t => t.name !== 'plan_update' || !work)
      .filter(t => t.name !== 'plan_update' || (!isExecutionReviewTask(chat, task) && chat.pipeline?.architectureTaskId !== task.id))
      .map(tool => tool.name === 'exec' && work === 'product-review' ? { ...tool,
        description: `${tool.description} 界面验收传 acceptanceId，使用断网浏览器镜像。`,
        inputSchema: { ...tool.inputSchema, properties: { ...(tool.inputSchema.properties as object), acceptanceId: { type: 'string' } } },
      } : tool);
    if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error('工具名称重复，不能覆盖宿主工具');
    return tools;
  }
  private executionIssues(chat: ChatRecord, task: AgentTask): string[] {
    latchExecutionReview(chat, task);
    return [...executionCompletionIssues(chat, task, this.store, this.files, candidate => this.resultReadBaseline(chat, candidate).authority),
      ...this.architectureSourceIssues(chat, task)];
  }
  private projectOutputIssues(chat: ChatRecord, task: AgentTask): string[] {
    if (!this.options.projectOutputs || task.parentTaskId) return [];
    const acceptedReportId = task.executionReviewAttempts?.at(-1)?.review?.reportArtifactId;
    const outputs = [...chat.artifacts, ...(chat.attachments ?? []).filter(file => file.source === 'generated')]
      .filter(item => {
        const owner = chat.tasks.find(candidate => candidate.id === item.taskId);
        return owner?.turnId === task.turnId && (!isExecutionReviewTask(chat, owner) || item.id === acceptedReportId);
      });
    return this.projectOutputItemIssues(chat, outputs);
  }
  private projectOutputItemIssues(chat: ChatRecord, outputs: { id: string; taskId?: string; hash: string; projectExport?: ProjectExport }[]): string[] {
    if (!this.options.projectOutputs) return [];
    const issues: string[] = []; const checked = new Set<string>();
    for (const item of outputs) {
      const owner = chat.tasks.find(candidate => candidate.id === item.taskId);
      if (!owner?.workspaceId) continue;
      const output = item.projectExport;
      if (!output || output.status !== 'saved') { issues.push(`生成文件未成功保存到所选项目：${item.id}`); continue; }
      if (output.workspaceId !== owner.workspaceId || output.version !== owner.workspaceVersion) { issues.push(`项目输出目标与当前任务授权不一致：${item.id}`); continue; }
      const identity = `${output.path}\u0000${item.hash}`;
      if (checked.has(identity)) continue;
      try { this.options.projectOutputs.verify(output, item.hash); checked.add(identity); }
      catch { issues.push(`项目输出实际文件或授权校验失败：${item.id}`); }
    }
    return issues.slice(0, 8);
  }
  private executionFeedback(code: string, issues: string[], next = 'execution_read'): ToolReply {
    const data = { accepted: false, code, issues: issues.slice(0, 8).map(issue => issue.slice(0, 320)), next };
    return { text: JSON.stringify(data), data };
  }
  callTool(chatId: string, invocationId: string, name: string, args: unknown): Promise<ToolReply> {
    const active = this.active.get(invocationId);
    const promise = this.performTool(chatId, invocationId, name, args);
    if (active) { const pending = active.pendingTools ??= new Set(); pending.add(promise); void promise.then(() => pending.delete(promise), () => pending.delete(promise)); }
    return promise;
  }
  private async performTool(chatId: string, invocationId: string, name: string, args: unknown): Promise<ToolReply> {
    const active = this.active.get(invocationId);
    if (!active || active.chat.id !== chatId || active.reason || active.complete || active.failedOutcome || active.controller.signal.aborted || terminalTask(active.task.status)) throw new HttpError(409, '该调用段已结束或等待中');
    if (!this.tools(active.chat, active.task).some(t => t.name === name)) throw new HttpError(403, '此角色没有该工具权限');
    const { chat, task, invocation } = active;
    if (chat.blockedReason || this.stopping) throw new HttpError(409, '工作台已停止派发');
    if (task.workspaceId) this.options.workspace!.assertWorkspace(task.workspaceId, task.workspaceVersion);
    const policy = this.apiPolicy(chat, task);
    const actionLimit = policy ? policy.maxToolActions : CHAT_LIMITS.toolActions;
    if (actionLimit !== null && invocation.toolCount >= actionLimit) {
      if (policy) invocation.rotationReason = 'actions';
      this.release(active, 'rotate');
      return { text: `本段工具动作已达${actionLimit}次，请在新上下文继续`, stop: 'rotate' };
    }
    const toolNumber = ++invocation.toolCount;
    const toolCallId = `${invocation.id}:${toolNumber}`;
    const failureKey = toolFailureKey(name, args);
    const retryingFailureIds = new Set(active.toolFailures?.get(failureKey)?.toolCallIds ?? []);
    this.emit(chat, 'tool_started', { name, toolCallId }, task, invocation);
    try {
      let reply: RuntimeToolReply = await this.dispatch(active, name, args, toolCallId);
      if (active.controller.signal.aborted || active.reason === 'cancel' || terminalTask(task.status)) throw new HttpError(409, '调用已取消，迟到工具结果不会继续执行');
      if (task.workspaceId) this.options.workspace!.assertWorkspace(task.workspaceId, task.workspaceVersion);
      if (task.executionReviewOfTaskId && ['document_read', 'image_read', 'session_file_read'].includes(name)) {
        const input = z.object({ fileId: z.string(), offset: z.number().int().min(0).optional() }).passthrough().parse(args);
        const file = this.files.read(chat, input.fileId);
        const data = reply.data && typeof reply.data === 'object' ? reply.data as Record<string, unknown> : {};
        if (name === 'image_read' && data.sourceHash !== file.metadata.hash) throw new HttpError(502, '图像检查来源哈希缺失或不匹配');
        if (name === 'document_read' && (!Array.isArray(data.inputHashes) || !data.inputHashes.includes(file.metadata.hash))) throw new HttpError(502, '文档检查未绑定实际文件哈希');
        const next = name === 'session_file_read' ? data.next : null;
        if (next !== null && (typeof next !== 'number' || !Number.isSafeInteger(next) || next <= (input.offset ?? 0))) throw new HttpError(502, '文件检查分页状态无效');
        const readFile = { fileId: file.metadata.id, hash: file.metadata.hash, bytes: file.metadata.bytes, mime: file.metadata.mime,
          offset: name === 'session_file_read' ? input.offset ?? 0 : 0, next, ...(name === 'image_read' ? { providerSourceHash: data.sourceHash } : {}) };
        reply.text = JSON.stringify({ readFile, result: reply.text }); reply.data = { ...data, readFile };
      }
      if (reply.files?.length) {
        const batch = this.files.publishArtifacts(chat, task.id, invocation.id, reply.files); const produced = batch.files;
        latchExecutionReview(chat, task);
        for (const file of produced) this.emit(chat, 'attachment', file, task, invocation);
        for (const artifact of batch.artifacts) this.emit(chat, 'artifact', artifact, task, invocation);
        reply.data = { result: reply.data ?? reply.text, files: produced };
        reply.text = JSON.stringify(reply.data); delete reply.files;
      }
      const objectiveReceipt = ['file_read', 'file_search', 'file_list', 'file_write', 'integrate_edit', 'workspace_changes'].includes(name);
      const longReply = reply.text.length > CHAT_LIMITS.toolText;
      let toolBlob: ReturnType<ChatStore['putBlob']> | undefined;
      if (!['task_state', 'task_evidence', 'result_read', 'plan_read', 'plan_update', 'execution_read', 'execution_submit_review'].includes(name) ||
        (policy && longReply && name !== 'result_read')) {
        const blob = toolBlob = this.store.putBlob(chat.id, `tool-${invocation.id}-${toolNumber}.txt`, reply.text);
        (chat.toolResults ??= []).push({ taskId: task.id, invocationId: invocation.id, name, toolNumber, provenance: objectiveReceipt ? 'workspace' : 'tool', ref: blob.relativePath, hash: blob.hash, bytes: blob.bytes });
        if (longReply) { reply.text = `${reply.text.slice(0, 3600)}\n完整结果引用：${blob.relativePath}`; reply.data = { ref: blob.relativePath }; }
      }
      if (['file_read', 'file_search', 'file_list', 'file_write', 'integrate_edit', 'workspace_changes'].includes(name)) this.evidence(task, { name, data: reply.data ?? reply.text });
      const candidate = reply[resultReadCandidate]; delete reply[resultReadCandidate]; let registered: ResultReadPage | undefined; let registeredDigest: string | undefined;
      let readPage: Record<string, unknown> | undefined;
      let bindRunnerEvidence: ((page: ResultReadPage) => void) | undefined;
      if (candidate) {
        const reads = task.evidenceReadCoverage ??= []; const pages = task.resultReadPages ??= [];
        if (candidate.runnerEvidenceCandidate) {
          const metadata = candidate.runnerEvidenceCandidate;
          bindRunnerEvidence = page => {
            const chain = [...pages.filter(item => item.ref === page.ref && item.hash === page.hash && item.baselineAuthority === page.baselineAuthority && item.offset !== page.offset), page].sort((left, right) => left.offset - right.offset);
            if (chain[0]?.offset === 0 && chain.at(-1)?.next === null && chain.every((item, index) => index === chain.length - 1 || item.next === chain[index + 1]!.offset)) {
              page.runnerEvidence = { ...metadata, bodyFirstInvocationId: chain[0].firstInvocationId, bodyFirstToolCallId: chain[0].firstToolCallId };
            }
          };
          if (!policy) bindRunnerEvidence(candidate);
          delete candidate.runnerEvidenceCandidate;
        }
        const currentIndex = reads.indexOf(candidate.digest); const legacyIndex = reads.indexOf(candidate.legacyDigest);
        const supplied = pages.find(page => page.ref === candidate.ref && page.hash === candidate.hash && page.offset === candidate.offset && page.baselineAuthority === candidate.baselineAuthority);
        if (currentIndex >= 0 || legacyIndex >= 0) {
          const legacy = !supplied; const known = supplied ?? { ...candidate, coverageIndex: currentIndex >= 0 ? currentIndex : legacyIndex, firstInvocationId: '', firstToolCallId: '' };
          const data = { alreadyProvided: true, originalContentIncluded: false, ref: candidate.ref, hash: candidate.hash, offset: candidate.offset, next: candidate.next, workspaceId: candidate.workspaceId, workspaceVersion: candidate.workspaceVersion, sourceRevision: candidate.sourceRevision, baselineAuthority: candidate.baselineAuthority, coverageIndex: known.coverageIndex, firstInvocationId: legacy ? null : known.firstInvocationId, firstToolCallId: legacy ? null : known.firstToolCallId, ...(known.runnerEvidence ? { runnerEvidence: known.runnerEvidence } : {}), legacy };
          reply = { text: JSON.stringify({ code: 'RESULT_READ_PAGE_ALREADY_PROVIDED', message: '该页已由当前任务在同一权威基线提供；本次不再次返回原文，也不表示模型已理解或工作已验收。', ...data }), data };
          readPage = data;
        } else {
          registered = { ...candidate, coverageIndex: reads.length }; registeredDigest = candidate.digest; readPage = { alreadyProvided: false, originalContentIncluded: true, ref: candidate.ref, hash: candidate.hash, offset: candidate.offset, next: candidate.next, workspaceId: candidate.workspaceId, workspaceVersion: candidate.workspaceVersion, sourceRevision: candidate.sourceRevision, baselineAuthority: candidate.baselineAuthority, coverageIndex: registered.coverageIndex, firstInvocationId: candidate.firstInvocationId, firstToolCallId: candidate.firstToolCallId, ...(candidate.runnerEvidence ? { runnerEvidence: candidate.runnerEvidence } : {}), legacy: false };
        }
      }
      let delivery: ToolReceiptDelivery | undefined;
      if (policy) {
        if (actionLimit !== null && invocation.toolCount >= actionLimit && !active.reason && !active.complete) {
          checkpoint(chat, task, invocation, `${actionLimit}次工具动作后继续`);
          active.explicitCheckpoint = true;
          invocation.rotationReason = 'actions'; this.release(active, 'rotate'); reply.stop = 'rotate';
        }
        const blob = toolBlob ?? this.store.putBlob(chat.id, `api-receipt-${invocation.id}-${toolNumber}.txt`, reply.text);
        delivery = { id: toolCallId, name, ref: blob.relativePath, hash: blob.hash, bytes: blob.bytes, ...(reply.stop ? { terminal: true } : {}) };
        (invocation.toolReceiptDeliveries ??= []).push(delivery);
        reply.receiptId = toolCallId;
      }
      const toolResultData = { name, text: reply.text, toolCallId, ...(delivery ? { receiptDelivery: delivery } : {}) };
      if (candidate) {
        const eventInput = { type: 'tool_result', data: { ...toolResultData, ...(readPage ? { readPage } : {}) }, taskId: task.id, parentTaskId: task.parentTaskId, turnId: task.turnId, invocationId: invocation.id };
        const expectedSeq = chat.seq + 1; let event: ChatEvent;
        try { event = policy ? this.store.commitEvent(chat, eventInput) : this.store.appendEvent(chat, eventInput); }
        catch (error) {
          let persisted: ChatEvent | undefined;
          try { persisted = this.store.events(chat.id, expectedSeq - 1, 1).items.find(item => item.seq === expectedSeq); }
          catch { throw Object.assign(new Error('工具结果事件提交状态未知，已停止继续执行'), { [toolTerminalCommitUnknown]: true }); }
          const data = persisted?.data as Record<string, unknown> | undefined; const persistedPage = data?.readPage as Record<string, unknown> | undefined;
          const expectedPage = readPage as Record<string, unknown> | undefined;
          const exact = persisted?.type === 'tool_result' && persisted.chatId === chat.id && persisted.taskId === task.id && persisted.invocationId === invocation.id
            && data?.name === name && data?.toolCallId === toolCallId && data?.text === reply.text
            && !!persistedPage && !!expectedPage && persistedPage.originalContentIncluded === true
            && persistedPage.ref === expectedPage.ref && persistedPage.hash === expectedPage.hash && persistedPage.offset === expectedPage.offset
            && persistedPage.baselineAuthority === expectedPage.baselineAuthority;
          if (!exact) {
            if (persisted || chat.seq >= expectedSeq) throw Object.assign(new Error('工具结果事件提交状态未知，已停止继续执行'), { [toolTerminalCommitUnknown]: true });
            throw error;
          }
          event = persisted!;
        }
        if (registered && registeredDigest) {
          const page = registered;
          const digest = registeredDigest;
          const acknowledge = () => {
            const reads = task.evidenceReadCoverage ??= [];
            if (reads.includes(digest)) return;
            if (policy) bindRunnerEvidence?.(page);
            page.coverageIndex = reads.length;
            reads.push(digest);
            (task.resultReadPages ??= []).push(page);
          };
          if (policy) (active.receiptAcks ??= new Map()).set(toolCallId, acknowledge);
          else acknowledge();
        }
        // CLI delivery is recorded by tool_result. API coverage commits only after provider acknowledgement.
        if (!policy) { try { this.store.save(chat); } catch { /* CLI recovery reconciles the durable tool_result */ } }
        for (const fn of this.listeners.get(chat.id) ?? []) { try { fn(event); } catch { /* 客户端断开不改变任务结果。 */ } }
      } else this.emit(chat, 'tool_result', toolResultData, task, invocation);
      const failures = active.toolFailures?.get(failureKey);
      if (failures) { for (const id of retryingFailureIds) failures.toolCallIds.delete(id); if (!failures.toolCallIds.size) active.toolFailures!.delete(failureKey); }
      if (!policy && invocation.toolCount >= CHAT_LIMITS.toolActions && !active.reason && !active.complete) { checkpoint(chat, task, invocation, '12次工具动作后继续'); this.release(active, 'rotate'); reply.stop = 'rotate'; }
      return reply;
    } catch (error) {
      if (error && typeof error === 'object' && (error as { [toolTerminalCommitUnknown]?: boolean })[toolTerminalCommitUnknown]) {
        chat.blockedReason = '工具结果事件提交状态未知，已停止派发；核对事件日志后再恢复'; task.status = 'interrupted'; this.release(active, 'cancel'); active.controller.abort(); active.toolController.abort(); throw error;
      }
      // Failed control/state queries remain visible in the trace; they do not invalidate work already produced.
      if (!['task_complete','task_fail','task_state','task_evidence','result_read','plan_update','plan_read','execution_read','execution_submit_review'].includes(name)) {
        const failures = active.toolFailures ??= new Map(); const entry = failures.get(failureKey) ?? { name, toolCallIds: new Set<string>() }; entry.toolCallIds.add(toolCallId); failures.set(failureKey, entry);
      }
      if (error && typeof error === 'object' && (error as { exitConfirmed?: boolean }).exitConfirmed === false) {
        chat.blockedReason = '扩展工具进程退出状态未知，已停止派发；核实残留进程后再恢复';
        (chat.unsafeProcesses ??= []).push({ id: toolCallId, kind: 'capability', taskId: task.id, reason: chat.blockedReason });
        task.status = 'interrupted'; this.release(active, 'cancel'); active.controller.abort(); active.toolController.abort();
        this.emit(chat, 'state', { blockedReason: chat.blockedReason }, task, invocation);
      }
      const planFeedback = safePlanFeedback(error, name);
      this.emit(chat, 'tool_error', { name, error: error instanceof Error ? error.message : String(error), toolCallId,
        ...(planFeedback ? { planError: { code: planFeedback.code, details: planFeedback.details } } : {}) }, task, invocation); throw error;
    }
  }
  private evidenceEntries(chat: ChatRecord, target: AgentTask): Record<string, unknown>[] {
    const entries: Record<string, unknown>[] = [];
    for (const record of chat.toolResults ?? []) {
      if (record.taskId !== target.id) continue;
      const common = { name: record.name, invocationId: record.invocationId, segment: chat.invocations.find(inv => inv.id === record.invocationId)?.segment, toolNumber: record.toolNumber, provenance: record.provenance, ref: record.ref, hash: record.hash, bytes: record.bytes };
      if (record.provenance === 'runner') {
        const ticket = chat.tickets.find(item => item.taskId === target.id && item.type === 'tool' && item.resultRef === record.ref && item.status === 'resolved' && item.processStatus === 'exited');
        if (ticket) entries.push({ kind: 'test', ...common, ticketId: ticket.id, externalId: ticket.externalId, status: ticket.status, processStatus: ticket.processStatus });
      } else entries.push({ kind: 'tool', ...common });
    }
    for (const artifact of chat.artifacts) if (artifact.taskId === target.id && artifact.provenance !== 'runner') entries.push({ kind: 'artifact', artifactKind: artifact.kind, provenance: artifact.provenance ?? 'unknown', name: artifact.name, ref: artifact.relativePath, hash: artifact.hash, bytes: artifact.bytes });
    return entries;
  }
  private async dispatchExec(active: Active, name: string, raw: unknown, prepared?: ExecWorkspace, uiAcceptanceId?: string): Promise<ToolReply> {
    const { chat, task, invocation } = active;
    const json = (data: unknown): ToolReply => ({ text: JSON.stringify(data), data });
    const executor = uiAcceptanceId ? this.options.browserExecutor : this.options.executor;
    const workspace = this.options.workspace;
    if (!executor || !workspace?.prepareExec || !chat.apiRoster || !taskSeat(chat, task)?.can.exec || task.mode === 'read' || !task.workspaceId) {
      throw new HttpError(403, '当前任务不能执行命令');
    }
    const identity = { chat, task, invocation, signal: active.toolController.signal };
    const owner = `${chat.id}:${task.id}`;
    let job: TaskExecJob;
    if (name === 'exec' || name === 'job_start') {
      const spec = executor.parse(raw);
      if (uiAcceptanceId && spec.purpose !== 'test') throw new HttpError(400, '界面验收命令必须使用 test 用途');
      if ((task.pipelineWork?.kind === 'milestone-review' || task.pipelineWork?.kind === 'product-review') && spec.env) {
        throw new HttpError(403, '独立验收命令不得覆盖冻结检查的环境');
      }
      const demo = chat.pipeline && task.phase === 'demo';
      if (demo) {
        if (executor.backend.id === 'local-unsafe') throw new HttpError(409, 'Demo 命令须在隔离沙箱的 demo/ 目录内运行');
        const cwd = posix.normalize(spec.cwd.replaceAll('\\', '/'));
        if (cwd !== 'demo' && !cwd.startsWith('demo/')) return this.executionFeedback(
          'DEMO_CWD_REQUIRED', ['Demo 命令使用 cwd: "demo"，argv 中的项目文件路径相对该目录。'], name);
      }
      const issues = sourceCoverageIssues(chat, task, this.store);
      if (issues.length) throw new HttpError(409, `必保用户原文尚未核对：${issues.join('；')}`);
      const available = await executor.capabilities();
      if (!available.available) throw new HttpError(503, available.reason ?? '执行后端不可用');
      identity.signal.throwIfAborted();
      let execWorkspace: ExecWorkspace;
      try { execWorkspace = prepared ?? workspace.prepareExec(identity); }
      catch (error) {
        if (!demo || !(error instanceof DemoSourceMissingError)) throw error;
        return this.executionFeedback('DEMO_SOURCE_REQUIRED', [error.message + '，请先用 file_write 写入源码。'], 'file_write');
      }
      const { copyDir, ...origin } = execWorkspace;
      if (task.pipelineWork?.kind === 'milestone-author') task.pipelineWork.started = true;
      job = { id: randomUUID(), taskId: task.id, invocationId: invocation.id, backend: executor.backend.id,
        ...origin, state: 'starting', ...(spec.purpose ? { purpose: spec.purpose } : {}),
        ...(uiAcceptanceId ? { uiAcceptanceId } : {}),
        ...(chat.pipeline ? { sourceRevision: chat.sourceRevisions?.[task.turnId] ?? 0,
          command: { argv: spec.argv, cwd: spec.cwd, timeoutMs: spec.timeoutMs } } : {}) };
      (chat.execJobs ??= []).push(job);
      this.emit(chat, 'exec_starting', job, task, invocation);
      job.state = 'running';
      this.emit(chat, 'exec_started', { ...job, unsafe: available.unsafe,
        ...(available.unsafe ? { warning: '本机无沙箱执行，命令可访问宿主文件和网络' } : {}) }, task, invocation);
      try {
        executor.jobs.start(owner, spec, copyDir, identity.signal, job.id);
      } catch (error) {
        job.state = 'finished';
        this.emit(chat, 'exec_finished', job, task, invocation);
        throw error;
      }
      if (name === 'job_start') return json({ jobId: job.id, state: job.state, backend: job.backend, unsafe: available.unsafe });
    } else {
      const input = execJobInput.parse(raw);
      const existing = chat.execJobs?.find(item => item.id === input.jobId && item.taskId === task.id);
      if (!existing) throw new HttpError(404, '后台作业不存在或不属于当前任务');
      job = existing;
      if (job.receiptRef) return json({ ...JSON.parse(readExecReceipt(this.store, chat, job)), receiptRef: job.receiptRef });
    }
    let status: ReturnType<ExecTools['jobs']['status']>;
    try {
      status = name === 'exec' ? await executor.jobs.wait(owner, job.id)
        : name === 'job_stop' ? await executor.jobs.stop(owner, job.id)
          : executor.jobs.status(owner, job.id);
    } catch (error) {
      const exitConfirmed = !!error && typeof error === 'object' && (error as { exitConfirmed?: boolean }).exitConfirmed === true;
      job.state = exitConfirmed ? 'finished' : 'exit_unknown';
      this.emit(chat, 'exec_finished', job, task, invocation);
      throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { exitConfirmed });
    }
    if (!status.result) return json({ jobId: job.id, state: status.status, backend: job.backend,
      stdoutTail: readExecTail(status.directory, 'stdout'), stderrTail: readExecTail(status.directory, 'stderr') });
    const result = status.result;
    const platform = job.backend === 'windows-mxc' || (job.backend === 'local-unsafe' && process.platform === 'win32') ? 'windows' : 'linux';
    job.state = result.exitConfirmed ? 'finished' : 'exit_unknown';
    const promoted = job.purpose !== 'test' && result.exitCode === 0 && result.exitConfirmed &&
      !result.timedOut && !result.cancelled && !result.outputLimited ? workspace.finishExecWrites?.(identity, job) : undefined;
    const text = sealExecRecord(this.store, chat, job, result, status.directory, platform, promoted);
    if (job.purpose === 'test' && result.exitConfirmed && job.backend !== 'local-unsafe') workspace.recordExecEvidence?.(identity, job.id, job, platform, result);
    this.emit(chat, 'exec_finished', { ...job, exitCode: result.exitCode, timedOut: result.timedOut, cancelled: result.cancelled,
      outputLimited: result.outputLimited }, task, invocation);
    return { ...json({ ...JSON.parse(text), receiptRef: job.receiptRef }), processExitConfirmed: result.exitConfirmed };
  }

  private async dispatch(active: Active, name: string, raw: unknown, toolCallId: string): Promise<RuntimeToolReply> {
    const { chat, task, invocation } = active; const json = (data: unknown): ToolReply => ({ text: JSON.stringify(data), data });
    if (name === 'exec' && task.pipelineWork?.kind === 'product-review' && raw && typeof raw === 'object' && 'acceptanceId' in raw) {
      const { acceptanceId, ...spec } = raw;
      if (typeof acceptanceId !== 'string' || !readImplementationContract(this.store, chat).acceptance.some(item => item.id === acceptanceId && item.kind === 'ui')) {
        throw new HttpError(400, '界面验收编号不在当前契约中');
      }
      if (!this.options.browserExecutor) throw new HttpError(503, '请将浏览器镜像固定摘要配置到 exec.browserImage');
      return this.dispatchExec(active, name, spec, undefined, acceptanceId);
    }
    if (execDefinitions.some(tool => tool.name === name)) return this.dispatchExec(active, name, raw);
    const work = task.pipelineWork?.kind;
    if ((work === 'implementation-sol' || work === 'milestone-author') && name === 'impl_plan_submit') return this.submitImplementationPlan(active, raw);
    if (work === 'implementation-sol' && name === 'milestone_verify') return this.verifyPipelineMilestone(active, raw);
    if (work === 'implementation-sol' && name === 'integrate_edit') return this.integratePipelineMilestone(active, raw);
    if ((work === 'plan-review' || work === 'milestone-review') && name === 'review_submit') return this.submitPipelineReview(chat, task, raw);
    if (name === 'cluster_submit' && chat.pipeline?.architectureTaskId === task.id && chat.pipeline.stage === 'architecture') {
      const input = clusterSubmitSchema.parse(raw);
      if (!this.clusterModes(chat, taskSeat(chat, task)!).includes(input.mode)) throw new HttpError(403, '该集群模式包含当前任务无权委派的席位');
      if (raw && typeof raw === 'object' && !('crossRounds' in raw)) input.crossRounds = chat.pipeline.quality.clusterCrossRounds;
      const existing = chat.pipeline.clusters.find(cluster => cluster.rootTaskId === task.id && ['planning', 'running'].includes(cluster.status));
      if (existing) return this.wait(active, { type: 'children', clusterId: existing.id });
      const cluster = createClusterState({ id: randomUUID(), groupId: randomUUID(), rootTaskId: task.id }, input);
      chat.pipeline.clusters.push(cluster);
      const waiting = this.wait(active, { type: 'children', clusterId: cluster.id });
      this.advanceCluster(chat, cluster);
      return waiting;
    }
    if (name === 'contract_submit' && chat.pipeline?.architectureTaskId === task.id && chat.pipeline.stage === 'architecture') {
      const pipeline = chat.pipeline;
      if (pipeline.contract) return json({ ok: true, existing: true, ...pipeline.contract });
      const sourceIssues = sourceCoverageIssues(chat, task, this.store);
      if (sourceIssues.length) throw new HttpError(409, `必保用户原文尚未核对：${sourceIssues.join('；')}`);
      const names = ['PRD.md', 'ARCHITECTURE.md'] as const;
      const artifacts = names.flatMap(name => {
        const artifact = architectureArtifact(chat, task, pipeline, name, 'root');
        if (!artifact) return [];
        const bytes = this.store.readBlob(chat.id, artifact.relativePath);
        if (bytes.length !== artifact.bytes || createHash('sha256').update(bytes).digest('hex') !== artifact.hash) {
          throw new HttpError(409, `${name} 内容与登记哈希不一致`);
        }
        return [{ name, ref: artifact.relativePath, sha256: artifact.hash, text: bytes.toString('utf8') }];
      });
      const validated = validateContractSubmission({
        submission: raw, prdMarkdown: artifacts.find(artifact => artifact.name === 'PRD.md')?.text ?? '',
        artifacts: artifacts.map(({ text: _text, ...artifact }) => artifact),
        sources: sourcePlan(chat, task, this.store).sources.filter(source => source.kind !== 'goal')
          .map(source => ({ id: source.id, sha256: source.hash })),
      });
      if (!validated.ok) return json({ ok: false, issues: validated.issues.slice(0, 16) });
      if (pipeline.demoRepairFrom !== undefined) {
        const prior = pipeline.priorContracts.find(item => item.revision === pipeline.demoRepairFrom);
        if (!prior) throw new HttpError(409, 'Demo 返工缺少上轮冻结契约');
        const baseline = readFrozenPipelineContract(this.store, chat.id, prior);
        if (canonicalContractJson({ ...validated.contract, sources: baseline.sources, artifacts: baseline.artifacts }) !== canonicalContractJson(baseline)) {
          return json({ ok: false, issues: [{ code: 'DEMO_REPAIR_SCOPE', message: 'Demo 返工须沿用上轮冻结契约的 requirements、acceptance 和 assumptions，只更换本轮产物引用。' }] });
        }
      }
      this.observePipelinePlan(chat, task);
      const ready = chat.todos?.some(step => step.id === architectureStepId(pipeline.revision, 'cluster') && step.status === 'completed')
        && architectureArtifact(chat, task, pipeline, 'DEV_GUIDE.md', 'astra') && architectureDemoEvidence(chat, task, pipeline, this.store,
          (author, job) => this.options.workspace?.matchesCurrentSource?.(author, job) === true)
        && this.children(chat, task).every(child => terminalTask(child.status));
      if (!ready) return json({ ok: false, issues: [{ code: 'ARCHITECTURE_NOT_READY', message: '请完成集群综合、Astra 开发指南和 Sol Demo；Demo 报告须引用最新源码的真实通过回执。' }] });
      const output = this.publishArtifact(chat, task, invocation,
        { name: 'CONTRACT.json', text: canonicalContractJson(validated.contract), kind: 'file' }, 'workspace');
      pipeline.contract = { ref: output.relativePath, hash: output.hash, contractSha256: validated.contract.sha256,
        artifactId: output.id, revision: pipeline.revision };
      this.emit(chat, 'contract_frozen', pipeline.contract, task, invocation);
      this.observePipelinePlan(chat, task);
      return json({ ok: true, ...pipeline.contract });
    }
    if (name === 'plan_read') { z.object({}).strict().parse(raw); this.observePipelinePlan(chat, task); return json({ revision: chat.planRevision ?? 0, todos: (chat.todos ?? []).filter(item => item.taskId === task.id) }); }
    if (name === 'plan_update') { const result = updatePlan(chat, task, raw); latchExecutionReview(chat, task); this.emit(chat, 'plan_updated', result, task, invocation); return json(result); }
    if (name === 'execution_read') {
      const input = z.object({ section: z.enum(['overview','steps','evidence']).default('overview'), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(20).default(8) }).strict().parse(raw);
      const root = executionRoot(chat, task); if (!root) throw new HttpError(403, '当前任务没有执行契约读取权限');
      latchExecutionReview(chat, root);
      let view: ReturnType<typeof materializeExecutionView>;
      try { view = materializeExecutionView(chat, root, this.store); }
      catch { return this.executionFeedback('EXECUTION_VIEW_INVALID', ['当前执行契约或已登记证据校验失败；不能把缺失或变化的记录当作完成']); }
      if (!(chat.toolResults ??= []).some(receipt => receipt.taskId === task.id && receipt.name === name && receipt.ref === view.viewRef)) {
        chat.toolResults.push({ taskId: task.id, invocationId: invocation.id, name, toolNumber: Number(toolCallId.split(':').at(-1)), provenance: 'tool', ref: view.viewRef, hash: view.viewHash, bytes: view.viewBytes });
      }
      const steps = (chat.todos ?? []).filter(step => step.taskId === root.id);
      if (input.section !== 'overview') {
        const entries = input.section === 'steps'
          ? steps.map(step => ({ stepId: step.id, text: step.text, status: step.status, verification: step.verification,
            dependencyCount: step.dependsOn.length, childCount: step.linkedTaskIds.length, evidenceRefCount: step.evidenceRefs.length }))
          : view.requiredRefs.map(receipt => {
            const file = receipt.fileId ? chat.attachments?.find(item => item.id === receipt.fileId) : undefined;
            return { ...receipt, ...(file ? { name: file.name, mime: file.mime } : {}),
              parentTaskId: chat.tasks.find(candidate => candidate.id === receipt.taskId)?.parentTaskId ?? null };
          });
        const items = entries.slice(input.offset, input.offset + input.limit);
        const value = () => ({ section: input.section, contractHash: view.contractHash, evidenceHash: view.evidenceHash,
          items, total: entries.length, next: input.offset + items.length < entries.length ? input.offset + items.length : null,
          metadataOnly: true, viewRef: view.viewRef });
        while (items.length > 1 && JSON.stringify(value()).length > 3800) items.pop();
        return json(value());
      }
      const attempt = root.executionReviewAttempts?.at(-1);
      const report = attempt?.review ? chat.artifacts.find(artifact => artifact.id === attempt.review!.reportArtifactId) : undefined;
      const workStepIds = (chat.todos ?? []).filter(step => step.taskId === root.id).map(step => step.id);
      return json({ policyVersion: 1, rootTaskId: root.id, reviewRequired: root.executionReviewRequired === true,
        contractHash: view.contractHash, evidenceHash: view.evidenceHash, viewRef: view.viewRef, viewHash: view.viewHash,
        workStepIds, workStepCount: workStepIds.length,
        attempt: attempt ? { taskId: attempt.taskId, contractHash: attempt.contractHash, evidenceHash: attempt.evidenceHash,
          status: chat.tasks.find(child => child.id === attempt.taskId)?.status, outcome: attempt.review?.outcome,
          ...(report ? { reportArtifactId: report.id, reportRef: report.relativePath, reportHash: report.hash } : {}) } : null,
        next: 'result_read' });
    }
    if (name === 'execution_submit_review') {
      const previous = executionRoot(chat, task)?.executionReviewAttempts?.find(attempt => attempt.taskId === task.id)?.review;
      const reportId = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).reportArtifactId : undefined;
      const report = chat.artifacts.find(artifact => artifact.id === reportId && artifact.taskId === task.id);
      const outputIssues = !previous && report ? this.projectOutputItemIssues(chat, [report]) : [];
      if (outputIssues.length) return this.executionFeedback('PROJECT_OUTPUT_UNVERIFIED', outputIssues);
      const product = task.pipelineWork?.kind === 'product-review' ? this.productChecks(chat, task) : undefined;
      if (product && !previous) {
        const state = chat.pipeline!.implementation!;
        state.acceptance = { taskId: task.id, checks: product.checks, manualIds: product.manualIds };
        const passed = raw && typeof raw === 'object' && (raw as { outcome?: string }).outcome === 'passed';
        if (passed && (product.checks.length !== product.requiredIds.length || product.checks.some(check => !check.ok))) {
          const failedIds = product.requiredIds.filter(id => !product.checks.some(proof => proof.checkId === id && proof.ok));
          return this.executionFeedback('PRODUCT_ACCEPTANCE_FAILED', [`冻结验收未通过或缺少最新回执：${failedIds.join('、')}`]);
        }
      }
      const reply = submitExecutionReview(chat, task, raw, this.store, this.files, candidate => this.resultReadBaseline(chat, candidate).authority);
      if (reply.accepted && !reply.duplicate) {
        try {
          this.store.save(chat);
          const root = executionRoot(chat, task)!; const attempt = root.executionReviewAttempts!.find(candidate => candidate.taskId === task.id)!;
          this.emit(chat, 'execution_review', { accepted: true, toolCallId, rootTaskId: root.id, reviewerTaskId: task.id, contractHash: attempt.contractHash, evidenceHash: attempt.evidenceHash, review: attempt.review }, task, invocation);
        } catch {
          chat.blockedReason = '执行评审提交未完整持久化，已停止派发并等待核对'; task.status = 'interrupted'; this.release(active, 'cancel'); active.controller.abort(); active.toolController.abort();
          throw new HttpError(409, chat.blockedReason);
        }
      }
      return json(reply);
    }
    if (name === 'session_file_list') {
      const { offset } = z.object({ offset: z.number().int().min(0).default(0) }).strict().parse(raw); const files = this.files.list(chat);
      return json({ files: files.slice(offset, offset + 20), next: offset + 20 < files.length ? offset + 20 : null });
    }
    if (name === 'session_file_read') {
      const input = z.object({ fileId: z.string(), offset: z.number().int().min(0).default(0) }).strict().parse(raw);
      const { metadata, bytes } = this.files.read(chat, input.fileId);
      if (!metadata.mime.startsWith('text/')) throw new HttpError(415, '该文件是二进制，请使用document_read或image_read');
      const text = bytes.toString('utf8'); const content = text.slice(input.offset, input.offset + 3500);
      return json({ file: metadata, text: content, next: input.offset + content.length < text.length ? input.offset + content.length : null });
    }
    if (name === 'session_file_write') {
      const input = z.object({ name: z.string().min(1).max(160), text: z.string().max(2_000_000) }).strict().parse(raw);
      const issues = sourceCoverageIssues(chat, task, this.store); if (issues.length) throw new HttpError(409, issues.join('；'));
      return { text: '已提交文件候选，宿主验证后发布。', files: [{ name: input.name, bytes: Buffer.from(input.text) }] };
    }
    if (name === 'task_state') {
      z.object({}).strict().parse(raw);
      const allChildren = this.children(chat, task);
      const childItems = allChildren.slice(0, 16).map(t => ({ id: t.id, role: t.role, mode: t.mode, status: t.status, disposition: t.disposition, resultRef: t.resultRef, error: t.error?.slice(0, 160) }));
      const allTickets = chat.tickets.filter(t => t.taskId === task.id);
      const ticketItems = allTickets.slice(-16).map(t => ({ id: t.id, type: t.type, status: t.status, processStatus: t.processStatus, question: t.status === 'pending' ? t.question?.slice(0, 160) : undefined, childCount: t.childIds?.length,
        resultRef: t.type === 'tool' && t.status === 'resolved' && t.processStatus === 'exited' ? t.resultRef : undefined }));
      const deduplicated = new Map<string, Record<string, unknown>>();
      for (const entry of this.evidenceEntries(chat, task)) if ((entry.kind === 'tool' || entry.kind === 'test') && !['task_state', 'task_evidence', 'result_read'].includes(String(entry.name ?? ''))) {
        const compact = { kind: entry.kind, name: entry.name, invocationId: entry.invocationId, segment: entry.segment, toolNumber: entry.toolNumber, provenance: entry.provenance, ref: entry.ref, hash: entry.hash, bytes: entry.bytes };
        deduplicated.set(`${String(entry.ref)}:${String(entry.hash)}`, compact);
      }
      const allRecent = [...deduplicated.values()]; const recentItems = allRecent.slice(-8);
      const storedCheckpoint = chat.checkpoints.find(c => c.id === task.checkpointId);
      const checkpointView = storedCheckpoint ? { id: storedCheckpoint.id, invocationId: storedCheckpoint.invocationId, createdAt: storedCheckpoint.createdAt,
        next: storedCheckpoint.next.slice(0, 500), nextTruncated: storedCheckpoint.next.length > 500,
        note: storedCheckpoint.note?.slice(0, 500), noteTruncated: (storedCheckpoint.note?.length ?? 0) > 500 } : null;
      const commandItems = (this.options.workspace?.commandInfo?.() ?? []).map(command => ({ ...command, executablePaths: command.executablePaths.slice(0, 4).map(value => value.slice(0, 240)), executablePathCount: command.executablePaths.length, truncated: command.executablePaths.length > 4 || command.executablePaths.some(value => value.length > 240) }));
      const capabilities = this.chatCapabilities(chat.id).map(capability => ({ role: capability.role, available: capability.available, isolationVerified: capability.isolationVerified, version: capability.version, contextWindow: capability.contextWindow,
        reason: capability.reason?.slice(0, 160), reasonTruncated: (capability.reason?.length ?? 0) > 160 }));
      const currentBaseline = this.resultReadBaseline(chat, task); const allProvidedPages = task.resultReadPages ?? []; const providedPageItems = allProvidedPages.slice(-8).map(compactResultPage);
      const allRunnerEvidence = allProvidedPages.filter(page => page.runnerEvidence); const runnerEvidenceItems = allRunnerEvidence.slice(-8).map(page => compactRunnerEvidence(page, currentBaseline.authority));
      const blocked = chat.blockedReason ? { text: chat.blockedReason.slice(0, 320), truncated: chat.blockedReason.length > 320 } : null;
      const value = { task: { id: task.id, role: task.role, mode: task.mode, status: task.status, segment: task.segment, workspaceId: task.workspaceId, workspaceVersion: task.workspaceVersion },
        children: { items: childItems, total: allChildren.length, shown: childItems.length, truncated: childItems.length < allChildren.length },
        tickets: { items: ticketItems, total: allTickets.length, shown: ticketItems.length, truncated: ticketItems.length < allTickets.length },
        checkpoint: checkpointView, blockedReason: blocked, capabilities,
        ...(chat.execJobs ? { execJobs: chat.execJobs.filter(job => job.taskId === task.id).slice(-8).map(job => ({
          jobId: job.id, backend: job.backend, state: job.state, receiptRef: job.receiptRef,
        })) } : {}),
        providedResultPages: { items: providedPageItems, total: allProvidedPages.length, shown: providedPageItems.length, truncated: providedPageItems.length < allProvidedPages.length },
        providedRunnerEvidence: { items: runnerEvidenceItems, total: allRunnerEvidence.length, shown: runnerEvidenceItems.length, truncated: runnerEvidenceItems.length < allRunnerEvidence.length, currentBaselineAuthority: currentBaseline.authority },
        testCommands: { items: commandItems, total: commandItems.length, shown: commandItems.length, truncated: false },
        recentReceipts: { items: recentItems, total: allRecent.length, shown: recentItems.length, truncated: recentItems.length < allRecent.length },
        ...(task.pipelineWork && chat.pipeline?.implementation ? { implementation: {
          planHash: chat.pipeline.implementation.planHash, error: chat.pipeline.implementation.error,
          milestones: chat.pipeline.implementation.milestones.map(item => ({ id: item.id, status: item.status,
            authorTaskId: item.attempts.at(-1)?.authorTaskId, paths: item.attempts.at(-1)?.candidate?.changes })),
          trace: chat.pipeline.implementation.trace,
        } } : {}),
        recovery: [`子任务详情或结果使用 ${chat.apiRoster ? 'task_collect' : 'grok_collect'}；程序证据使用 task_evidence 分页并按 next 继续；完整用户约束仍以固定原文来源为准。`] };
      const refresh = () => {
        value.children.shown = value.children.items.length; value.children.truncated = value.children.shown < value.children.total;
        value.tickets.shown = value.tickets.items.length; value.tickets.truncated = value.tickets.shown < value.tickets.total;
        value.recentReceipts.shown = value.recentReceipts.items.length; value.recentReceipts.truncated = value.recentReceipts.shown < value.recentReceipts.total;
        value.providedResultPages.shown = value.providedResultPages.items.length; value.providedResultPages.truncated = value.providedResultPages.shown < value.providedResultPages.total;
        value.providedRunnerEvidence.shown = value.providedRunnerEvidence.items.length; value.providedRunnerEvidence.truncated = value.providedRunnerEvidence.shown < value.providedRunnerEvidence.total;
        value.testCommands.shown = value.testCommands.items.length; value.testCommands.truncated = value.testCommands.shown < value.testCommands.total;
      };
      while (JSON.stringify(value).length > 3800) {
        if (value.recentReceipts.items.length) value.recentReceipts.items.shift();
        else if (value.providedResultPages.items.length) value.providedResultPages.items.shift();
        else if (value.providedRunnerEvidence.items.length) value.providedRunnerEvidence.items.shift();
        else if (value.tickets.items.length) value.tickets.items.shift();
        else if (value.children.items.length) value.children.items.pop();
        else if (value.testCommands.items.length) value.testCommands.items.pop();
        else throw new Error('task_state 紧凑状态仍超过3800字符');
        refresh();
      }
      return json(value);
    }
    if (name === 'task_evidence') {
      const input = z.object({ taskId: z.string().min(1).max(100).optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(20).default(10) }).strict().parse(raw);
      const target = input.taskId === undefined || input.taskId === task.id ? task : chat.tasks.find(candidate => candidate.id === input.taskId && (candidate.parentTaskId === task.id || reviewerCanReadTask(chat, task, candidate.id)));
      if (!target) throw new HttpError(403, '只能读取自身或直接子任务的程序证据');
      const entries = this.evidenceEntries(chat, target); const currentBaseline = this.resultReadBaseline(chat, task);
      const page = entries.slice(input.offset, input.offset + input.limit).map(entry => {
        const candidates = (task.resultReadPages ?? []).filter(item => item.ref === entry.ref && item.hash === entry.hash && item.runnerEvidence);
        const supplied = candidates.filter(item => item.baselineAuthority === currentBaseline.authority).at(-1) ?? candidates.at(-1);
        return supplied ? { ...entry, providedRunnerEvidence: compactRunnerEvidence(supplied, currentBaseline.authority) } : entry;
      });
      const value = () => ({ taskId: target.id, taskStatus: target.status, entries: page, total: entries.length, next: input.offset + page.length < entries.length ? input.offset + page.length : null });
      while (page.length > 1 && JSON.stringify(value()).length > 3800) page.pop();
      if (page.length) this.evidenceRead(task, { read: 'task_evidence', taskId: target.id, offset: input.offset, entries: page.map(entry => [entry.ref, entry.hash]) });
      return json(value());
    }
    if (name === 'user_source_list') {
      const input = z.object({ offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(40).default(20) }).strict().parse(raw);
      const plan = sourcePlan(chat, task, this.store); const sources = plan.sources.slice(input.offset, input.offset + input.limit);
      const value = () => ({ sources, next: input.offset + sources.length < plan.sources.length ? input.offset + sources.length : null, total: plan.sources.length });
      while (sources.length > 1 && JSON.stringify(value()).length > 3800) sources.pop();
      return json(value());
    }
    if (name === 'user_source_read') {
      const input = z.object({ sourceId: z.string().min(1).max(150), offset: z.number().int().min(0).default(0) }).strict().parse(raw);
      const result = readSource(chat, task, this.store, input);
      const acknowledge = () => {
        const hashes = task.sourceCoverageHashes ??= {}; const coverage = task.sourceCoverage ??= {};
        if (hashes[input.sourceId] !== result.sourceHash) coverage[input.sourceId] = [];
        hashes[input.sourceId] = result.sourceHash;
        if (!coverage[input.sourceId]!.includes(input.offset)) coverage[input.sourceId]!.push(input.offset);
      };
      if (chat.apiRoster) (active.receiptAcks ??= new Map()).set(toolCallId, acknowledge);
      else { acknowledge(); this.store.save(chat); }
      return { text: `来源 ${input.sourceId}；offset=${input.offset}；next=${result.next ?? '完成'}；SHA256=${result.sourceHash}\n${result.text}`, data: { sourceId: input.sourceId, offset: input.offset, next: result.next, sourceHash: result.sourceHash } };
    }
    if (name === 'worker_submit' || name === 'fanout_submit') {
      if (name === 'worker_submit') {
        const input = workerSubmitSchema.parse(raw);
        this.assertApiDispatch(chat, task, input.tasks, this.apiSettings.scheduler.workerMaxItemsPerCall);
        const children = this.enqueuePool(chat, task, input.pool, input.tasks);
        return json({ total: children.length, taskIds: children.map(child => child.id) });
      }
      const input = fanoutSubmitSchema.parse(raw);
      const items = fanoutGoals(input);
      this.assertApiDispatch(chat, task, items, this.apiSettings.scheduler.fanoutMaxItemsPerCall);
      const group = createFanoutGroup(randomUUID(), task.id, input, time());
      this.enqueuePool(chat, task, group.pool, items, group);
      return json({ groupId: group.id, total: group.total });
    }
    if (name === 'agent_submit' || name === 'grok_submit') {
      const apiRoster = chat.apiRoster?.roster;
      const activeRoster = apiRoster ?? chat.cliRoster;
      const parentSeat = taskSeat(chat, task)!;
      const delegates = activeRoster ? allowedDelegateSeats(activeRoster, parentSeat) : parentSeat.can.delegateSeats;
      const delegateSchema = z.object({ role: activeRoster ? seatIdSchema : roleZ.exclude(['claude', 'grok']), goal: textZ, mode: modeZ.default('read'),
        profileId: z.enum(['general','document','spreadsheet','presentation','research','image']).optional(), purpose: z.literal('execution_review').optional() }).strict();
      const items: Array<z.infer<typeof delegateSchema> & { phase?: PhaseId }> = name === 'agent_submit'
        ? [(apiRoster ? delegateSchema.extend({ phase: phaseSchema.optional() }) : delegateSchema).parse(raw)]
        : z.object({ tasks: z.array(z.object({ goal: textZ, mode: modeZ.default('read') }).strict()).min(1).max(CHAT_LIMITS.batch) }).strict().parse(raw).tasks.map(t => ({ ...t, role: 'grok' }));
      if (chat.pipeline && items[0]?.purpose === 'execution_review') items[0].phase ??= 'acceptance';
      if (work && name === 'agent_submit' && (work !== 'implementation-lead' || items[0]?.purpose !== 'execution_review')) {
        throw new HttpError(403, '实现席位与里程碑由程序编排，主导席可委派 Astra 成品验收');
      }
      if (name === 'grok_submit' && chat.cliRoster && (!delegates.includes('grok') || parentSeat.binding.delegation === 'none')) {
        throw new HttpError(403, '该席位不在当前任务允许的委派目标中');
      }
      if (apiRoster) this.assertApiDispatch(chat, task, items, null);
      else {
        if (this.children(chat, task).filter(t => !terminalTask(t.status)).length + items.length > CHAT_LIMITS.parentOutstanding) throw new HttpError(429, '当前父任务最多32项未完成子任务，请先收集结果');
        if ([...this.chats.values()].flatMap(c => c.tasks).filter(t => t.status === 'queued').length + items.length > CHAT_LIMITS.queued) throw new HttpError(429, '全局队列已满，请先等待结果');
      }
      for (const item of items) {
        const phase = apiRoster ? item.phase ?? task.phase ?? 'architecture' : undefined;
        if (phase && !this.delegatedPhases(task).includes(phase)) throw new HttpError(403, '委派阶段超出当前任务允许的范围');
        const target = resolveSeat(activeRoster ?? CLI_ROSTER, item.role, phase);
        if (!target || (name === 'agent_submit' && !delegates.includes(item.role))) throw new HttpError(403, '该席位不在当前任务允许的委派目标中');
        const driver = this.driverFor(chat, item.role, phase);
        if (!driver?.capability.available) throw new HttpError(503, driver?.capability.reason ?? `${item.role} 尚未验证`);
        const canDelegateEdit = activeRoster ? (task.mode === 'edit' || (!task.parentTaskId && task.role === this.rootRole(chat))) : !parentSeat.can.acceptance;
        if (item.mode === 'edit' && (!task.workspaceId || !canDelegateEdit || task.mode === 'verify' ||
          (activeRoster && !target.can.writeMain && !target.can.writeIsolated))) throw new HttpError(403, '当前任务仅可读取或验收');
        if (chat.pipeline?.stage === 'architecture' && name === 'agent_submit') {
          if (phase === 'cluster' || (phase === 'demo' && (item.role !== 'sol' || item.mode !== 'edit')) ||
            (phase === 'acceptance' && (item.role !== 'astra' || item.mode !== 'verify' || item.purpose !== 'execution_review')) ||
            (phase === 'architecture' && item.mode !== 'read')) {
            throw new HttpError(403, '架构层仅允许读取委派、Sol Demo、集群工具编排和 Astra 独立评审');
          }
          if (phase === 'demo') {
            if (chat.pipeline.contract) return this.requestDemoRepair(active);
            this.observePipelinePlan(chat, task);
            const clusterStep = architectureStepId(chat.pipeline.revision, 'cluster');
            if (!chat.todos?.some(step => step.id === clusterStep && step.status === 'completed')) {
              throw new HttpError(409, '先完整读取 full 集群汇总，并声明每项子任务的处置');
            }
          }
        }
      }
      const review = items[0]?.purpose === 'execution_review';
      let view: ReturnType<typeof materializeExecutionView> | undefined;
      if (review) {
        const reviewer = items[0]!;
        const reviewerSeat = resolveSeat(activeRoster ?? CLI_ROSTER, reviewer.role, reviewer.phase ?? task.phase);
        if (work === 'implementation-lead' && (chat.pipeline?.stage !== 'acceptance' || reviewer.role !== 'astra')) {
          throw new HttpError(409, '实现层交回后须由 Astra 对成品独立验收');
        }
        if (task.parentTaskId || task.role !== this.rootRole(chat) || task.executionPolicyVersion !== 1 || !reviewerSeat?.can.acceptance || reviewer.mode !== 'verify') throw new HttpError(403, activeRoster ? '独立执行评审只能由新契约根任务委派具备验收权限的验证席位' : '独立执行评审只能由新契约根任务委派Astra verify');
        try {
          this.observePipelinePlan(chat, task);
          const issues = reviewReadinessIssues(chat, task, this.store);
          issues.push(...this.projectOutputIssues(chat, task));
          if (issues.length) return this.executionFeedback('EXECUTION_REVIEW_NOT_READY', issues);
          view = materializeExecutionView(chat, task, this.store);
        } catch { return this.executionFeedback('EXECUTION_VIEW_INVALID', ['当前执行契约或已登记证据校验失败；未创建新的评审任务']); }
        const previous = task.executionReviewAttempts?.at(-1);
        if (previous) {
          const child = chat.tasks.find(candidate => candidate.id === previous.taskId);
          if (!child || !terminalTask(child.status) || child.status === 'interrupted' || child.invocationIds.some(id => {
            const prior = chat.invocations.find(candidate => candidate.id === id); return prior?.status !== 'exited' || prior.exitConfirmed !== true || this.active.has(id);
          }) || chat.unsafeProcesses?.some(process => process.taskId === child.id)) return this.executionFeedback('EXECUTION_REVIEW_ATTEMPT_BLOCKED', ['前次独立评审尚未安全结束，不能重复派发']);
        }
        if (task.executionReviewAttempts?.some(attempt => attempt.contractHash === view!.contractHash && attempt.evidenceHash === view!.evidenceHash)) return this.executionFeedback('EXECUTION_REVIEW_ATTEMPT_BLOCKED', ['相同契约和证据已送审；保留原结论，不能原样重跑']);
      }
      const children = items.map(i => {
        const child = this.newTask(chat, i.role, i.goal, task.turnId, task, i.mode, i.phase); if (i.profileId) child.profileId = i.profileId;
        if (review && view) {
          child.executionReviewOfTaskId = task.id; task.executionReviewRequired = true;
          if (work === 'implementation-lead') child.pipelineWork = { kind: 'product-review' };
          (task.executionReviewAttempts ??= []).push({ taskId: child.id, contractHash: view.contractHash, evidenceHash: view.evidenceHash, viewRef: view.viewRef, viewHash: view.viewHash, createdAt: time() });
        }
        return child;
      });
      latchExecutionReview(chat, task);
      children.forEach(t => this.update(chat, t)); this.schedule(); return json(children.map(t => ({ taskId: t.id, role: t.role, status: t.status })));
    }
    if (name === 'grok_collect' || name === 'task_collect') {
      if (name === 'task_collect' && chat.apiRoster) {
        const input = collectSchema.parse(raw);
        const cluster = chat.pipeline?.clusters.find(item => item.groupId === input.groupId && item.rootTaskId === task.id);
        if (cluster) {
          if (input.wait && ['planning', 'running'].includes(cluster.status)) return this.wait(active, { type: 'children', clusterId: cluster.id });
          return json({ groupId: cluster.groupId, status: cluster.status, ref: cluster.summaryRef, hash: cluster.summaryHash,
            ...mechanicalCollect(chat.tasks, task.id, input) });
        }
        const group = input.groupId ? chat.fanoutGroups?.find(item => item.id === input.groupId && item.parentTaskId === task.id) : undefined;
        if (input.groupId && !group) throw new HttpError(403, '只能收集本任务的扇出组');
        let children = selectChildTasks(chat.tasks, task.id, input);
        if (input.taskIds && children.length !== new Set(input.taskIds).size) throw new HttpError(403, '只能收集本任务的子任务');
        if (group && !input.taskIds) children = this.collectReduction(chat, task, group, children);
        const pending = children.filter(child => !terminalTask(child.status));
        if (input.wait && pending.length) return this.wait(active, { type: 'children', ...(group && !input.taskIds ? { groupId: group.id } : { childIds: pending.map(child => child.id) }) });
        if (group) {
          const reducers = children.filter(child => child.reductionLevel);
          const reduction = reducers.at(-1);
          return json({ groupId: group.id, ...mechanicalCollect(children.filter(child => !child.reductionLevel), task.id, input),
            ...(reduction ? { reduction: { provenance: 'model', level: reduction.reductionLevel, status: reduction.status, ref: reduction.resultRef } } : {}) });
        }
        if ((raw && typeof raw === 'object' && ('offset' in raw || 'limit' in raw)) ||
          (input.taskIds?.length ?? 0) > 8) return json(mechanicalCollect(chat.tasks, task.id, input));
      }
      const input = z.object({ taskIds: z.array(z.string()).max(8).optional(), wait: z.boolean().default(false) }).strict().parse(raw);
      const children = this.children(chat, task);
      if (input.taskIds?.some(id => !children.some(t => t.id === id))) throw new HttpError(403, '只能收集本任务的子任务');
      const selected = input.taskIds ? children.filter(t => input.taskIds!.includes(t.id)) : children.filter(t => !t.disposition);
      const pending = selected.filter(t => !terminalTask(t.status));
      if (input.wait && pending.length) return this.wait(active, { type: 'children', childIds: pending.map(t => t.id) });
      let remaining = CHAT_LIMITS.collectTotalText;
      return json(selected.slice(0, 8).map(t => { const summary = (t.result ?? t.error ?? '').slice(0, Math.min(CHAT_LIMITS.collectItemText, remaining)); remaining -= summary.length; return { taskId: t.id, role: t.role, status: t.status, summary, ref: t.resultRef, ...(t.errorCode ? { errorCode: t.errorCode } : {}) }; }));
    }
    if (name === 'grok_disposition' || name === 'task_disposition') {
      if (name === 'task_disposition' && chat.apiRoster && raw && typeof raw === 'object' && ('taskIds' in raw || 'groupId' in raw)) {
        const input = dispositionSchema.parse(raw);
        let selection: ReturnType<typeof selectForDisposition>;
        try { selection = selectForDisposition(chat.tasks, task.id, input); }
        catch { throw new HttpError(403, '只能处置本任务的直属子任务'); }
        if (selection.tasks.some(child => !terminalTask(child.status) || (child.status === 'interrupted' && !child.interruptionSafe))) throw new HttpError(409, '部分子任务未安全结束');
        for (const child of selection.tasks) {
          child.disposition = selection.disposition;
          child.updatedAt = time();
          settlePlans(chat, child);
        }
        this.emit(chat, 'task_dispositions', { taskIds: selection.tasks.map(child => child.id), disposition: selection.disposition }, task, invocation);
        return json({ ok: true, count: selection.tasks.length });
      }
      const input = z.object({ taskId: z.string(), disposition: z.enum(['adopted', 'rejected', 'reference']) }).strict().parse(raw);
      const child = this.children(chat, task).find(t => t.id === input.taskId);
      if (!child || !terminalTask(child.status) || (child.status === 'interrupted' && !child.interruptionSafe)) throw new HttpError(409, '子任务未安全结束');
      child.disposition = input.disposition; this.update(chat, child); this.observePipelinePlan(chat, task);
      const trace = work === 'implementation-lead' && input.disposition === 'adopted' ? this.publishPipelineTrace(active, child) : undefined;
      return json({ ok: true, ...(trace ? { trace } : {}) });
    }
    if (name === 'ask_user') { const input = z.object({ question: textZ, options: z.array(z.string().max(200)).max(6).optional() }).strict().parse(raw); return this.wait(active, { type: 'user', ...input }); }
    if (name === 'notes_write') {
      const { text } = z.object({ text: z.string().max(8000) }).strict().parse(raw);
      const notes = task.notes ??= [];
      const version = (notes.at(-1)?.version ?? 0) + 1;
      const blob = this.store.putBlob(chat.id, `notes-${task.id}-${version}.txt`, text);
      notes.push({ version, invocationId: invocation.id, ref: blob.relativePath, hash: blob.hash, bytes: blob.bytes });
      return json({ version, hash: blob.hash, bytes: blob.bytes });
    }
    if (name === 'task_yield') {
      const note = z.object({ next: textZ, note: z.string().max(4000).optional() }).strict();
      const items = z.array(z.string().min(1).max(1000)).max(12).optional();
      const input = (chat.apiRoster ? note.extend({ done: items, unverified: items, risks: items }) : note).parse(raw) as
        z.infer<typeof note> & { done?: string[]; unverified?: string[]; risks?: string[] };
      const saved = checkpoint(chat, task, invocation, input.next, input.note);
      if (chat.apiRoster) {
        for (const field of ['done', 'unverified', 'risks'] as const) if (input[field]) saved[field] = input[field];
        invocation.rotationReason = 'yield';
      }
      active.explicitCheckpoint = true; this.release(active, 'rotate');
      return { text: '检查点已保存；本段结束，新段继续', stop: 'rotate' };
    }
    if (name === 'task_complete') {
      let result: string;
      if (this.pool(chat, task)) {
        const report = z.object({ report: workerReportSchema }).strict().parse(raw).report;
        const evidence = new Set([...this.evidenceEntries(chat, task).map(item => item.ref), ...(task.resultReadPages ?? []).map(item => item.ref)]);
        if (report.evidenceRefs.some(ref => !evidence.has(ref))) throw new HttpError(409, 'worker 报告引用了未登记的证据');
        result = JSON.stringify(report);
        if (report.status !== 'completed') {
          active.failedOutcome = { reason: report.summary, result };
          return { text: 'worker 已登记受阻或失败报告', stop: 'completed' };
        }
      } else ({ result } = z.object({ result: textZ }).strict().parse(raw));
      if (active.pendingTools?.size) throw new HttpError(409, '仍有工具正在执行，不能提前完成');
      if (this.pendingExec(chat, task.id)) throw new HttpError(409, '请先查询或停止尚未收口的后台作业');
      const memoIssues = clusterReadIssues(chat, task, task.clusterId ? this.resultReadBaseline(chat, task).authority : '');
      if (memoIssues.length) throw new HttpError(409, memoIssues.join('；'));
      const outstandingFailures = [...(active.toolFailures ?? [])].filter(([key]) => key !== toolFailureKey(name, raw));
      if (outstandingFailures.length) throw new HttpError(409, `工具失败尚未恢复：${[...new Set(outstandingFailures.map(([, item]) => item.name))].join('、')}`);
      if (this.pending(chat, task).length || this.children(chat, task).some(t => !terminalTask(t.status) || !t.disposition || (t.status === 'interrupted' && !t.interruptionSafe))) throw new HttpError(409, '子任务、待回答问题或采用声明尚未收口');
      this.observePipelinePlan(chat, task);
      const sourceIssues = sourceCoverageIssues(chat, task, this.store); const planIssues = planCompletionIssues(chat, task); const workspaceIssues = this.options.workspace?.completionIssues?.(chat, task) ?? [];
      workspaceIssues.push(...this.implementationCompletionIssues(chat, task));
      const issues = [...sourceIssues, ...planIssues, ...workspaceIssues];
      if (issues.length) {
        if (planIssues.length && !sourceIssues.length && !workspaceIssues.length) throw new PlanCompletionError(planCompletionDetails(chat, task));
        throw new HttpError(409, issues.join('；'));
      }
      const outputIssues = this.projectOutputIssues(chat, task);
      if (outputIssues.length) return this.executionFeedback('PROJECT_OUTPUT_UNVERIFIED', outputIssues, task.executionPolicyVersion === 1 ? 'execution_read' : 'task_evidence');
      const executionIssues = this.executionIssues(chat, task);
      if (executionIssues.length) return this.executionFeedback('EXECUTION_REVIEW_REQUIRED', executionIssues);
      active.complete = result; return { ...json({ submitted: true, completion: 'awaiting_process_exit' }), stop: 'completed' };
    }
    if (name === 'task_fail') {
      const input = z.object({ reason: z.string().trim().min(1).max(2000), result: z.string().trim().min(1).max(100_000).optional() }).strict().parse(raw);
      if (active.pendingTools?.size) throw new HttpError(409, '仍有工具正在执行，不能提前失败结案');
      try { active.failureSubtree = this.stopOwnedSubtree(active); }
      catch (error) {
        for (const child of this.descendants(chat, task)) for (const job of this.jobs.values()) if (job.task.id === child.id) { this.release(job, 'cancel'); job.controller.abort(); job.toolController.abort(); }
        chat.blockedReason = '失败结案时子任务安全停止未完整持久化，已阻断派发并等待核对'; task.status = 'interrupted'; this.release(active, 'cancel'); active.controller.abort(); active.toolController.abort(); throw error;
      }
      active.failedOutcome = input;
      return { ...json({ submitted: true, outcome: 'failed', finalization: 'awaiting_confirmed_process_exit' }), stop: 'completed' };
    }
    if (name === 'artifact_publish') {
      const input = z.object({ name: z.string().regex(/^[^\\/:\u0000-\u001f]{1,160}$/), text: z.string().max(2_000_000), kind: z.enum(['file', 'diff', 'test', 'report']).default('file') }).strict().parse(raw);
      const state = chat.pipeline;
      if (state && input.name.toLowerCase() === 'trace.json') throw new HttpError(403, 'TRACE.json 由程序根据冻结验收及回执发布');
      if (state?.stage === 'architecture' && (input.name === 'CONTRACT.json' || (state.contract && ['PRD.md', 'ARCHITECTURE.md'].includes(input.name)))) {
        throw new HttpError(409, '需求契约由程序发布，已冻结的文档须在下一修订更新');
      }
      if (state?.stage === 'architecture' && (
        (['PRD.md', 'ARCHITECTURE.md'].includes(input.name) && state.architectureTaskId !== task.id) ||
        (input.name === 'DEV_GUIDE.md' && !(task.role === 'astra' && task.phase === 'architecture' && task.parentTaskId === state.architectureTaskId)) ||
        (input.name === 'DEMO_REPORT.md' && !(task.role === 'sol' && task.phase === 'demo' && task.parentTaskId === state.architectureTaskId)))) {
        throw new HttpError(403, '当前任务不是该架构产物的冻结作者');
      }
      return json(this.publishArtifact(chat, task, invocation, input, 'model'));
    }
    if (name === 'result_read') {
      const input = z.object({ ref: z.string(), offset: z.number().int().min(0).default(0) }).strict().parse(raw);
      const allowed = (targetId: string) => targetId === task.id || this.children(chat, task).some(child => child.id === targetId)
        || Boolean(task.clusterReadTaskIds?.includes(targetId))
        || reviewerCanReadTask(chat, task, targetId) || Boolean(task.reductionLevel && task.groupId && chat.tasks.some(child =>
          child.id === targetId && child.parentTaskId === task.parentTaskId && child.groupId === task.groupId && (child.reductionLevel ?? 0) === task.reductionLevel! - 1));
      const readableTask = chat.tasks.find(t => t.resultRef === input.ref && allowed(t.id));
      const readableArtifact = chat.artifacts.find(a => a.relativePath === input.ref);
      const readableTicket = chat.tickets.find(t => t.resultRef === input.ref && allowed(t.taskId) && t.type === 'tool' && t.status === 'resolved' && t.processStatus === 'exited');
      const readableResults = (chat.toolResults ?? []).filter(r => r.ref === input.ref && allowed(r.taskId) && ((r.provenance === 'runner' && !!readableTicket) || r.provenance !== 'runner'));
      const windowHashes: string[] = [];
      if (chat.apiRoster) for (const previous of chat.invocations.filter(item => allowed(item.taskId))) {
        if (previous.handoffRef === input.ref && previous.handoffHash) windowHashes.push(previous.handoffHash);
        if (previous.handoffStateRef === input.ref && previous.handoffStateHash) windowHashes.push(previous.handoffStateHash);
        for (const receipt of previous.toolReceiptDeliveries ?? []) if (receipt.ref === input.ref) windowHashes.push(receipt.hash);
      }
      if (!readableTask && !readableArtifact && !readableTicket && !readableResults.length && !windowHashes.length) throw new HttpError(403, '没有该结果的读取权限');
      const text = this.store.readBlob(chat.id, input.ref).toString('utf8');
      const hash = createHash('sha256').update(text).digest('hex');
      const registeredHashes = new Set([readableTask?.resultHash, readableArtifact?.hash, ...readableResults.map(item => item.hash), ...windowHashes].filter((value): value is string => !!value));
      if (registeredHashes.size && !registeredHashes.has(hash)) throw new HttpError(409, '结果引用内容哈希漂移；请使用宿主新登记的不可变ref，不能把同一ref的变更内容当作新页读取');
      let content = text.slice(input.offset, input.offset + 3900);
      if (content.length && /[\uD800-\uDBFF]/.test(content.at(-1)!)) content = content.slice(0, -1);
      const next = input.offset + content.length < text.length ? input.offset + content.length : null;
      const workspaceId = task.workspaceId ?? null; const workspaceVersion = task.workspaceVersion ?? null;
      const baseline = this.resultReadBaseline(chat, task);
      const baselineAuthority = baseline.authority;
      const identity = { read: 'result_read', ref: input.ref, hash, offset: input.offset, baselineAuthority };
      const trustedRunner = readableTicket && readableResults.some(item => item.provenance === 'runner' && item.hash === hash && item.taskId === readableTicket.taskId && item.invocationId === readableTicket.invocationId);
      const candidate: ResultReadCandidate = { ref: input.ref, hash, offset: input.offset, next, workspaceId, workspaceVersion, sourceRevision: baseline.sourceRevision, baselineAuthority,
        coverageIndex: task.evidenceReadCoverage?.length ?? 0, firstInvocationId: invocation.id, firstToolCallId: toolCallId,
        ...(trustedRunner ? { runnerEvidenceCandidate: parseRunnerEvidence(text, invocation.id, toolCallId) } : {}),
        digest: createHash('sha256').update(JSON.stringify(identity)).digest('hex'), legacyDigest: createHash('sha256').update(JSON.stringify({ read: 'result_read', ref: input.ref, hash, offset: input.offset })).digest('hex') };
      const reply: RuntimeToolReply = { text: `[程序分页 offset=${input.offset} next=${next ?? 'null'}]\n${content}`, data: { next } };
      return content.length || (text.length === 0 && input.offset === 0) ? Object.assign(reply, { [resultReadCandidate]: candidate }) : reply;
    }
    if (this.options.capabilities?.definitions(task).some(tool => tool.name === name)) {
      const issues = sourceCoverageIssues(chat, task, this.store); if (issues.length) throw new HttpError(409, `先核对完整用户材料：${issues.join('；')}`);
      return this.options.capabilities.call(name, raw, { chat, task, invocation, toolCallId, signal: active.toolController.signal });
    }
    if (!this.options.workspace) throw new HttpError(503, '本地文件能力不可用');
    if (name === 'file_write' && task.pipelineWork?.kind === 'milestone-author') {
      const input = z.object({ path: z.string().min(1).max(2_000) }).passthrough().parse(raw);
      const issues = milestonePathIssues(task.pipelineWork.paths, { created: [], modified: [input.path.replaceAll('\\', '/')], deleted: [] });
      if (issues.length) {
        this.recordAuthorDrift(chat, task, issues);
        return json({ ok: false, code: 'MILESTONE_PATH_DRIFT', issues, next: 'task_yield' });
      }
    }
    if (['file_write', 'integrate_edit', 'test_submit'].includes(name)) { const issues = sourceCoverageIssues(chat, task, this.store); if (issues.length) throw new HttpError(409, `必保用户原文尚未核对：${issues.join('；')}`); }
    const reply = await this.options.workspace.call(name, raw, { chat, task, invocation, signal: active.toolController.signal });
    if (task.pipelineWork?.kind === 'milestone-author' && (name === 'file_write' || name === 'integrate_edit')) task.pipelineWork.started = true;
    if (reply.stop === 'wait' && reply.ticketId) { const saved = this.wait(active, { type: 'tool', externalId: reply.ticketId, processStatus: 'registered' }); return { ...saved, ticketId: reply.ticketId }; }
    return reply;
  }
  private resultReadBaseline(chat: ChatRecord, task: AgentTask): { authority: string; sourceRevision: number | null } {
    const workspaceId = task.workspaceId ?? null; const workspaceVersion = task.workspaceVersion ?? null;
    return workspaceId && workspaceVersion !== null
      ? this.options.workspace?.resultReadBaseline?.(chat, task) ?? { authority: `workspace:${workspaceId}:grant:${workspaceVersion}:source:legacy`, sourceRevision: null }
      : { authority: `task:${task.id}:no-workspace`, sourceRevision: null };
  }
  cancel(id: string): ChatRecord {
    const chat = this.get(id);
    for (const task of chat.tasks) if (!terminalTask(task.status)) { task.status = 'cancelled'; this.update(chat, task); }
    for (const ticket of chat.tickets) if (ticket.status === 'pending') { ticket.status = 'cancelled'; this.emit(chat, 'ticket_updated', ticket, chat.tasks.find(t => t.id === ticket.taskId)); }
    for (const active of this.jobs.values()) if (active.chat.id === id) { this.release(active, 'cancel'); active.controller.abort(); active.toolController.abort(); }
    for (const cleanup of this.stopExecJobs(chat)) {
      const tracked = cleanup.catch(() => { chat.blockedReason ??= '后台作业的退出回执无法保存'; })
        .finally(() => { this.finishing.delete(tracked); });
      this.finishing.add(tracked);
    }
    this.emit(chat, 'state', { cancelled: true }); return chat;
  }
  revokeWorkspace(workspaceId: string) { for (const chat of this.chats.values()) if (chat.workspaceId === workspaceId) { this.cancel(chat.id); this.emit(chat, 'workspace_revoked', { workspaceId }); } }
  private reconcileResultReadLedger(chat: ChatRecord): boolean {
    if (chat.apiRoster) return false;
    let changed = false;
    for (let since = 0;;) {
      const page = this.store.events(chat.id, since, 500);
      for (const event of page.items) {
        if (event.type !== 'tool_result' || !event.taskId || !event.invocationId || !event.data || typeof event.data !== 'object') continue;
        const readPage = (event.data as { readPage?: unknown }).readPage;
        if (!readPage || typeof readPage !== 'object') continue;
        const item = readPage as Record<string, unknown>;
        if (item.alreadyProvided !== false || item.originalContentIncluded !== true || typeof item.ref !== 'string' || typeof item.hash !== 'string'
          || typeof item.offset !== 'number' || !(item.next === null || typeof item.next === 'number') || typeof item.baselineAuthority !== 'string'
          || typeof item.coverageIndex !== 'number' || typeof item.firstInvocationId !== 'string' || typeof item.firstToolCallId !== 'string') continue;
        const task = chat.tasks.find(candidate => candidate.id === event.taskId); if (!task) continue;
        const existing = (task.resultReadPages ??= []).some(candidate => candidate.ref === item.ref && candidate.hash === item.hash && candidate.offset === item.offset && candidate.baselineAuthority === item.baselineAuthority);
        if (existing) continue;
        const resultPage: ResultReadPage = { ref: item.ref, hash: item.hash, offset: item.offset, next: item.next as number | null,
          workspaceId: typeof item.workspaceId === 'string' ? item.workspaceId : task.workspaceId ?? null,
          workspaceVersion: typeof item.workspaceVersion === 'number' ? item.workspaceVersion : task.workspaceVersion ?? null,
          sourceRevision: typeof item.sourceRevision === 'number' ? item.sourceRevision : null, baselineAuthority: item.baselineAuthority,
          coverageIndex: item.coverageIndex, firstInvocationId: item.firstInvocationId, firstToolCallId: item.firstToolCallId,
          ...(() => { const metadata = storedRunnerEvidenceZ.safeParse(item.runnerEvidence); return metadata.success ? { runnerEvidence: metadata.data } : {}; })() };
        task.resultReadPages.push(resultPage);
        const digest = createHash('sha256').update(JSON.stringify({ read: 'result_read', ref: resultPage.ref, hash: resultPage.hash, offset: resultPage.offset, baselineAuthority: resultPage.baselineAuthority })).digest('hex');
        if (!(task.evidenceReadCoverage ??= []).includes(digest)) task.evidenceReadCoverage.push(digest);
        changed = true;
      }
      if (!page.hasMore) break; since = page.next;
    }
    return changed;
  }
  private reconcilePipelineMirror(chat: ChatRecord): boolean {
    const intent = chat.pipeline?.implementation?.mirrorIntent;
    if (!intent || !this.pipelineMirror) return false;
    const task = chat.tasks.find(item => item.id === intent.taskId);
    if (!task) {
      chat.blockedReason ??= '流水线镜像意图引用的写入任务不存在，已停止恢复';
      this.store.save(chat);
      return true;
    }
    try {
      const event = this.pipelineMirror.reconcile(chat, task);
      if (event) this.publishEvent(event);
    } catch (error) {
      chat.blockedReason ??= `流水线镜像与工作区字节不一致，拒绝覆盖：${error instanceof Error ? error.message : String(error)}`;
      this.store.save(chat);
    }
    return true;
  }
  private recoverApi(chat: ChatRecord, changed: boolean) {
    for (const job of chat.execJobs ?? []) {
      if (job.state === 'starting') { job.state = 'finished'; changed = true; }
      if (job.state !== 'running') continue;
      job.state = 'exit_unknown';
      chat.blockedReason ??= '上次宿主作业退出状态未知，恢复前需核实残留进程';
      const task = chat.tasks.find(item => item.id === job.taskId);
      if (task) {
        task.status = 'interrupted'; task.errorCode = 'EXEC_JOB_INTERRUPTED'; task.error = chat.blockedReason;
      }
      const invocation = chat.invocations.find(item => item.id === job.invocationId);
      if (invocation) { invocation.status = 'exit_unknown'; invocation.exitConfirmed = false; }
      changed = true;
    }
    const interrupted = chat.tasks.filter(task => task.status === 'running');
    const work = new Set(interrupted.map(task => task.invocationIds.at(-1)).filter((id): id is string => Boolean(id)));
    const unsettled = new Map<string, { invocationId: string; name?: string }>();
    // The program-owned successful tool result is the durable repair intent.
    const acceptedDemoRepairs = new Map<string, { taskId: string; receipt: DemoRepairReceipt }>();
    const reads = new Set(['file_list', 'file_read', 'file_search', 'workspace_changes', 'task_state', 'task_evidence',
      'plan_read', 'execution_read', 'result_read', 'user_source_list', 'user_source_read', 'session_file_list', 'session_file_read']);
    if (work.size) {
      for (let since = 0;;) {
        const page = this.store.events(chat.id, since);
        for (const event of page.items) {
          if (!event.invocationId || !work.has(event.invocationId) || !event.data || typeof event.data !== 'object') continue;
          const data = event.data as Record<string, unknown>;
          if (event.type === 'tool_started' && !reads.has(String(data.name))) {
            unsettled.set(typeof data.toolCallId === 'string' ? data.toolCallId : `unknown:${event.seq}`,
              { invocationId: event.invocationId, ...(typeof data.name === 'string' ? { name: data.name } : {}) });
          }
          if (['tool_result', 'tool_error'].includes(event.type) && typeof data.toolCallId === 'string') unsettled.delete(data.toolCallId);
          if (event.type === 'tool_result' && event.taskId && data.name === 'agent_submit' && typeof data.text === 'string') {
            let parsed: unknown;
            try { parsed = JSON.parse(data.text); } catch { continue; }
            const receipt = demoRepairReceiptSchema.safeParse(parsed);
            if (receipt.success) acceptedDemoRepairs.set(event.invocationId, { taskId: event.taskId, receipt: receipt.data });
          }
        }
        if (!page.hasMore) break;
        since = page.next;
      }
    }
    const pendingSideEffects = new Set([...unsettled.values()].map(item => item.invocationId));
    const autoResume = this.apiSettings.recovery.autoResume && !chat.blockedReason;
    const repairs: { task: AgentTask; receipt: DemoRepairReceipt }[] = [];
    for (const task of interrupted) {
      const invocation = chat.invocations.find(item => item.id === task.invocationIds.at(-1));
      const accepted = invocation && invocation.taskId === task.id && acceptedDemoRepairs.get(invocation.id);
      const repair = accepted && accepted.taskId === task.id ? accepted.receipt : undefined;
      const safe = Boolean(invocation && invocation.status !== 'exit_unknown' && !pendingSideEffects.has(invocation.id) &&
        !chat.unsafeProcesses?.some(process => process.taskId === task.id) &&
        !chat.tickets.some(ticket => ticket.taskId === task.id && ticket.type === 'tool' && ticket.status === 'pending'));
      if (invocation) {
        invocation.endedAt ??= time();
        invocation.status = safe ? 'exited' : 'exit_unknown';
        invocation.exitConfirmed = safe;
        this.recordUnresolvedApiUsage(chat, invocation.budgetReservation);
        delete invocation.budgetReservation;
      }
      if (safe && repair && autoResume) {
        repairs.push({ task, receipt: repair });
      } else if (safe && invocation && autoResume) {
        task.status = 'queued';
        checkpoint(chat, task, invocation, '服务恢复后先核对程序事实，再继续原任务');
        invocation.rotationReason = 'crash';
        if (!invocation.handoffRef) {
          const handoff = buildHandoff(chat, task, invocation, 'crash', this.store);
          invocation.handoffRef = handoff.ref;
          invocation.handoffHash = handoff.hash;
          invocation.handoffStateRef = handoff.stateRef;
          invocation.handoffStateHash = handoff.stateHash;
          this.mirrorPipelineHandoff(chat, task, handoff.text);
        }
      } else {
        task.status = 'interrupted';
        task.errorCode = repair ? 'DEMO_REPAIR_INTERRUPTED' : 'WINDOW_INTERRUPTED';
        task.error = repair ? 'Demo 返工已登记，服务恢复策略或退出状态要求人工核对'
          : safe ? '服务中断，等待上层决定如何处理' : '服务中断时副作用尚未确认，需先核实';
        if (safe) task.interruptionSafe = true;
      }
      changed = true;
    }
    for (const ticket of chat.tickets.filter(item => item.type === 'tool' && item.status === 'pending')) {
      const task = chat.tasks.find(item => item.id === ticket.taskId);
      const safe = ticket.processStatus === 'registered' || ticket.processStatus === 'not_started';
      ticket.status = 'cancelled';
      if (task) {
        task.status = 'interrupted';
        task.errorCode = 'WINDOW_INTERRUPTED';
        task.error = '工具票据在服务中断前未收口';
        if (safe) task.interruptionSafe = true;
      }
      if (!safe) {
        ticket.processStatus = 'exit_unknown';
        chat.blockedReason = '上次测试 runner 退出状态未知，恢复前需核实残留进程';
        (chat.unsafeProcesses ??= []).push({ id: ticket.externalId ?? ticket.id, kind: 'runner', taskId: ticket.taskId, reason: chat.blockedReason });
      }
      changed = true;
    }
    const possibleProcess = [...unsettled.values()].some(item => !item.name || ['exec', 'job_start', 'job_stop', 'test_submit', 'document_read', 'image_read'].includes(item.name));
    if (possibleProcess) chat.blockedReason ??= '上次宿主工具退出状态未知，恢复前需核实残留进程';
    for (const { task, receipt } of repairs) {
      try {
        if (chat.blockedReason) throw new Error(chat.blockedReason);
        const repair = this.planDemoRepair(chat, task);
        if (receipt.revision !== repair.fromRevision + 1 || receipt.reportRef !== repair.reportRef) {
          throw new Error('已登记的 Demo 返工与当前评审证据不一致');
        }
        this.startDemoRepair(chat, task, repair);
        this.failTask(chat, task, { reason: demoReviewFailure });
      } catch (error) {
        task.status = 'interrupted';
        task.errorCode = 'DEMO_REPAIR_INTERRUPTED';
        task.error = error instanceof Error ? error.message : 'Demo 返工恢复失败';
      }
    }
    if (!chat.blockedReason && autoResume) for (const milestone of chat.pipeline?.implementation?.milestones ?? []) {
      const attempt = milestone.attempts.at(-1);
      if (milestone.status !== 'verifying' || !attempt?.verificationInvocationId) continue;
      const invocation = chat.invocations.find(item => item.id === attempt.verificationInvocationId);
      if (invocation?.exitConfirmed !== true || chat.execJobs?.some(job => job.invocationId === invocation.id && job.state !== 'finished')) continue;
      if (attempt.checks?.length) (attempt.interruptedChecks ??= []).push(attempt.checks);
      delete attempt.checks;
      delete attempt.verificationInvocationId;
      changed = true;
    }
    this.wakeParents(chat);
    this.advancePipelineGate(chat);
    if (changed) {
      for (const turn of chat.turns) {
        const root = chat.tasks.find(task => task.id === turn.rootTaskId);
        if (root) turn.status = root.status;
      }
      this.emit(chat, 'state', { recovered: true, autoResume });
    }
    if (chat.tasks.some(task => task.status === 'queued')) this.schedule();
  }
  recover() {
    for (const summary of this.store.list()) {
      const chat = this.get(summary.id); let changed = false;
      if (Boolean(chat.apiRoster) !== Boolean(this.options.api)) continue;
      if (this.reconcilePipelineMirror(chat)) changed = true;
      for (const root of chat.tasks.filter(task => !task.parentTaskId && task.executionPolicyVersion === 1)) {
        const required = root.executionReviewRequired; latchExecutionReview(chat, root);
        if (root.executionReviewRequired !== required) changed = true;
      }
      if (this.reconcileResultReadLedger(chat)) changed = true;
      const accepted: ChatMessage[] = [];
      for (let before: number | undefined;;) {
        const page = this.store.messages(chat.id, { before });
        accepted.push(...page.items.filter(message => message.accepted));
        if (!page.nextBefore) break; before = page.nextBefore;
      }
      for (const message of accepted.sort((a,b)=>a.seq-b.seq)) {
        if (message.pipelineGate) {
          if (!chat.pipeline?.gateDecisions.some(decision => decision.messageId === message.id)) {
            this.acceptPipelineGate(chat, message);
            changed = true;
          }
        } else if (!chat.acceptedMessageIds?.includes(message.id)) { this.acceptMessage(chat, message); changed = true; }
      }
      if (chat.apiRoster) { this.recoverApi(chat, changed); continue; }
      for (const invocation of chat.invocations) if (invocation.status === 'running') { invocation.status = 'exit_unknown'; invocation.exitConfirmed = false; changed = true; }
      for (const task of chat.tasks) if (task.status === 'running' || task.status === 'queued') {
        const neverStarted = task.status === 'queued' && !task.invocationIds.length && !task.parentTaskId && accepted.some(message => message.turnId === task.turnId && chat.acceptedMessageIds?.includes(message.id));
        if (neverStarted) { this.schedule(); continue; }
        task.status = 'interrupted'; task.error = '服务曾中断，未自动重播执行'; changed = true;
      }
      for (const ticket of chat.tickets.filter(t => t.type === 'tool' && t.status === 'pending')) {
        ticket.status = 'cancelled'; const task = chat.tasks.find(t => t.id === ticket.taskId);
        if (task) { task.status = 'interrupted'; task.error = '测试运行在服务中断前未收口，未自动重播'; }
        if (!ticket.processStatus || ['running', 'exit_unknown'].includes(ticket.processStatus)) {
          ticket.processStatus = 'exit_unknown'; chat.blockedReason = '上次测试 runner 退出状态未知，恢复前需核实残留进程';
          (chat.unsafeProcesses ??= []).push({ id: ticket.externalId ?? ticket.id, kind: 'runner', taskId: ticket.taskId, reason: chat.blockedReason });
        }
        changed = true;
      }
      for (const ticket of chat.tickets.filter(t => t.type === 'children' && t.status === 'pending')) {
        const children = ticket.childIds?.map(id => chat.tasks.find(t => t.id === id));
        if (!children?.length || children.some(child => !child)) continue;
        if (children.some(child => child!.status === 'interrupted')) {
          ticket.status = 'cancelled'; const parent = chat.tasks.find(t => t.id === ticket.taskId); if (parent) { parent.status = 'interrupted'; parent.error = '子任务曾中断，未自动重播'; } changed = true;
        } else if (children.every(child => terminalTask(child!.status) && child!.invocationIds.every(id => { const invocation = chat.invocations.find(item => item.id === id); return invocation?.status === 'exited' && invocation.exitConfirmed === true; }))) {
          this.resolveTicket(chat, ticket); changed = true; this.schedule();
        }
      }
      if (chat.invocations.some(i => i.status === 'exit_unknown')) chat.blockedReason = '上次调用退出状态未知，恢复前需核实进程与导入日志';
      if (changed) { for (const turn of chat.turns) { const root = chat.tasks.find(t => t.id === turn.rootTaskId); if (root) turn.status = root.status; } this.emit(chat, 'state', { recovered: true, autoReplay: false }); }
    }
  }
  get activeCount() { return this.active.size; }
  async idle(timeoutMs = 10_000) { const start = Date.now(); while (this.active.size || this.pumping || this.finishing.size) { if (Date.now() - start > timeoutMs) throw new Error('等待聊天运行结束超时'); await new Promise(resolve => setTimeout(resolve, 5)); } }
  async shutdown(timeoutMs = 8000) {
    this.stopping = true;
    for (const chat of this.chats.values()) if (chat.tasks.some(t => !terminalTask(t.status))) this.cancel(chat.id);
    const pending = [...this.finishing];
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([Promise.all(pending), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('聊天模型进程尚未确认退出')), timeoutMs); })]); }
    finally { if (timer) clearTimeout(timer); }
    if ([...this.chats.values()].some(c => c.invocations.some(i => i.status === 'exit_unknown') || c.unsafeProcesses?.length)) throw new Error('存在未确认退出的聊天调用或测试进程');
  }
}
