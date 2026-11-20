import { createHash } from 'node:crypto';
import type { ChatStore } from '../chat/store.js';
import type { AgentTask, ChatRecord } from '../chat/types.js';
import { readExecReceipt } from '../exec/records.js';
import type { TaskExecJob } from '../exec/types.js';
import { architectureArtifact } from './architecture.js';
import { ContractSubmissionZ, type FrozenContract } from './contract.js';
import type { ImplementationState, ManagedPipelineFile, MilestoneCheck, MilestoneProof } from './implementation-types.js';
import type { PipelineContractLink } from './state.js';

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Load the exact M6 contract and approved documents, with original byte pins. */
export function readImplementationContract(store: ChatStore, chat: ChatRecord): FrozenContract {
  const link = chat.pipeline?.contract;
  if (!link) throw new Error('流水线缺少关卡 A 的冻结契约');
  return readFrozenPipelineContract(store, chat.id, link);
}

export function readFrozenPipelineContract(store: ChatStore, chatId: string, link: PipelineContractLink): FrozenContract {
  const bytes = store.readBlob(chatId, link.ref);
  if (sha256(bytes) !== link.hash || link.hash !== link.contractSha256) throw new Error('冻结契约内容与关卡 A 记录不一致');
  const value = JSON.parse(bytes.toString('utf8')) as Omit<FrozenContract, 'sha256'>;
  if (value.version !== 1) throw new Error('冻结契约版本不可读');
  ContractSubmissionZ.parse({ requirements: value.requirements, acceptance: value.acceptance, assumptions: value.assumptions });
  return { ...value, sha256: link.contractSha256 };
}

/** Prepare verified frozen artifacts for the product repo before any author starts. */
export function implementationDocuments(store: ChatStore, chat: ChatRecord): ManagedPipelineFile[] {
  const contract = readImplementationContract(store, chat);
  const pipeline = chat.pipeline!;
  const architecture = chat.tasks.find(task => task.id === pipeline.architectureTaskId);
  const guide = architecture && architectureArtifact(chat, architecture, pipeline, 'DEV_GUIDE.md', 'astra');
  if (!guide) throw new Error('冻结的 Astra 开发指南不可读');
  return [...contract.artifacts, { name: guide.name, ref: guide.relativePath, sha256: guide.hash },
    { name: 'CONTRACT.json', ref: pipeline.contract!.ref, sha256: contract.sha256 }].map(item => {
    const bytes = store.readBlob(chat.id, item.ref);
    if (sha256(bytes) !== item.sha256) throw new Error(`冻结文件与登记哈希不一致：${item.name}`);
    return { path: `docs/${item.name}`, text: bytes.toString('utf8') };
  });
}

export function approvedProposal(state: ImplementationState) {
  return state.proposals.find(proposal => proposal.hash === state.planHash && proposal.review?.outcome === 'passed');
}

/** Tool input alone is never a receipt. Match a sealed sandbox job to each exact check. */
export function commandProof(store: ChatStore, chat: ChatRecord, task: AgentTask,
  check: MilestoneCheck, fingerprint?: string, onlyJobId?: string): MilestoneProof | undefined {
  const candidates = (chat.execJobs ?? []).filter(job => job.taskId === task.id && job.state === 'finished'
    && job.backend === 'docker' && !job.uiAcceptanceId && job.purpose === 'test' && job.receiptRef && job.command?.cwd === check.cwd
    && job.command.timeoutMs === check.timeoutMs && JSON.stringify(job.command.argv) === JSON.stringify(check.argv)
    && (!fingerprint || fingerprint === job.sourceFingerprint)
    && (!onlyJobId || job.id === onlyJobId));
  const job = candidates.at(-1);
  return job && sealProof(store, chat, job, check.id);
}

export function sealProof(store: ChatStore, chat: ChatRecord, job: TaskExecJob, checkId: string): MilestoneProof | undefined {
  const ref = job.receiptRef;
  const registered = ref && chat.toolResults?.find(item => item.taskId === job.taskId && item.name === 'exec' && item.ref === ref);
  if (!ref || !registered) return undefined;
  const receipt = JSON.parse(readExecReceipt(store, chat, job)) as { ok: boolean; result: { network: string; exitConfirmed: boolean } };
  return { checkId, ref, hash: registered.hash, snapshotId: job.sourceSnapshotId, fingerprint: job.sourceFingerprint,
    ok: receipt.ok && receipt.result.network === 'none' && receipt.result.exitConfirmed };
}

/** Contract commands are interpreted only inside Docker, never through a host shell. */
export function commandAcceptances(contract: FrozenContract): MilestoneCheck[] {
  return contract.acceptance.filter(item => item.kind === 'command').map(item => ({
    id: item.id, acceptanceIds: [item.id], argv: ['sh', '-lc', item.command!], cwd: '.', timeoutMs: 60_000,
  }));
}
