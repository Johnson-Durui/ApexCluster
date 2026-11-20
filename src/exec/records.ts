import { createHash } from 'node:crypto';
import type { ChatStore } from '../chat/store.js';
import type { ChatRecord } from '../chat/types.js';
import type { IntegrationResult } from '../chat/workspace.js';
import { registerExecOutput } from './output.js';
import type { ExecResult, TaskExecJob } from './types.js';

export function readExecReceipt(store: ChatStore, chat: ChatRecord, job: TaskExecJob): string {
  const registered = chat.toolResults?.find(item => item.taskId === job.taskId &&
    item.invocationId === job.invocationId && item.ref === job.receiptRef && item.name === 'exec');
  if (!registered) throw new Error('执行回执缺少登记的作业绑定');
  const bytes = store.readBlob(chat.id, registered.ref);
  if (bytes.length !== registered.bytes || createHash('sha256').update(bytes).digest('hex') !== registered.hash) {
    throw new Error('执行回执内容与登记的哈希不一致');
  }
  return bytes.toString('utf8');
}

/** Seal command output and the exact source identity used at dispatch. */
export function sealExecRecord(store: ChatStore, chat: ChatRecord, job: TaskExecJob, result: ExecResult, directory: string,
  platform: 'windows' | 'linux', integration?: IntegrationResult) {
  if (job.receiptRef) return readExecReceipt(store, chat, job);
  const stdout = registerExecOutput(store, chat.id, job.id, 'stdout', result.stdoutRef, directory);
  const stderr = registerExecOutput(store, chat.id, job.id, 'stderr', result.stderrRef, directory);
  const ok = result.exitCode === 0 && result.exitConfirmed && !result.timedOut && !result.cancelled && !result.outputLimited;
  const receipt = JSON.stringify({
    ok, jobId: job.id, backend: job.backend, purpose: job.purpose, platform,
    sourceSnapshotId: job.sourceSnapshotId, sourceFingerprint: job.sourceFingerprint, testSnapshotId: job.testSnapshotId,
    sourceRevision: job.sourceRevision, command: job.command, uiAcceptanceId: job.uiAcceptanceId,
    workCopyId: job.workCopyId, integration,
    result: { ...result, exitScope: job.backend === 'local-unsafe' ? 'direct-process' : 'sandbox',
      stdoutRef: stdout.relativePath, stderrRef: stderr.relativePath, spawnError: null },
  });
  for (const output of [stdout, stderr]) {
    (chat.toolResults ??= []).push({ taskId: job.taskId, invocationId: job.invocationId, name: 'exec_output', provenance: 'workspace',
      ref: output.relativePath, hash: output.hash, bytes: output.bytes });
  }
  const blob = store.putBlob(chat.id, `exec-${job.id}-receipt.json`, receipt);
  job.receiptRef = blob.relativePath;
  const provenance = result.exitConfirmed && job.purpose === 'test' && job.backend !== 'local-unsafe' ? 'runner' : 'workspace';
  (chat.toolResults ??= []).push({ taskId: job.taskId, invocationId: job.invocationId, name: 'exec', provenance,
    ref: blob.relativePath, hash: blob.hash, bytes: blob.bytes });
  if (provenance === 'runner') {
    const at = new Date().toISOString();
    chat.tickets.push({ id: job.id, taskId: job.taskId, invocationId: job.invocationId, type: 'tool',
      createdAt: at, resolvedAt: at, status: 'resolved', processStatus: 'exited', externalId: job.id, resultRef: blob.relativePath });
  }
  return receipt;
}
