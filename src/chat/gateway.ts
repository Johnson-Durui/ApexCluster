import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod/v4';
import type { CommandSpec, RunnerResult } from './runner.js';
import type { CommandRunner, RunnerCommandInfo } from './runner-contract.js';
import type { AgentTask, ChatRecord, Invocation, ToolDefinition, ToolReply } from './types.js';
import { chatRoster, taskSeat } from './roster.js';
import { WorkspaceFileMissingError, WorkspaceRegistry, type IntegrationResult, type WorkspaceChanges, type WorkspaceSnapshot } from './workspace.js';
import type { ExecResult, ExecWorkspace } from '../exec/types.js';
import type {
  ManagedPipelineFile,
  MilestoneCandidate,
  PipelineTaskBinding,
  PipelineWorkspaceHost,
} from '../pipeline/implementation-types.js';
import { createGitCheckpoint } from '../pipeline/git-checkpoint.js';

export interface WorkspaceToolIdentity {
  chat: ChatRecord;
  task: AgentTask;
  invocation: Invocation;
  signal: AbortSignal;
}

export class DemoSourceMissingError extends Error {
  constructor() { super('Demo 源码必须先保存到 demo/'); }
}

interface PendingTest {
  ticketId: string;
  invocationId: string;
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  platform?: CommandSpec['platform'];
}

interface TestEvidence {
  ticketId: string;
  ok: boolean;
  result: RunnerResult | { error: string };
  testSnapshotId?: string;
  sourceSnapshotId?: string;
  sourceFingerprint?: string;
  platform?: CommandSpec['platform'];
}

interface TaskWorkspaceState {
  chatId: string;
  taskId: string;
  workspaceId: string;
  workspaceVersion: number;
  turnId: string;
  sourceRevisionAtFreeze: number;
  baseline?: WorkspaceSnapshot;
  working?: WorkspaceSnapshot;
  frozenEdit?: WorkspaceSnapshot;
  exitConfirmed?: boolean;
  activeInvocationId?: string;
  integrated?: IntegrationResult;
  lastDiffFingerprint?: string;
  tests: TestEvidence[];
  execCopy?: { source: WorkspaceSnapshot; copy: WorkspaceSnapshot };
  execWriteCopies?: Map<string, { source: WorkspaceSnapshot; copy: WorkspaceSnapshot }>;
  candidateSnapshotId?: string;
  candidateFingerprint?: string;
}

export interface WorkspaceDiffArtifact {
  name: string;
  text: string;
  kind: 'diff';
  binding: { beforeSnapshotId: string; afterSnapshotId: string };
}

interface SourceChange {
  chatId: string;
  turnId: string;
  taskId: string;
  revision: number;
  kind: 'sol_write' | 'sol_integrate';
}

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const stringSchema = { type: 'string' };

const definitions: ToolDefinition[] = [
  { name: 'file_list', description: '列出已授权工作区或当前独立副本中的文件；根目录请省略 path，禁止使用 . 或 .. 路径段。', inputSchema: objectSchema({ path: stringSchema }) },
  { name: 'file_read', description: '分页读取已授权工作区或当前独立副本中的文本文件；返回 next 与内容哈希。', inputSchema: objectSchema({ path: stringSchema, offset: { type: 'integer', minimum: 0 }, maxChars: { type: 'integer', minimum: 1, maximum: 4000 } }, ['path']) },
  { name: 'file_search', description: '在已授权工作区或当前独立副本中搜索文字。', inputSchema: objectSchema({ query: stringSchema }, ['query']) },
  { name: 'file_write', description: '按预期哈希写文件。Sol 写原工作区；Grok edit 只写独立副本。', inputSchema: objectSchema({ path: stringSchema, text: stringSchema, expectedHash: { type: ['string', 'null'] } }, ['path', 'text', 'expectedHash']) },
  { name: 'workspace_changes', description: '读取程序计算的文件变化；Sol 可按 taskId 查看同一聊天中的 Grok 编辑结果。', inputSchema: objectSchema({ taskId: stringSchema }) },
  { name: 'test_submit', description: '登记结构化测试请求并结束本调用段。模型退出确认后，宿主才在派生测试副本中执行；平台和程序路径从 task_state 的 testCommands 选择。', inputSchema: objectSchema({ executable: stringSchema, args: { type: 'array', items: stringSchema, maxItems: 64 }, cwd: stringSchema, env: { type: 'object' }, timeoutMs: { type: 'integer', minimum: 1, maximum: 1_800_000 }, platform: { type: 'string', enum: ['windows', 'linux'] } }, ['executable', 'args']) },
  { name: 'integrate_edit', description: 'Sol 集成同一聊天中已安全退出、真实测试通过的 Grok 编辑快照。', inputSchema: objectSchema({ taskId: stringSchema, allowedFiles: { type: 'array', items: stringSchema, maxItems: 200 } }, ['taskId', 'allowedFiles']) },
];

const pathInput = z.string().min(1).max(2_000);
const readInput = z.object({ path: pathInput, offset: z.number().int().min(0).default(0), maxChars: z.number().int().min(1).max(4_000).default(4_000) }).strict();
const envInput = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(4_000)).refine((value) => Object.keys(value).length <= 32, '环境变量最多32项');
const testInput = z.object({
  executable: z.string().min(1).max(2_000),
  args: z.array(z.string().max(4_000)).max(64),
  cwd: z.string().max(2_000).default('.'),
  env: envInput.default({}),
  timeoutMs: z.number().int().min(1).max(30 * 60_000).default(10 * 60_000),
  platform: z.enum(['windows', 'linux']).optional(),
}).strict();

const jsonReply = (data: unknown): ToolReply => ({ text: JSON.stringify(data), data });

export class WorkspaceGateway implements PipelineWorkspaceHost {
  readonly definitions = definitions;
  readonly completionPolicyDescription = '本轮若由 Sol 实际修改或集成源码，根任务完成前必须有 Astra 对修改后冻结快照的真实测试成功；Astra 任务与调用段须安全结束，且验证后原项目哈希不得漂移。';
  private readonly taskStates = new Map<string, TaskWorkspaceState>();
  private readonly pendingTests = new Map<string, PendingTest[]>();
  private readonly pendingArtifacts = new Map<string, WorkspaceDiffArtifact[]>();
  private readonly sourceChanges: SourceChange[] = [];

  constructor(readonly registry: WorkspaceRegistry, readonly runner?: CommandRunner) {}

  private pipelineBinding(task: AgentTask): PipelineTaskBinding | undefined {
    return (task as AgentTask & { pipelineWork?: PipelineTaskBinding }).pipelineWork;
  }

  private normalizedPath(input: string): string {
    const value = input.replaceAll('\\', '/');
    if (!value || path.isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':'))) {
      throw new Error(`流水线路径无效：${input}`);
    }
    return value;
  }

  private pathAllowed(candidate: string, declared: readonly string[]): boolean {
    const normalized = this.normalizedPath(candidate);
    return declared.some(item => {
      const scope = this.normalizedPath(item).replace(/\/$/u, '');
      return normalized === scope || normalized.startsWith(`${scope}/`);
    });
  }

  private milestonePaths(task: AgentTask): string[] | undefined {
    const binding = this.pipelineBinding(task);
    return binding?.kind === 'milestone-author' ? binding.paths.map(item => this.normalizedPath(item)) : undefined;
  }

  private isPipelineMetadata(input: string): boolean {
    const normalized = this.normalizedPath(input);
    return normalized === '.agent' || normalized.startsWith('.agent/');
  }

  private assertScopedChanges(task: AgentTask, changes: WorkspaceChanges): void {
    const declared = this.milestonePaths(task);
    if (!declared) return;
    const outside = [...changes.modified, ...changes.created, ...changes.deleted].filter(item => !this.pathAllowed(item, declared));
    if (outside.length) throw new Error(`里程碑改动越出声明路径：${outside.join(', ')}；请交由对齐检查处理`);
  }

  private freezeWorkspace(chat: ChatRecord, workspaceId: string, taskId: string): WorkspaceSnapshot {
    return this.registry.freeze(workspaceId, taskId, { excludePipelineMetadata: Boolean(chat.pipeline) });
  }

  writePipelineFiles(chat: ChatRecord, task: AgentTask, files: readonly ManagedPipelineFile[]): void {
    if (!chat.pipeline || !chat.workspaceId || task.workspaceId !== chat.workspaceId || task.workspaceVersion === undefined) {
      throw new Error('流水线程序文件缺少有效工作区身份');
    }
    this.assertWorkspace(task.workspaceId, task.workspaceVersion);
    const targets = files.map(file => this.normalizedPath(file.path));
    if (new Set(targets).size !== targets.length) throw new Error('同一批程序文件路径不得重复');
    const prepared = files.map((file, index) => {
      const target = targets[index]!;
      if (!(target.startsWith('docs/') || target.startsWith('.agent/'))) throw new Error(`程序文件只能写入 docs/ 或 .agent/：${target}`);
      const current = this.registry.fileHash(task.workspaceId!, target);
      const desired = createHash('sha256').update(file.text).digest('hex');
      if (current === desired) return { file, target, current, unchanged: true };
      if (current === null && file.expectedHash !== undefined) throw new Error(`受管文件尚不存在，不能按旧哈希替换：${target}`);
      if (current !== null && (!file.expectedHash || current !== file.expectedHash)) throw new Error(`拒绝覆盖非程序确认版本：${target}`);
      return { file, target, current, unchanged: false };
    });
    for (const { file, target, current, unchanged } of prepared) {
      if (!unchanged) this.registry.writeManagedFile(task.workspaceId, target, file.text, current);
    }
  }

  prepareMilestoneAuthor(identity: WorkspaceToolIdentity): void {
    this.assertIdentity(identity);
    const binding = this.pipelineBinding(identity.task);
    if (binding?.kind !== 'milestone-author' || !binding.paths.length) throw new Error('任务没有里程碑作者绑定');
    if (!this.canWriteMain(identity.chat, identity.task) && !this.canWriteIsolated(identity.chat, identity.task)) {
      throw new Error('里程碑作者没有受管写入权限');
    }
    const state = this.state(identity);
    if (!state.baseline) throw new Error('里程碑作者缺少冻结基线');
    if (binding.baselineSnapshotId && binding.baselineSnapshotId !== state.baseline.id) throw new Error('里程碑作者基线绑定已变化');
    binding.baselineSnapshotId = state.baseline.id;
    if (state.working) {
      if (binding.editSnapshotId && binding.editSnapshotId !== state.working.id) throw new Error('里程碑作者编辑副本绑定已变化');
      binding.editSnapshotId = state.working.id;
    }
  }

  freezeMilestoneCandidate(chat: ChatRecord, task: AgentTask): MilestoneCandidate {
    const binding = this.pipelineBinding(task);
    if (binding?.kind !== 'milestone-author' || !binding.baselineSnapshotId || task.status !== 'completed') throw new Error('里程碑作者尚未安全退出并冻结基线');
    const invocations = task.invocationIds.map(id => chat.invocations.find(item => item.id === id));
    const last = invocations.at(-1);
    if (!last || invocations.some(item => item?.taskId !== task.id || item.status !== 'exited' || item.exitConfirmed !== true)) {
      throw new Error('里程碑作者仍有调用段未确认安全退出');
    }
    const identity = { chat, task, invocation: last };
    this.assertIdentity(identity);
    const state = this.state(identity);
    if (!state.baseline || state.baseline.id !== binding.baselineSnapshotId || !state.exitConfirmed) throw new Error('里程碑作者尚未安全退出并冻结基线');
    const snapshot = state.candidateSnapshotId ? this.registry.loadSnapshot(state.candidateSnapshotId)
      : this.canWriteIsolated(chat, task) ? state.frozenEdit : this.freezeWorkspace(chat, state.workspaceId, task.id);
    if (!snapshot) throw new Error('里程碑作者缺少冻结候选');
    const changes = this.registry.snapshotChanges(state.baseline, snapshot);
    this.assertScopedChanges(task, changes);
    const diff = this.registry.snapshotDiff(state.baseline, snapshot);
    const fingerprint = this.snapshotFilesFingerprint(snapshot);
    if (state.candidateFingerprint && state.candidateFingerprint !== fingerprint) throw new Error('已冻结的里程碑候选指纹不一致');
    state.candidateSnapshotId = snapshot.id;
    state.candidateFingerprint = fingerprint;
    return {
      authorTaskId: task.id,
      workspaceId: state.workspaceId,
      workspaceVersion: state.workspaceVersion,
      baselineSnapshotId: state.baseline.id,
      snapshotId: snapshot.id,
      fingerprint,
      diffHash: diff.fingerprint,
      changes,
    };
  }

  inspectMilestonePaths(chat: ChatRecord, task: AgentTask): WorkspaceChanges {
    const state = this.taskStates.get(task.id);
    if (!chat.pipeline || !state?.baseline) throw new Error('里程碑尚未建立受管工作区状态');
    const changes = state.working ? this.registry.snapshotChanges(state.baseline, state.working) : this.registry.workspaceChanges(state.baseline);
    return changes;
  }

  integrateMilestone(chat: ChatRecord, task: AgentTask, candidate: MilestoneCandidate, paths: readonly string[]): IntegrationResult {
    if (!chat.pipeline || !task.workspaceId || task.workspaceVersion === undefined || candidate.workspaceId !== task.workspaceId || candidate.workspaceVersion !== task.workspaceVersion) {
      throw new Error('里程碑候选与集成工作区不一致');
    }
    this.assertWorkspace(task.workspaceId, task.workspaceVersion);
    const author = chat.tasks.find(item => item.id === candidate.authorTaskId);
    const binding = author && this.pipelineBinding(author);
    if (!author || binding?.kind !== 'milestone-author') throw new Error('里程碑候选缺少作者绑定');
    const baseline = this.registry.loadSnapshot(candidate.baselineSnapshotId);
    const snapshot = this.registry.loadSnapshot(candidate.snapshotId);
    if (baseline.taskId !== author.id || snapshot.taskId !== author.id || baseline.workspaceId !== candidate.workspaceId ||
      snapshot.workspaceId !== candidate.workspaceId || this.snapshotFilesFingerprint(snapshot) !== candidate.fingerprint) {
      throw new Error('里程碑候选快照身份或指纹不一致');
    }
    const changes = this.registry.snapshotChanges(baseline, snapshot);
    if (JSON.stringify(changes) !== JSON.stringify(candidate.changes) || this.registry.snapshotDiff(baseline, snapshot).fingerprint !== candidate.diffHash) {
      throw new Error('里程碑候选差异已变化');
    }
    this.assertScopedChanges(author, changes);
    if ([...changes.modified, ...changes.created, ...changes.deleted].some(item => !this.pathAllowed(item, paths))) {
      throw new Error('集成清单未覆盖候选的全部改动');
    }
    if (snapshot.kind === 'baseline') {
      const candidatePaths = [...changes.modified, ...changes.created];
      const drifted = candidatePaths.filter(item => this.registry.fileHash(candidate.workspaceId, item) !== snapshot.files[item]);
      const restoredDeletes = changes.deleted.filter(item => this.registry.fileHash(candidate.workspaceId, item) !== null);
      if (drifted.length || restoredDeletes.length) {
        throw new Error(`Sol 候选冻结后声明路径已漂移：${[...drifted, ...restoredDeletes].join(', ')}`);
      }
      return { journalId: `main-${snapshot.id}`, changed: [...changes.modified, ...changes.created], created: [...changes.created] };
    }
    if (snapshot.kind !== 'edit' || snapshot.sourceSnapshotId !== baseline.id || !this.canIntegrate(chat, task)) {
      throw new Error('只有 Sol 可集成由基线派生的 Opus 编辑候选');
    }
    const alreadyApplied = this.registry.findAppliedIntegration(candidate.workspaceId, baseline.id, snapshot.id);
    if (alreadyApplied) {
      const touched = [...changes.modified, ...changes.created];
      const drifted = touched.filter(item => this.registry.fileHash(candidate.workspaceId, item) !== snapshot.files[item]);
      const restoredDeletes = changes.deleted.filter(item => this.registry.fileHash(candidate.workspaceId, item) !== null);
      if (drifted.length || restoredDeletes.length) {
        throw new Error(`已集成候选的声明路径后来发生漂移：${[...drifted, ...restoredDeletes].join(', ')}`);
      }
    }
    const integration = this.registry.integrateEdit(candidate.workspaceId, baseline, snapshot, paths);
    if ((integration.changed.length || integration.created.length) && !alreadyApplied) {
      const revisions = chat.sourceRevisions ??= {};
      const revision = (revisions[task.turnId] ?? 0) + 1;
      revisions[task.turnId] = revision;
      this.sourceChanges.push({ chatId: chat.id, turnId: task.turnId, taskId: task.id, revision, kind: 'sol_integrate' });
    }
    return integration;
  }

  prepareVerification(chat: ChatRecord, task: AgentTask): ExecWorkspace {
    if (!chat.pipeline || !task.workspaceId || task.workspaceVersion === undefined || task.workspaceId !== chat.workspaceId) {
      throw new Error('程序验收缺少流水线工作区身份');
    }
    this.assertWorkspace(task.workspaceId, task.workspaceVersion);
    const source = this.freezeWorkspace(chat, task.workspaceId, task.id);
    const copy = this.registry.createTestCopy(source);
    return { copyDir: copy.path, sourceSnapshotId: source.id, sourceFingerprint: this.snapshotFilesFingerprint(source), testSnapshotId: copy.id };
  }

  commitMilestone(chat: ChatRecord, task: AgentTask, input: { snapshotId: string; paths: readonly string[]; message: string }): string {
    if (!chat.pipeline || !task.workspaceId || task.workspaceVersion === undefined || task.workspaceId !== chat.workspaceId) {
      throw new Error('Git checkpoint 缺少流水线工作区身份');
    }
    const workspace = this.registry.assert(task.workspaceId, task.workspaceVersion);
    const snapshot = this.registry.loadSnapshot(input.snapshotId);
    if (snapshot.workspaceId !== task.workspaceId || snapshot.taskId !== task.id || snapshot.kind !== 'baseline' || !snapshot.excludesPipelineMetadata) {
      throw new Error('Git checkpoint 必须绑定当前任务的程序冻结主工作区快照');
    }
    const drift = this.registry.workspaceChanges(snapshot);
    if (drift.modified.length || drift.created.length || drift.deleted.length) throw new Error('Git checkpoint 冻结后主工作区源码已变化');
    const rootScope = input.paths.length === 1 && input.paths[0] === '.';
    if (input.paths.some(item => item === '.') && !rootScope) throw new Error('Git checkpoint 根路径只能单独用于首次基线');
    const hasRepository = existsSync(path.join(workspace.path, '.git'));
    const initialSystemDocs = new Set(['docs/PRD.md', 'docs/ARCHITECTURE.md', 'docs/DEV_GUIDE.md', 'docs/CONTRACT.json']);
    const reviewedPaths = rootScope
      ? hasRepository ? Object.keys(snapshot.files).filter(file => initialSystemDocs.has(file)) : Object.keys(snapshot.files)
      : [...new Set(input.paths.map(item => this.normalizedPath(item)))];
    if (!rootScope && !reviewedPaths.length) throw new Error('Git checkpoint 缺少已评审路径');
    const chatRef = createHash('sha256').update(chat.id).digest('hex').slice(0, 32);
    return createGitCheckpoint({
      workspaceRoot: workspace.path,
      files: snapshot.files,
      reviewedPaths,
      message: input.message,
      ref: `refs/dmw/checkpoints/chat-${chatRef}`,
    }).commit;
  }

  private hasExplicitRoster(chat: ChatRecord): boolean {
    return Boolean(chat.apiRoster || chat.cliRoster);
  }

  private canWriteMain(chat: ChatRecord, task: AgentTask): boolean {
    return this.hasExplicitRoster(chat) ? Boolean(taskSeat(chat, task)?.can.writeMain) && task.mode === 'edit' : task.role === 'sol' && task.mode === 'edit';
  }

  private canWriteIsolated(chat: ChatRecord, task: AgentTask): boolean {
    return this.hasExplicitRoster(chat) ? Boolean(taskSeat(chat, task)?.can.writeIsolated) && task.mode === 'edit' : task.role === 'grok' && task.mode === 'edit';
  }

  private canAccept(chat: ChatRecord, task: AgentTask): boolean {
    return this.hasExplicitRoster(chat) ? Boolean(taskSeat(chat, task)?.can.acceptance) && task.mode === 'verify' : task.role === 'astra' && task.mode === 'verify';
  }

  private canExecute(chat: ChatRecord, task: AgentTask): boolean {
    if (chat.apiRoster) return Boolean(taskSeat(chat, task)?.can.exec) && task.mode !== 'read' && this.commandInfo().length > 0;
    if (chat.cliRoster) return Boolean(taskSeat(chat, task)?.can.exec) && task.mode !== 'read';
    return task.role !== 'claude';
  }

  private canIntegrate(chat: ChatRecord, task: AgentTask): boolean {
    return this.hasExplicitRoster(chat) ? Boolean(taskSeat(chat, task)?.can.integrate) && this.canWriteMain(chat, task) : task.role === 'sol' && task.mode === 'edit';
  }

  private usesFrozenView(chat: ChatRecord, task: AgentTask): boolean {
    return this.hasExplicitRoster(chat) ? task.mode === 'verify' || taskSeat(chat, task)?.kind === 'worker' : task.role === 'astra' || task.role === 'grok';
  }

  commandInfo(): RunnerCommandInfo[] { return this.runner?.commandInfo?.() ?? []; }

  assertWorkspace(workspaceId: string, version?: number): { version: number } {
    const grant = this.registry.assert(workspaceId, version);
    return { version: grant.version };
  }

  /** Prepare a credential-filtered command copy under the already authorized workspace. */
  prepareExec(identity: WorkspaceToolIdentity): ExecWorkspace {
    this.assertIdentity(identity);
    const { chat, task } = identity;
    if (!chat.apiRoster || !taskSeat(chat, task)?.can.exec || task.mode === 'read') throw new Error('该席位和模式没有执行权限');
    const workspace = this.registry.assert(task.workspaceId!, task.workspaceVersion);
    const profile = realpathSync.native(os.homedir());
    const profileRelative = path.relative(workspace.path, profile);
    if (profileRelative === '' || (!path.isAbsolute(profileRelative) && profileRelative !== '..' && !profileRelative.startsWith(`..${path.sep}`))) {
      throw new Error('执行命令不能使用用户配置目录或其上级目录作为工作区');
    }
    const state = this.state(identity);
    if (this.canWriteIsolated(chat, task) && state.working) {
      const source = this.registry.freezeCopy(state.working);
      state.frozenEdit = undefined;
      state.exitConfirmed = false;
      return { copyDir: state.working.path, sourceSnapshotId: source.id, sourceFingerprint: this.snapshotFilesFingerprint(source) };
    }
    const main = this.canWriteMain(chat, task);
    const source = main ? this.freezeWorkspace(chat, state.workspaceId, state.taskId) : state.baseline;
    if (!source) throw new Error('执行命令缺少受管源码基线');
    if (chat.pipeline && task.phase === 'demo' && !Object.keys(source.files).some(file => file.startsWith('demo/'))) {
      throw new DemoSourceMissingError();
    }
    const fingerprint = this.snapshotFilesFingerprint(source);
    const cached = state.execCopy;
    const busy = chat.execJobs?.some(job => job.taskId === task.id && job.state === 'running');
    const changed = cached && !busy ? this.registry.snapshotChanges(source, cached.copy) : undefined;
    if (!cached || !changed ||
      changed.created.length || changed.modified.length || changed.deleted.length) {
      state.execCopy = { source, copy: main ? this.registry.createEditCopy(source) : this.registry.createTestCopy(source) };
    }
    const prepared = state.execCopy!;
    if (main) {
      (state.execWriteCopies ??= new Map()).set(source.id, { source, copy: prepared.copy });
      return { copyDir: prepared.copy.path, sourceSnapshotId: source.id, sourceFingerprint: fingerprint, workCopyId: prepared.copy.id };
    }
    return { copyDir: prepared.copy.path, sourceSnapshotId: source.id, sourceFingerprint: fingerprint, testSnapshotId: prepared.copy.id };
  }

  finishExecWrites(identity: WorkspaceToolIdentity, origin: Omit<ExecWorkspace, 'copyDir'>): IntegrationResult | undefined {
    this.assertIdentity(identity);
    if (!this.canWriteMain(identity.chat, identity.task) || !origin.workCopyId) return undefined;
    const state = this.state(identity);
    const lease = state.execWriteCopies?.get(origin.sourceSnapshotId);
    if (!lease || lease.copy.id !== origin.workCopyId) throw new Error('执行副本已失去主工作区写入绑定');
    const changes = this.registry.snapshotChanges(lease.source, lease.copy);
    this.assertScopedChanges(identity.task, changes);
    if (identity.chat.pipeline && identity.task.phase === 'demo' &&
      [...changes.created, ...changes.modified, ...changes.deleted].some(file => !file.startsWith('demo/'))) {
      throw new Error('Demo 命令对 demo/ 之外的文件有改动，禁止提交');
    }
    if (!changes.created.length && !changes.modified.length && !changes.deleted.length) return undefined;
    const edited = this.registry.freezeExecEdit(lease.copy, lease.source);
    const integration = this.registry.integrateEdit(state.workspaceId, lease.source, edited, [...changes.created, ...changes.modified]);
    this.recordSourceChange(identity, 'sol_write');
    return integration;
  }

  recordExecEvidence(identity: WorkspaceToolIdentity, commandId: string, source: Omit<ExecWorkspace, 'copyDir'>, platform: 'windows' | 'linux', result: ExecResult): void {
    this.assertIdentity(identity);
    const state = this.state(identity);
    if (!identity.chat.apiRoster || !taskSeat(identity.chat, identity.task)?.can.exec) throw new Error('无法登记当前席位的命令回执');
    if (state.tests.some(item => item.ticketId === commandId)) return;
    state.tests.push({
      ...source, platform, ticketId: commandId,
      ok: result.exitCode === 0 && result.exitConfirmed && !result.timedOut && !result.cancelled && !result.outputLimited,
      result: { ticketId: commandId, command: [], removedEnv: [], exitCode: result.exitCode, durationMs: result.durationMs,
        timedOut: result.timedOut, cancelled: result.cancelled, stdoutTail: '', stderrTail: '', spawnError: null, signal: null, pid: null,
        ...(!result.exitConfirmed ? { terminationWarning: '沙箱退出未确认' } : {}) },
    });
  }

  resultReadBaseline(chat: ChatRecord, task: AgentTask): { authority: string; sourceRevision: number } {
    this.assertWorkspace(task.workspaceId!, task.workspaceVersion);
    const binding = this.pipelineBinding(task);
    if (binding?.kind === 'milestone-review') {
      const source = this.registry.loadSnapshot(binding.snapshotId);
      if (source.workspaceId !== task.workspaceId) throw new Error('里程碑评审候选不属于当前工作区');
      return { authority: `workspace:${task.workspaceId}:grant:${task.workspaceVersion}:candidate:${source.id}:${this.snapshotFilesFingerprint(source)}`, sourceRevision: 0 };
    }
    const sourceRevision = this.currentSourceRevision(chat, task.turnId);
    return { authority: `workspace:${task.workspaceId}:grant:${task.workspaceVersion}:source:${sourceRevision}`, sourceRevision };
  }

  /** Check an execution receipt against the current authorized source without creating a new copy. */
  matchesCurrentSource(task: AgentTask, job: Omit<ExecWorkspace, 'copyDir'>): boolean {
    const snapshot = this.registry.loadSnapshot(job.sourceSnapshotId);
    if (snapshot.workspaceId !== task.workspaceId || snapshot.taskId !== task.id ||
      this.snapshotFilesFingerprint(snapshot) !== job.sourceFingerprint) return false;
    this.assertWorkspace(task.workspaceId!, task.workspaceVersion);
    return Object.values(this.registry.workspaceChanges(snapshot)).every(files => files.length === 0);
  }

  async call(name: string, raw: unknown, identity: WorkspaceToolIdentity): Promise<ToolReply> {
    this.assertIdentity(identity);
    if ((this.pendingTests.get(identity.invocation.id)?.length ?? 0) > 0) throw new Error('测试请求已登记，本调用段不能继续使用工具。');
    const { chat, task } = identity;
    const demoEditor = Boolean(chat.pipeline && task.phase === 'demo' && this.canWriteMain(chat, task));
    const missingDemoPath = (file: string, error: unknown) => demoEditor && /^demo(?:$|[\\/])/.test(file) && error instanceof WorkspaceFileMissingError;
    if (name === 'file_list') {
      const input = z.object({ path: z.string().max(2_000).default('') }).strict().parse(raw);
      if (identity.chat.pipeline && input.path && this.isPipelineMetadata(input.path)) throw new Error('.agent 是程序受管目录，模型工具不能直接列出');
      const view = this.view(identity);
      try {
        const files = view ? this.registry.snapshotList(view, input.path) : this.registry.listFiles(task.workspaceId!, input.path);
        return jsonReply(chat.pipeline ? files.filter(file => !this.isPipelineMetadata(file)) : files);
      } catch (error) {
        if (!missingDemoPath(input.path, error)) throw error;
        return jsonReply([]);
      }
    }
    if (name === 'file_read') {
      const input = readInput.parse(raw); const view = this.view(identity);
      if (identity.chat.pipeline && this.isPipelineMetadata(input.path)) throw new Error('.agent 是程序受管目录，模型工具不能直接读取');
      try {
        return jsonReply(view ? this.registry.snapshotRead(view, input.path, input.maxChars, input.offset) : this.registry.read(task.workspaceId!, input.path, input.maxChars, input.offset));
      } catch (error) {
        if (!missingDemoPath(input.path, error)) throw error;
        return jsonReply({ exists: false, path: input.path, hash: null });
      }
    }
    if (name === 'file_search') {
      const { query } = z.object({ query: z.string().min(1).max(500) }).strict().parse(raw); const view = this.view(identity);
      const results = view ? this.registry.snapshotSearch(view, query) : this.registry.search(task.workspaceId!, query);
      return jsonReply(identity.chat.pipeline ? results.filter(result => !this.isPipelineMetadata(result.path)) : results);
    }
    if (name === 'file_write') {
      const input = z.object({ path: pathInput, text: z.string().max(2_000_000), expectedHash: z.string().regex(/^[0-9a-f]{64}$/i).nullable() }).strict().parse(raw);
      if (identity.chat.pipeline && this.isPipelineMetadata(input.path)) throw new Error('.agent 是程序受管目录，模型工具不能直接写入');
      const milestonePaths = this.milestonePaths(task);
      if (milestonePaths && !this.pathAllowed(input.path, milestonePaths)) throw new Error(`里程碑写入越出声明路径：${input.path}`);
      if (this.canWriteIsolated(identity.chat, task)) {
        const state = this.state(identity);
        if (state.integrated) throw new Error('已集成的编辑任务不能继续修改。');
        const result = this.registry.snapshotWrite(state.working!, input.path, input.text, input.expectedHash);
        // 新修改使此前冻结快照和测试证据失效，必须重新退出、冻结并测试。
        state.frozenEdit = undefined; state.exitConfirmed = false; state.tests = [];
        return jsonReply(result);
      }
      if (this.canWriteMain(identity.chat, task)) {
        if (demoEditor && !input.path.replaceAll('\\', '/').startsWith('demo/')) {
          throw new Error('Demo 只能写入 demo/ 目录');
        }
        this.state(identity);
        const result = demoEditor
          ? this.registry.writeManagedFile(task.workspaceId!, input.path, input.text, input.expectedHash)
          : this.registry.write(task.workspaceId!, input.path, input.text, input.expectedHash);
        if (result.created || result.hash !== input.expectedHash) this.recordSourceChange(identity, 'sol_write');
        return jsonReply(result);
      }
      throw new Error('当前角色或任务模式没有文件写入权限。');
    }
    if (name === 'workspace_changes') {
      const { taskId } = z.object({ taskId: z.string().optional() }).strict().parse(raw);
      const state = taskId ? this.otherState(identity, taskId) : this.state(identity);
      return jsonReply(this.changes(state));
    }
    if (name === 'test_submit') {
      if (identity.chat.apiRoster && (!this.canExecute(identity.chat, task) || !['edit', 'verify'].includes(task.mode) || this.commandInfo().length === 0)) {
        throw new Error('当前 API 席位、任务模式或受控命令证明不允许运行测试。');
      }
      if (!identity.chat.apiRoster && !this.canExecute(identity.chat, task)) throw new Error(identity.chat.cliRoster ? '当前席位或任务模式没有测试执行权限。' : 'Claude 统筹角色不直接运行测试。');
      const input = testInput.parse(raw);
      if (path.isAbsolute(input.cwd) || input.cwd.split(/[\\/]+/).some((part) => part === '..' || part.includes(':'))) throw new Error('测试工作目录必须是测试副本内的相对路径。');
      this.state(identity);
      const ticketId = `test-${randomUUID()}`;
      this.pendingTests.set(identity.invocation.id, [{ ticketId, invocationId: identity.invocation.id, ...input }]);
      const reply: ToolReply & { ticketId: string } = { text: `测试请求 ${ticketId} 已登记；宿主将在模型进程确认退出后运行。`, data: { ticketId, status: 'awaiting_process_exit' }, stop: 'wait', ticketId };
      return reply;
    }
    if (name === 'integrate_edit') {
      if (!this.canIntegrate(identity.chat, task)) throw new Error(this.hasExplicitRoster(identity.chat) ? '当前席位没有集成独立编辑的权限。' : '只有 Sol 编辑任务可以集成 Grok 修改。');
      const input = z.object({ taskId: z.string(), allowedFiles: z.array(pathInput).min(1).max(200) }).strict().parse(raw);
      if (identity.chat.pipeline && task.phase === 'demo' && input.allowedFiles.some(file => !file.replaceAll('\\', '/').startsWith('demo/'))) {
        throw new Error('Demo 只能集成到 demo/ 目录');
      }
      // Freeze the Sol task baseline before integration so the program can
      // later derive the real source diff from the safely exited invocation.
      this.state(identity);
      const state = this.otherState(identity, input.taskId);
      const sourceTask = identity.chat.tasks.find((candidate) => candidate.id === input.taskId)!;
      if (!this.canWriteIsolated(identity.chat, sourceTask) || sourceTask.status !== 'completed' || sourceTask.invocationIds.some((id) => {
        const invocation = identity.chat.invocations.find((candidate) => candidate.id === id);
        return !invocation || invocation.status !== 'exited' || invocation.exitConfirmed !== true;
      })) throw new Error('Grok 编辑任务尚未完成或仍有未确认退出的调用段。');
      if (!state.exitConfirmed || !state.frozenEdit) throw new Error('Grok 编辑进程尚未安全退出并冻结。');
      const tests = identity.chat.apiRoster
        ? state.tests.filter(test => test.sourceFingerprint === this.snapshotFilesFingerprint(state.frozenEdit!))
        : state.tests;
      if (!tests.length || tests.some((test) => !test.ok)) throw new Error('Grok 编辑没有真实通过的受控测试证据。');
      if (state.integrated) throw new Error('该编辑快照已经集成。');
      state.integrated = this.registry.integrateEdit(task.workspaceId!, state.baseline!, state.frozenEdit, input.allowedFiles);
      if (state.integrated.changed.length || state.integrated.created.length) this.recordSourceChange(identity, 'sol_integrate');
      return jsonReply({ ...state.integrated, tests: state.tests });
    }
    throw new Error(`未知工作区工具：${name}`);
  }

  async afterInvocation(identity: WorkspaceToolIdentity, exitConfirmed: boolean): Promise<{ ticketId: string; reply: ToolReply }[]> {
    const state = this.taskStates.get(identity.task.id);
    const pending = this.pendingTests.get(identity.invocation.id) ?? [];
    // Runtime invokes this hook for every model segment. Ordinary chats never
    // entered the workspace gateway and must remain a no-op.
    if (!identity.task.workspaceId && !state && !pending.length) return [];
    this.assertIdentity(identity);
    this.pendingTests.delete(identity.invocation.id);
    if (!state && !pending.length) return [];
    if (state) state.exitConfirmed = exitConfirmed;
    if (identity.signal.aborted || identity.task.status === 'cancelled') {
      return pending.map((test) => ({ ticketId: test.ticketId, reply: jsonReply({ ticketId: test.ticketId, ok: false, error: '任务已取消，未启动测试 runner。' }) }));
    }
    if (!exitConfirmed) {
      return pending.map((test) => ({ ticketId: test.ticketId, reply: jsonReply({ ticketId: test.ticketId, ok: false, error: '模型进程退出状态未知，未启动测试 runner。' }) }));
    }
    if (state && this.canWriteIsolated(identity.chat, identity.task) && state.working && !state.frozenEdit) {
      this.assertScopedChanges(identity.task, this.registry.snapshotChanges(state.baseline!, state.working));
      state.frozenEdit = this.registry.freezeCopy(state.working);
    }
    if (state?.baseline) {
      const snapshot = this.canWriteIsolated(identity.chat, identity.task) ? state.frozenEdit
        : this.canWriteMain(identity.chat, identity.task) ? this.freezeWorkspace(identity.chat, state.workspaceId, state.taskId) : undefined;
      if (snapshot) {
        this.queueDiff(identity, state, snapshot);
        const binding = this.pipelineBinding(identity.task);
        if (binding?.kind === 'milestone-author') {
          const fingerprint = this.snapshotFilesFingerprint(snapshot);
          binding.exitSnapshot = { invocationId: identity.invocation.id, snapshotId: snapshot.id, fingerprint };
          state.candidateSnapshotId = snapshot.id;
          state.candidateFingerprint = fingerprint;
        }
      }
    }
    const replies: { ticketId: string; reply: ToolReply }[] = [];
    for (const test of pending) {
      const evidence = await this.runTest(identity, state!, test);
      state!.tests.push(evidence);
      const progressFingerprint = this.testProgressFingerprint(test, evidence);
      const reply: ToolReply & { processExitConfirmed: boolean } = {
        ...jsonReply({
          ticketId: test.ticketId,
          ok: evidence.ok,
          result: evidence.result,
          testSnapshotId: evidence.testSnapshotId,
          sourceSnapshotId: evidence.sourceSnapshotId,
          sourceFingerprint: evidence.sourceFingerprint,
          platform: evidence.platform,
          progressFingerprint,
        }),
        processExitConfirmed: this.runnerProcessExitConfirmed(evidence),
      };
      replies.push({ ticketId: test.ticketId, reply });
    }
    return replies;
  }

  async takeArtifacts(identity: WorkspaceToolIdentity): Promise<WorkspaceDiffArtifact[]> {
    const artifacts = this.pendingArtifacts.get(identity.invocation.id) ?? [];
    if (!identity.task.workspaceId && !artifacts.length) return [];
    this.assertIdentity(identity);
    this.pendingArtifacts.delete(identity.invocation.id);
    return artifacts;
  }

  completionIssues(chat: ChatRecord, task: AgentTask): string[] {
    if (task.parentTaskId || task.role !== chatRoster(chat).rootSeat) return [];
    const requiredRevision = this.currentSourceRevision(chat, task.turnId);
    if (!requiredRevision) return [];
    if (chat.team && !chat.team.requireAcceptanceReview) return [];
    const candidates = chat.tasks
      .filter((candidate) => candidate.turnId === task.turnId && this.canAccept(chat, candidate))
      .map((candidate) => ({ task: candidate, state: this.taskStates.get(candidate.id) }))
      .filter((candidate): candidate is { task: AgentTask; state: TaskWorkspaceState } => Boolean(candidate.state))
      .filter((candidate) => candidate.state.sourceRevisionAtFreeze >= requiredRevision && candidate.state.baseline);
    if (!candidates.length) {
      return [chat.team
        ? `本轮源码已修改，但尚无${this.acceptanceLabel(chat)}针对最新源码创建的冻结验证快照。`
        : '本轮源码已由 Sol 修改，但尚无 Astra 针对最新集成后源码创建的冻结验证快照。'];
    }
    const evaluated = candidates.map((candidate) => this.astraCompletionIssues(chat, candidate.task, candidate.state));
    return evaluated.find((issues) => issues.length === 0) ?? evaluated.sort((left, right) => left.length - right.length)[0]!;
  }

  private state(identity: Omit<WorkspaceToolIdentity, 'signal'>): TaskWorkspaceState {
    const existing = this.taskStates.get(identity.task.id);
    if (existing) {
      if (existing.activeInvocationId !== identity.invocation.id) {
        existing.activeInvocationId = identity.invocation.id;
        existing.exitConfirmed = false;
      }
      return existing;
    }
    const workspaceId = identity.task.workspaceId!; const version = identity.task.workspaceVersion!;
    const binding = this.pipelineBinding(identity.task);
    if (binding?.kind === 'milestone-review') {
      const source = this.registry.loadSnapshot(binding.snapshotId);
      if (source.workspaceId !== workspaceId) throw new Error('里程碑评审候选不属于当前工作区');
      const baseline = this.registry.cloneReadOnlySnapshot(source, identity.task.id);
      const state: TaskWorkspaceState = {
        chatId: identity.chat.id, taskId: identity.task.id, workspaceId, workspaceVersion: version,
        turnId: identity.task.turnId, sourceRevisionAtFreeze: 0, activeInvocationId: identity.invocation.id,
        baseline, candidateSnapshotId: source.id, candidateFingerprint: this.snapshotFilesFingerprint(source), tests: [],
      };
      this.taskStates.set(identity.task.id, state);
      return state;
    }
    if (binding?.kind === 'milestone-author' && binding.baselineSnapshotId) {
      const baseline = this.registry.loadSnapshot(binding.baselineSnapshotId);
      if (baseline.workspaceId !== workspaceId || baseline.taskId !== identity.task.id || baseline.kind !== 'baseline') {
        throw new Error('里程碑作者持久化基线身份无效');
      }
      let working: WorkspaceSnapshot | undefined;
      if (binding.editSnapshotId) {
        working = this.registry.loadSnapshot(binding.editSnapshotId);
        if (working.workspaceId !== workspaceId || working.taskId !== identity.task.id || working.kind !== 'edit' || working.sourceSnapshotId !== baseline.id) {
          throw new Error('里程碑作者持久化编辑副本身份无效');
        }
      }
      if (this.canWriteIsolated(identity.chat, identity.task) !== Boolean(working)) {
        throw new Error('里程碑作者持久化副本与席位权限不一致');
      }
      const exitConfirmed = identity.task.invocationIds.length > 0 && identity.task.invocationIds.every(id => {
        const invocation = identity.chat.invocations.find(item => item.id === id);
        return invocation?.taskId === identity.task.id && invocation.status === 'exited' && invocation.exitConfirmed === true;
      });
      const exit = exitConfirmed ? binding.exitSnapshot : undefined;
      const candidate = exit && this.registry.loadSnapshot(exit.snapshotId);
      if (candidate && (exit.invocationId !== identity.task.invocationIds.at(-1) || candidate.workspaceId !== workspaceId ||
        candidate.taskId !== identity.task.id || candidate.kind !== (working ? 'edit' : 'baseline') ||
        (working && candidate.sourceSnapshotId !== baseline.id) || this.snapshotFilesFingerprint(candidate) !== exit.fingerprint)) {
        throw new Error('里程碑作者退出快照的身份或指纹不一致');
      }
      let frozenEdit: WorkspaceSnapshot | undefined;
      if (working && exitConfirmed) {
        if (candidate) frozenEdit = candidate;
        else {
          this.assertScopedChanges(identity.task, this.registry.snapshotChanges(baseline, working));
          frozenEdit = this.registry.freezeCopy(working);
        }
      }
      const state: TaskWorkspaceState = {
        chatId: identity.chat.id,
        taskId: identity.task.id,
        workspaceId,
        workspaceVersion: version,
        turnId: identity.task.turnId,
        sourceRevisionAtFreeze: this.currentSourceRevision(identity.chat, identity.task.turnId),
        activeInvocationId: identity.invocation.id,
        baseline,
        ...(working ? { working } : {}),
        ...(frozenEdit ? { frozenEdit } : {}),
        ...(candidate ? { candidateSnapshotId: candidate.id, candidateFingerprint: exit!.fingerprint } : {}),
        ...(exitConfirmed ? { exitConfirmed: true } : {}),
        tests: [],
      };
      this.taskStates.set(identity.task.id, state);
      return state;
    }
    const parent = identity.task.parentTaskId ? identity.chat.tasks.find((candidate) => candidate.id === identity.task.parentTaskId) : undefined;
    let inheritedBaseline: WorkspaceSnapshot | undefined;
    let inheritedRevision: number | undefined;
    if (
      taskSeat(identity.chat, identity.task)?.kind === 'worker' && ['read', 'verify'].includes(identity.task.mode) &&
      parent && this.canAccept(identity.chat, parent)
    ) {
      if (parent.workspaceId !== workspaceId || parent.workspaceVersion !== version) throw new Error('父子验收任务的工作区授权不一致。');
      let parentState = this.taskStates.get(parent.id);
      if (!parentState) {
        const revision = this.currentSourceRevision(identity.chat, parent.turnId);
        parentState = {
          chatId: identity.chat.id,
          taskId: parent.id,
          workspaceId,
          workspaceVersion: version,
          turnId: parent.turnId,
          sourceRevisionAtFreeze: revision,
          activeInvocationId: parent.invocationIds.at(-1),
          baseline: this.freezeWorkspace(identity.chat, workspaceId, parent.id),
          tests: [],
        };
        this.taskStates.set(parent.id, parentState);
      }
      if (!parentState.baseline) {
        throw new Error(identity.chat.team
          ? `父${this.acceptanceLabel(identity.chat, parent)}任务没有可继承的冻结基线。`
          : '父 Astra 验收任务没有可继承的冻结基线。');
      }
      inheritedBaseline = this.registry.cloneReadOnlySnapshot(parentState.baseline, identity.task.id);
      inheritedRevision = parentState.sourceRevisionAtFreeze;
    }
    const state: TaskWorkspaceState = {
      chatId: identity.chat.id,
      taskId: identity.task.id,
      workspaceId,
      workspaceVersion: version,
      turnId: identity.task.turnId,
      sourceRevisionAtFreeze: inheritedRevision ?? this.currentSourceRevision(identity.chat, identity.task.turnId),
      activeInvocationId: identity.invocation.id,
      tests: [],
    };
    if (inheritedBaseline) {
      state.baseline = inheritedBaseline;
    } else if (this.canWriteIsolated(identity.chat, identity.task)) {
      state.baseline = this.freezeWorkspace(identity.chat, workspaceId, identity.task.id);
      state.working = this.registry.createEditCopy(state.baseline);
    } else if (this.usesFrozenView(identity.chat, identity.task) || this.canWriteMain(identity.chat, identity.task)) {
      state.baseline = this.freezeWorkspace(identity.chat, workspaceId, identity.task.id);
    }
    this.taskStates.set(identity.task.id, state);
    return state;
  }

  private view(identity: WorkspaceToolIdentity): WorkspaceSnapshot | undefined {
    const state = this.state(identity);
    if (this.canWriteIsolated(identity.chat, identity.task)) return state.working;
    if (this.usesFrozenView(identity.chat, identity.task)) return state.baseline;
    return undefined;
  }

  private otherState(identity: WorkspaceToolIdentity, taskId: string): TaskWorkspaceState {
    const task = identity.chat.tasks.find((candidate) => candidate.id === taskId);
    const state = this.taskStates.get(taskId);
    if (!task || !state || state.chatId !== identity.chat.id || state.workspaceId !== identity.task.workspaceId) throw new Error('同一聊天中没有该受管工作区任务。');
    return state;
  }

  private changes(state: TaskWorkspaceState): WorkspaceChanges {
    if (!state.baseline) return { modified: [], created: [], deleted: [] };
    if (state.working) return this.registry.snapshotChanges(state.baseline, state.working);
    return this.registry.workspaceChanges(state.baseline);
  }

  private async runTest(identity: WorkspaceToolIdentity, state: TaskWorkspaceState, pending: PendingTest): Promise<TestEvidence> {
    if (!this.runner) return { ticketId: pending.ticketId, ok: false, result: { error: '受控测试 runner 未配置。' } };
    let source: WorkspaceSnapshot | undefined;
    try {
      source = state.frozenEdit ?? state.baseline;
      if (this.canWriteMain(identity.chat, identity.task)) source = this.freezeWorkspace(identity.chat, state.workspaceId, state.taskId);
      if (!source) throw new Error('没有可测试的冻结源码快照。');
      const testSnapshot = this.registry.createTestCopy(source);
      const spec: CommandSpec = {
        executable: pending.executable,
        args: pending.args,
        cwd: path.resolve(testSnapshot.path, pending.cwd),
        env: pending.env,
        timeoutMs: pending.timeoutMs,
        network: 'none',
        platform: pending.platform ?? this.runner.capability.platform,
      };
      const runnerTicket = this.runner.issueTicket(identity.invocation.id, spec, testSnapshot.path);
      const result = await this.runner.run(runnerTicket, identity.invocation.id, identity.signal);
      const ok = result.exitCode === 0 && !result.spawnError && !result.timedOut && !result.cancelled && !result.terminationWarning;
      return {
        ticketId: pending.ticketId,
        ok,
        result,
        testSnapshotId: testSnapshot.id,
        sourceSnapshotId: source.id,
        sourceFingerprint: this.snapshotFilesFingerprint(source),
        platform: spec.platform,
      };
    } catch (error) {
      return {
        ticketId: pending.ticketId,
        ok: false,
        result: { error: error instanceof Error ? error.message : String(error) },
        platform: pending.platform ?? this.runner.capability.platform,
        ...(source ? { sourceSnapshotId: source.id, sourceFingerprint: this.snapshotFilesFingerprint(source) } : {}),
      };
    }
  }

  private assertIdentity(identity: Omit<WorkspaceToolIdentity, 'signal'>): void {
    const { task, chat, invocation } = identity;
    if (!task.workspaceId || task.workspaceId !== chat.workspaceId || task.workspaceVersion === undefined) throw new Error('任务没有有效的工作区授权身份。');
    if (invocation.taskId !== task.id || !task.invocationIds.includes(invocation.id)) throw new Error('工具调用身份与任务调用段不匹配。');
    this.registry.assert(task.workspaceId, task.workspaceVersion);
  }

  private recordSourceChange(identity: WorkspaceToolIdentity, kind: SourceChange['kind']): void {
    const revisions = identity.chat.sourceRevisions ??= {};
    const revision = (revisions[identity.task.turnId] ?? 0) + 1;
    revisions[identity.task.turnId] = revision;
    this.sourceChanges.push({
      chatId: identity.chat.id,
      turnId: identity.task.turnId,
      taskId: identity.task.id,
      revision,
      kind,
    });
  }

  private currentSourceRevision(chat: ChatRecord, turnId: string): number {
    return chat.sourceRevisions?.[turnId] ?? 0;
  }

  private acceptanceLabel(chat: ChatRecord, task?: AgentTask): string {
    if (!chat.team) return 'Astra';
    if (task) return `独立验收席位（${task.role}）`;
    const reviewers = chat.team.members.filter((member) => member.role === 'reviewer').map((member) => member.seatId);
    return reviewers.length ? `独立验收席位（${reviewers.join(' / ')}）` : '独立验收席位';
  }

  private astraCompletionIssues(chat: ChatRecord, task: AgentTask, state: TaskWorkspaceState): string[] {
    const issues: string[] = [];
    const label = this.acceptanceLabel(chat, task);
    const sep = chat.team ? '' : ' ';
    if (task.status !== 'completed') issues.push(`${label}${sep}验证任务未完成：${task.status}。`);
    const invocations = task.invocationIds.map((id) => chat.invocations.find((candidate) => candidate.id === id));
    if (!invocations.length || invocations.some((invocation) => !invocation || invocation.status !== 'exited' || invocation.exitConfirmed !== true)) {
      issues.push(`${label}${sep}验证仍有调用段未确认安全退出。`);
    }
    if (!state.exitConfirmed) issues.push(`${label}${sep}最新验证调用段的退出状态尚未确认。`);
    const tests = state.baseline ? state.tests.filter((evidence) => evidence.sourceSnapshotId === state.baseline!.id) : [];
    if (!tests.length) issues.push(`${label}${sep}尚未在最新冻结源码快照上运行真实测试。`);
    const failed = tests.filter((evidence) => !evidence.ok);
    if (failed.length) {
      const detail = failed.map((evidence) => {
        if ('error' in evidence.result) return evidence.result.error;
        return `exit=${evidence.result.exitCode}${evidence.result.timedOut ? ', timedOut' : ''}${evidence.result.cancelled ? ', cancelled' : ''}${evidence.result.stderrTail ? `, stderr=${evidence.result.stderrTail.slice(-300)}` : ''}`;
      }).join('；');
      issues.push(`${label}${sep}真实测试未通过：${detail}`);
    }
    if (state.baseline) {
      try {
        const drift = this.registry.workspaceChanges(state.baseline);
        const paths = [...drift.modified, ...drift.created, ...drift.deleted];
        if (paths.length) issues.push(`${label}${sep}验证后原项目哈希已漂移：${paths.join(', ')}。`);
      } catch (error) {
        issues.push(`无法复核${sep}${label}${sep}验证后的原项目哈希：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return issues;
  }

  private runnerProcessExitConfirmed(evidence: TestEvidence): boolean {
    if (!('exitCode' in evidence.result)) return true;
    return !evidence.result.terminationWarning && !evidence.result.spawnError;
  }

  private queueDiff(identity: WorkspaceToolIdentity, state: TaskWorkspaceState, after: WorkspaceSnapshot): void {
    const report = this.registry.snapshotDiff(state.baseline!, after);
    if (!report.files.length || report.fingerprint === state.lastDiffFingerprint) return;
    state.lastDiffFingerprint = report.fingerprint;
    const artifact: WorkspaceDiffArtifact = {
      name: `workspace-diff-${identity.task.id}-segment-${identity.invocation.segment}.diff`,
      text: report.text,
      kind: 'diff',
      binding: { beforeSnapshotId: report.beforeSnapshotId, afterSnapshotId: report.afterSnapshotId },
    };
    this.pendingArtifacts.set(identity.invocation.id, [artifact]);
  }

  private snapshotFilesFingerprint(snapshot: WorkspaceSnapshot): string {
    return createHash('sha256')
      .update(JSON.stringify(Object.entries(snapshot.files).sort(([left], [right]) => left.localeCompare(right))))
      .digest('hex');
  }

  private testProgressFingerprint(test: PendingTest, evidence: TestEvidence): string {
    const result = 'exitCode' in evidence.result
      ? {
          ok: evidence.ok,
          exitCode: evidence.result.exitCode,
          signal: evidence.result.signal,
          timedOut: evidence.result.timedOut,
          cancelled: evidence.result.cancelled,
          spawnError: evidence.result.spawnError ? 'spawn_error' : null,
          terminationUnknown: Boolean(evidence.result.terminationWarning),
        }
      : { ok: evidence.ok, error: 'runner_error' };
    const stable = {
      sourceFingerprint: evidence.sourceFingerprint ?? null,
      command: {
        platform: evidence.platform ?? test.platform ?? null,
        executable: test.executable,
        args: test.args,
        cwd: (test.cwd || '.').replaceAll('\\', '/'),
        env: Object.fromEntries(Object.entries(test.env).sort(([left], [right]) => left.localeCompare(right))),
      },
      result,
    };
    return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
  }
}
