import type { AgentTask, ChatArtifact, ChatRecord, PlanStep } from '../chat/types.js';
import type { ChatStore } from '../chat/store.js';
import { hasFullPageChain } from '../chat/execution.js';
import { updatePlan } from '../chat/plans.js';
import { readExecReceipt } from '../exec/records.js';
import type { TaskExecJob } from '../exec/types.js';
import type { PipelineState } from './state.js';

const architectureSteps = [
  { key: 'cluster', text: '完成一次完整架构集群并核对增量建议', verification: { kind: 'task' } },
  { key: 'prd', text: '发布含需求和验收编号的 PRD', verification: { kind: 'artifact', name: 'PRD.md' } },
  { key: 'architecture', text: '发布同一份技术架构', verification: { kind: 'artifact', name: 'ARCHITECTURE.md' } },
  { key: 'guide', text: '由 Astra 发布开发指南', verification: { kind: 'artifact', name: 'DEV_GUIDE.md' } },
  { key: 'demo', text: '由 Sol 实现并实际运行核心路径 Demo', verification: { kind: 'task' } },
  { key: 'contract', text: '冻结需求及验收契约', verification: { kind: 'artifact', name: 'CONTRACT.json' } },
] as const;

export type ArchitectureStep = (typeof architectureSteps)[number]['key'];

/** Program-owned step IDs remain stable within a revision. Earlier revisions keep their evidence. */
export function architectureStepId(revision: number, key: ArchitectureStep): string {
  return `arch-${revision}-${key}`;
}

const reuseTool = 'architecture_cluster_reuse';

export function newArchitecturePlan(taskId: string, revision: number, now: string, carriesCluster = false): PlanStep[] {
  return architectureSteps.map((step, index) => ({
    id: architectureStepId(revision, step.key), taskId, text: step.text, status: index ? 'pending' : 'in_progress',
    dependsOn: index ? [architectureStepId(revision, architectureSteps[index - 1]!.key)] : [],
    linkedTaskIds: [], evidenceRefs: [], updatedAt: now,
    verification: step.key === 'cluster' && carriesCluster ? { kind: 'tool', toolName: reuseTool } : step.verification,
  }));
}

/** Retain the exact reviewed synthesis input without replaying the earlier cluster. */
export function carryArchitectureCluster(chat: ChatRecord, state: PipelineState, previous: AgentTask, root: AgentTask, previousRevision: number) {
  delete state.carriedClusterId;
  const witness = chat.todos?.find(step => step.id === architectureStepId(previousRevision, 'cluster') && step.taskId === previous.id && step.status === 'completed');
  const cluster = state.clusters.find(item => item.summaryRef && witness?.evidenceRefs.includes(item.summaryRef));
  const receipt = chat.toolResults?.find(item => item.name === 'cluster_result' && item.ref === cluster?.summaryRef && item.hash === cluster?.summaryHash);
  if (!cluster || !receipt) return false;
  state.carriedClusterId = cluster.id;
  chat.toolResults!.push({ ...receipt, taskId: root.id, name: reuseTool });
  return true;
}

/** Verify authorship and choose the most recently registered matching artifact of this revision. */
export function architectureArtifact(chat: ChatRecord, root: AgentTask, state: PipelineState, name: string, author: 'root' | 'astra' | 'sol'): ChatArtifact | undefined {
  const revisionTurn = state.revisionStartedAt ?? root.createdAt;
  const candidates = new Set(author === 'root' ? [root.id] : chat.tasks.filter(task =>
    task.parentTaskId === root.id && task.role === author && task.status === 'completed' && !task.executionReviewOfTaskId &&
    (author === 'sol' ? task.phase === 'demo' && task.mode === 'edit' : task.phase === 'architecture')).map(task => task.id));
  return chat.artifacts.filter(artifact => artifact.name === name && artifact.bytes > 0 && artifact.createdAt >= revisionTurn && candidates.has(artifact.taskId)).at(-1);
}

/** Require the complete, acknowledged reference pages at the current baseline. */
export function clusterReadIssues(chat: ChatRecord, task: AgentTask, authority: string): string[] {
  if (!task.clusterId) return [];
  const slot = chat.pipeline?.clusters.find(cluster => cluster.id === task.clusterId)?.waves
    .flatMap(wave => wave.tasks).find(item => item.taskId === task.id);
  if (!slot) return ['集群子任务缺少调度绑定'];
  return slot.reads.filter(read => !hasFullPageChain(task, read.ref, read.hash, authority))
    .map(read => `先使用 result_read 完整接收集群备忘录 ${read.ref}`);
}

/** A Demo report must cite a passing isolated command for the latest source revision. */
export function architectureDemoEvidence(chat: ChatRecord, root: AgentTask, state: PipelineState, store: ChatStore,
  currentSource: (task: AgentTask, job: TaskExecJob) => boolean) {
  const report = architectureArtifact(chat, root, state, 'DEMO_REPORT.md', 'sol');
  if (!report) return undefined;
  const task = chat.tasks.find(item => item.id === report.taskId)!;
  const body = store.readBlob(chat.id, report.relativePath).toString('utf8');
  const revision = chat.sourceRevisions?.[root.turnId] ?? 0;
  const job = chat.execJobs?.find(item => {
    if (item.taskId !== report.taskId || item.state !== 'finished' || item.purpose !== 'test' || !item.receiptRef ||
      item.sourceRevision !== revision || item.backend === 'local-unsafe' || !body.includes(item.receiptRef)) return false;
    try { return JSON.parse(readExecReceipt(store, chat, item)).ok === true && currentSource(task, item); }
    catch { return false; }
  });
  return job ? { linkedTaskIds: [report.taskId], evidenceRefs: [report.relativePath, job.receiptRef!] } : undefined;
}

/** Bind immutable artifacts and completed work to the existing execution review plan. */
export function observeArchitecturePlan(chat: ChatRecord, root: AgentTask, state: PipelineState, store: ChatStore,
  authority: string, currentSource: (task: AgentTask, job: TaskExecJob) => boolean) {
  const plan = (chat.todos ?? []).filter(step => step.taskId === root.id);
  const reuse = chat.toolResults?.find(item => item.taskId === root.id && item.name === reuseTool && hasFullPageChain(root, item.ref, item.hash, authority));
  const cluster = state.clusters.find(item => item.rootTaskId === root.id && item.mode === 'full' && item.status === 'completed'
    && !!item.summaryRef && !!item.summaryHash && hasFullPageChain(root, item.summaryRef, item.summaryHash, authority)
    && item.waves.every(wave => wave.tasks.every(slot => !!chat.tasks.find(task => task.id === slot.taskId)?.disposition)));
  const prd = architectureArtifact(chat, root, state, 'PRD.md', 'root');
  const architecture = architectureArtifact(chat, root, state, 'ARCHITECTURE.md', 'root');
  const guide = architectureArtifact(chat, root, state, 'DEV_GUIDE.md', 'astra');
  const contract = state.contract && chat.artifacts.find(artifact => artifact.id === state.contract!.artifactId);
  const artifactEvidence = (artifact: ChatArtifact | undefined) => artifact && { evidenceRefs: [artifact.relativePath] };
  const witnesses = {
    cluster: state.carriedClusterId ? reuse && { evidenceRefs: [reuse.ref] } :
      cluster && { linkedTaskIds: cluster.waves.flatMap(wave => wave.tasks.map(slot => slot.taskId)), evidenceRefs: [cluster.summaryRef!] },
    prd: artifactEvidence(prd),
    architecture: artifactEvidence(architecture),
    guide: artifactEvidence(guide),
    demo: state.contract && architectureDemoEvidence(chat, root, state, store, currentSource),
    contract: artifactEvidence(contract),
  };
  const steps = [];
  for (const { key } of architectureSteps) {
    if (key !== 'cluster' && !state.contract) break;
    const current = plan.find(step => step.id === architectureStepId(state.revision, key));
    if (!current) throw new Error(`冻结架构计划缺少步骤 ${key}`);
    if (current.status === 'completed') continue;
    const witness = witnesses[key];
    if (!witness) break;
    const { taskId: _owner, updatedAt: _time, ...step } = current;
    steps.push({ ...step, ...witness, status: 'completed' });
  }
  if (steps.length) return updatePlan(chat, root, { revision: chat.planRevision ?? 0, steps });
}
