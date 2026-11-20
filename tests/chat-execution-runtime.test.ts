import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ProjectOutputStore } from '../src/artifacts/project-output.js';
import { ChatRuntime, type WorkspaceToolHost } from '../src/chat/runtime.js';
import { createProductionChatRuntime } from '../src/chat/bootstrap.js';
import { materializeExecutionView } from '../src/chat/execution.js';
import { ChatStore } from '../src/chat/store.js';
import { WorkspaceRegistry } from '../src/chat/workspace.js';
import { HttpError } from '../src/orchestrator/errors.js';
import { ChatDriverError } from '../src/chat/drivers.js';
import type { ChatDriver, ChatRole, DriverInput, DriverResult, ToolReply } from '../src/chat/types.js';

const roles: ChatRole[] = ['claude', 'astra', 'sol', 'grok'];
const workRoot = path.resolve('work', 'test-tmp');
const result = (text = ''): DriverResult => ({ text, exitConfirmed: true });

type ReviewRead = {
  contractHash: string;
  evidenceHash: string;
  viewRef: string;
  viewHash: string;
};

function makeDrivers(invoke: (role: ChatRole, input: DriverInput) => Promise<DriverResult>) {
  return Object.fromEntries(roles.map(role => [role, {
    capability: { role, available: true, isolationVerified: true },
    invoke: async (input: DriverInput) => {
      try { return await invoke(role, input); }
      catch (error) {
        if (error instanceof HttpError) throw new ChatDriverError(error.message, true);
        throw error;
      }
    },
  } satisfies ChatDriver])) as Record<ChatRole, ChatDriver>;
}

function fixture(
  invoke: (role: ChatRole, input: DriverInput) => Promise<DriverResult>,
  options: { production?: boolean; root?: string } = {},
) {
  mkdirSync(workRoot, { recursive: true });
  const root = options.root ?? mkdtempSync(path.join(workRoot, 'chat-execution-'));
  const runtimeOptions = { store: new ChatStore(root), drivers: makeDrivers(invoke), handoffMs: 5 };
  const runtime = options.production ? createProductionChatRuntime(runtimeOptions) : new ChatRuntime(runtimeOptions);
  return { root, runtime, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function data<T>(reply: ToolReply): T {
  if (reply.data !== undefined) return reply.data as T;
  return JSON.parse(reply.text) as T;
}

async function readAll(input: DriverInput, ref: string) {
  let offset = 0;
  let body = '';
  for (;;) {
    const reply = await input.callTool('result_read', { ref, offset });
    assert.match(reply.text, /^\[程序分页 offset=\d+ next=(?:\d+|null)\]\n/);
    body += reply.text.slice(reply.text.indexOf('\n') + 1);
    const next = data<{ next: number | null }>(reply).next;
    if (next === null) return body;
    assert.ok(next > offset, 'result_read pagination must advance');
    offset = next;
  }
}

async function submitCurrentReview(
  input: DriverInput,
  outcome: 'passed' | 'failed' | 'insufficient',
  stepIds: string[],
) {
  const execution = data<ReviewRead>(await input.callTool('execution_read', {}));
  const view = JSON.parse(await readAll(input, execution.viewRef)) as { requiredRefs: { ref: string; kind: string }[] };
  for (const ref of new Set(view.requiredRefs.filter(item => item.kind !== 'file').map(item => item.ref))) await readAll(input, ref);
  const report = data<{ id: string; relativePath: string }>(await input.callTool('artifact_publish', {
    name: `execution-review-${outcome}.md`, text: `${outcome} ${execution.contractHash} ${execution.evidenceHash}`, kind: 'report',
  }));
  const reply = data<{ accepted: boolean; code?: string; issues?: string[]; next?: string }>(await input.callTool('execution_submit_review', {
    contractHash: execution.contractHash,
    evidenceHash: execution.evidenceHash,
    outcome,
    stepVerdicts: stepIds.map(stepId => ({ stepId, outcome })),
    reportArtifactId: report.id,
  }));
  return { execution, report, reply };
}

test('production runtime stamps a new root with execution policy v1 while allowing a direct answer', async () => {
  const fx = fixture(async (_role, input) => {
    assert.equal(input.task.executionPolicyVersion, 1);
    await input.callTool('task_complete', { result: 'direct answer' });
    return result();
  }, { production: true });
  try {
    const chat = fx.runtime.create({});
    assert.equal(chat.tasks.length, 0);
    fx.runtime.send(chat.id, { text: 'What is 2 + 2?', clientMessageId: 'simple-v1' });
    await fx.runtime.idle();
    assert.equal(chat.tasks[0]?.executionPolicyVersion, 1);
    assert.equal(chat.tasks[0]?.executionReviewRequired, undefined);
    assert.equal(chat.tasks[0]?.status, 'completed');
  } finally { fx.cleanup(); }
});

test('legacy runtime recovery does not add execution policy v1 to an existing root', async () => {
  const first = fixture(async (_role, input) => {
    await input.callTool('task_complete', { result: 'legacy complete' });
    return result();
  });
  const root = first.root;
  try {
    const chat = first.runtime.create({});
    first.runtime.send(chat.id, { text: 'legacy work', clientMessageId: 'legacy-v1' });
    await first.runtime.idle();
    assert.equal(chat.tasks[0]?.executionPolicyVersion, undefined);

    const recovered = new ChatRuntime({ store: new ChatStore(root), drivers: makeDrivers(async () => result()), handoffMs: 5 });
    recovered.recover();
    assert.equal(recovered.get(chat.id).tasks[0]?.executionPolicyVersion, undefined);
    assert.equal(recovered.get(chat.id).tasks[0]?.status, 'completed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a v1 root cannot complete two verified work steps without an execution review', async () => {
  let rejection: { accepted: boolean; code: string; issues: string[]; next: string } | undefined;
  const fx = fixture(async (_role, input) => {
    await input.callTool('plan_update', { revision: 0, steps: [
      { id: 'implement', text: 'implement requested behavior', status: 'in_progress', verification: { kind: 'artifact', name: 'implementation.txt' } },
      { id: 'verify', text: 'verify requested behavior', status: 'in_progress', verification: { kind: 'artifact', name: 'verification.txt' } },
    ] });
    const first = await input.callTool('artifact_publish', { name: 'implementation.txt', text: 'implementation evidence', kind: 'report' });
    const second = await input.callTool('artifact_publish', { name: 'verification.txt', text: 'verification evidence', kind: 'test' });
    const firstRef = data<{ relativePath: string }>(first).relativePath;
    const secondRef = data<{ relativePath: string }>(second).relativePath;
    await input.callTool('plan_update', { revision: 1, steps: [
      { id: 'implement', text: 'implement requested behavior', status: 'completed', evidenceRefs: [firstRef], verification: { kind: 'artifact', name: 'implementation.txt' } },
      { id: 'verify', text: 'verify requested behavior', status: 'completed', evidenceRefs: [secondRef], verification: { kind: 'artifact', name: 'verification.txt' } },
    ] });
    const reply = await input.callTool('task_complete', { result: 'must not complete' });
    rejection = data<typeof rejection>(reply);
    await input.callTool('task_fail', { reason: 'fixture ends after proving the review gate' });
    return result();
  }, { production: true });
  try {
    const chat = fx.runtime.create({});
    fx.runtime.send(chat.id, { text: 'perform two-step work', clientMessageId: 'unreviewed-v1' });
    await fx.runtime.idle();
    assert.equal(chat.tasks[0]?.executionReviewRequired, true);
    assert.equal(rejection?.accepted, false);
    assert.equal(rejection?.next, 'execution_read');
    assert.ok(rejection?.code);
    assert.ok(rejection?.issues.length);
    assert.equal(chat.tasks[0]?.status, 'failed');
    assert.equal(fx.runtime.store.messages(chat.id).items.some(message => message.role === 'assistant'), false);
  } finally { fx.cleanup(); }
});

test('a v1 root may inspect its execution contract but only a designated Astra reviewer may submit', async () => {
  let rootRead: ReviewRead | undefined;
  let rootSubmitRejected = false;
  const fx = fixture(async (_role, input) => {
    await input.callTool('plan_update', { revision: 0, steps: [{ id: 'work', text: 'do work', status: 'in_progress', verification: { kind: 'artifact', name: 'proof.txt' } }] });
    const artifact = await input.callTool('artifact_publish', { name: 'proof.txt', text: 'proof', kind: 'report' });
    const ref = data<{ relativePath: string }>(artifact).relativePath;
    await input.callTool('plan_update', { revision: 1, steps: [{ id: 'work', text: 'do work', status: 'completed', evidenceRefs: [ref], verification: { kind: 'artifact', name: 'proof.txt' } }] });
    rootRead = data<ReviewRead>(await input.callTool('execution_read', {}));
    await assert.rejects(input.callTool('execution_submit_review', {
      contractHash: 'a'.repeat(64), evidenceHash: 'b'.repeat(64), outcome: 'passed',
      stepVerdicts: [{ stepId: 'work', outcome: 'passed' }], reportArtifactId: 'foreign',
    }), error => {
      rootSubmitRejected = error instanceof HttpError && error.status === 403;
      return rootSubmitRejected;
    });
    await input.callTool('task_fail', { reason: 'permission fixture complete' });
    return result();
  }, { production: true });
  try {
    const chat = fx.runtime.create({});
    fx.runtime.send(chat.id, { text: 'permission boundaries', clientMessageId: 'review-permissions' });
    await fx.runtime.idle();
    assert.match(rootRead!.contractHash, /^[a-f0-9]{64}$/);
    assert.match(rootRead!.evidenceHash, /^[a-f0-9]{64}$/);
    assert.equal(rootSubmitRejected, true);
  } finally { fx.cleanup(); }
});

test('a designated reviewer cannot pass after querying the contract without reading its canonical view', async () => {
  let rootSegments = 0;
  let reviewRejection: { accepted: boolean; issues: string[]; next: string } | undefined;
  const fx = fixture(async (role, input) => {
    const chat = fx.runtime.get(input.chatId);
    if (role === 'astra') {
      const execution = data<ReviewRead>(await input.callTool('execution_read', {}));
      const metadata = data<{ metadataOnly: boolean; contractHash: string; evidenceHash: string }>(await input.callTool('execution_read', { section: 'steps' }));
      assert.equal(metadata.metadataOnly, true);
      assert.equal(metadata.contractHash, execution.contractHash);
      assert.equal(metadata.evidenceHash, execution.evidenceHash);
      const report = data<{ id: string }>(await input.callTool('artifact_publish', {
        name: 'unread-review.md', text: 'claimed pass without reading the canonical view', kind: 'report',
      }));
      reviewRejection = data<typeof reviewRejection>(await input.callTool('execution_submit_review', {
        contractHash: execution.contractHash,
        evidenceHash: execution.evidenceHash,
        outcome: 'passed',
        stepVerdicts: [{ stepId: 'work', outcome: 'passed' }],
        reportArtifactId: report.id,
      }));
      await input.callTool('task_fail', { reason: 'canonical view was not read' });
      return result();
    }

    rootSegments++;
    if (rootSegments === 1) {
      await input.callTool('plan_update', { revision: 0, steps: [{ id: 'work', text: 'produce evidence', status: 'in_progress', verification: { kind: 'artifact', name: 'proof.txt' } }] });
      const proof = data<{ relativePath: string }>(await input.callTool('artifact_publish', { name: 'proof.txt', text: 'proof body', kind: 'report' }));
      await input.callTool('plan_update', { revision: 1, steps: [{ id: 'work', text: 'produce evidence', status: 'completed', evidenceRefs: [proof.relativePath], verification: { kind: 'artifact', name: 'proof.txt' } }] });
      const reviewer = data<{ taskId: string }[]>(await input.callTool('agent_submit', {
        role: 'astra', goal: 'review without complete delivery', mode: 'verify', purpose: 'execution_review',
      }))[0]!;
      await input.callTool('grok_collect', { taskIds: [reviewer.taskId], wait: true });
      return result();
    }

    const reviewer = chat.tasks.find(task => task.parentTaskId === input.task.id)!;
    await input.callTool('grok_collect', { taskIds: [reviewer.id] });
    await input.callTool('grok_disposition', { taskId: reviewer.id, disposition: 'rejected' });
    await input.callTool('task_fail', { reason: 'review was correctly rejected' });
    return result();
  }, { production: true });

  try {
    const chat = fx.runtime.create({});
    fx.runtime.send(chat.id, { text: 'prove full delivery gate', clientMessageId: 'view-read-gate' });
    await fx.runtime.idle();
    assert.equal(reviewRejection?.accepted, false);
    assert.equal(reviewRejection?.next, 'execution_read');
    assert.ok(reviewRejection?.issues.some(issue => /完整读取当前执行视图/.test(issue)));
    assert.equal(chat.tasks[0]?.executionReviewAttempts?.[0]?.review, undefined);
  } finally { fx.cleanup(); }
});

test('a review report written before evidence delivery is rejected without poisoning a later valid submission', async () => {
  let rootSegments = 0;
  let earlyRejection: { accepted: boolean; issues?: string[]; next?: string } | undefined;
  const fx = fixture(async (role, input) => {
    const chat = fx.runtime.get(input.chatId);
    if (role === 'astra') {
      const earlyReport = data<{ id: string }>(await input.callTool('artifact_publish', {
        name: 'premature-review.md', text: 'written before canonical evidence delivery', kind: 'report',
      }));
      const execution = data<ReviewRead>(await input.callTool('execution_read', {}));
      const view = JSON.parse(await readAll(input, execution.viewRef)) as { requiredRefs: { ref: string; kind: string }[] };
      for (const ref of new Set(view.requiredRefs.filter(item => item.kind !== 'file').map(item => item.ref))) await readAll(input, ref);
      const submission = {
        contractHash: execution.contractHash,
        evidenceHash: execution.evidenceHash,
        outcome: 'passed',
        stepVerdicts: [{ stepId: 'work', outcome: 'passed' }],
      } as const;
      earlyRejection = data<typeof earlyRejection>(await input.callTool('execution_submit_review', {
        ...submission, reportArtifactId: earlyReport.id,
      }));
      const validReport = data<{ id: string; relativePath: string }>(await input.callTool('artifact_publish', {
        name: 'post-read-review.md', text: 'written after complete canonical evidence delivery', kind: 'report',
      }));
      const accepted = data<{ accepted: boolean }>(await input.callTool('execution_submit_review', {
        ...submission, reportArtifactId: validReport.id,
      }));
      assert.equal(accepted.accepted, true);
      await input.callTool('task_complete', { result: validReport.relativePath });
      return result();
    }

    rootSegments++;
    if (rootSegments === 1) {
      await input.callTool('plan_update', { revision: 0, steps: [{ id: 'work', text: 'produce ordered proof', status: 'in_progress', verification: { kind: 'artifact', name: 'ordered-proof.txt' } }] });
      const proof = data<{ relativePath: string }>(await input.callTool('artifact_publish', { name: 'ordered-proof.txt', text: 'ordered proof', kind: 'report' }));
      await input.callTool('plan_update', { revision: 1, steps: [{ id: 'work', text: 'produce ordered proof', status: 'completed', evidenceRefs: [proof.relativePath], verification: { kind: 'artifact', name: 'ordered-proof.txt' } }] });
      const reviewer = data<{ taskId: string }[]>(await input.callTool('agent_submit', {
        role: 'astra', goal: 'verify report ordering', mode: 'verify', purpose: 'execution_review',
      }))[0]!;
      await input.callTool('grok_collect', { taskIds: [reviewer.taskId], wait: true });
      return result();
    }

    const reviewer = chat.tasks.find(task => task.executionReviewOfTaskId === input.task.id)!;
    await input.callTool('grok_collect', { taskIds: [reviewer.id] });
    await input.callTool('grok_disposition', { taskId: reviewer.id, disposition: 'adopted' });
    const report = chat.artifacts.find(artifact => artifact.taskId === reviewer.id && artifact.name === 'post-read-review.md')!;
    await readAll(input, report.relativePath);
    await input.callTool('task_complete', { result: 'valid post-read review adopted' });
    return result();
  }, { production: true });

  try {
    const chat = fx.runtime.create({});
    fx.runtime.send(chat.id, { text: 'enforce review report ordering', clientMessageId: 'review-report-order' });
    await fx.runtime.idle();
    assert.equal(earlyRejection?.accepted, false);
    assert.equal(earlyRejection?.next, 'execution_read');
    assert.ok(earlyRejection?.issues?.some(issue => /报告形成前/.test(issue)));
    const root = chat.tasks.find(task => !task.parentTaskId)!;
    assert.equal(root.executionReviewAttempts?.[0]?.review?.outcome, 'passed');
    assert.equal(root.status, 'completed');
  } finally { fx.cleanup(); }
});

test('an execution review subtree cannot own plans or be linked into root work evidence', async () => {
  let rootSegments = 0;
  let reviewerSegments = 0;
  let reviewerPlanDenied = false;
  let helperPlanDenied = false;
  let taskLinkDenied = false;
  let artifactLinkDenied = false;
  const fx = fixture(async (role, input) => {
    const chat = fx.runtime.get(input.chatId);
    if (role === 'sol') {
      await assert.rejects(input.callTool('plan_update', { revision: chat.planRevision ?? 0, steps: [] }), error => {
        helperPlanDenied = error instanceof HttpError && error.status === 403;
        return helperPlanDenied;
      });
      const artifact = data<{ relativePath: string }>(await input.callTool('artifact_publish', {
        name: 'review-helper.txt', text: 'review-only helper evidence', kind: 'report',
      }));
      await input.callTool('task_complete', { result: artifact.relativePath });
      return result();
    }
    if (role === 'astra') {
      reviewerSegments++;
      if (reviewerSegments === 1) {
        await assert.rejects(input.callTool('plan_update', { revision: chat.planRevision ?? 0, steps: [] }), error => {
          reviewerPlanDenied = error instanceof HttpError && error.status === 403;
          return reviewerPlanDenied;
        });
        const helper = data<{ taskId: string }[]>(await input.callTool('agent_submit', {
          role: 'sol', goal: 'read-only helper inside execution review', mode: 'read',
        }))[0]!;
        await input.callTool('grok_collect', { taskIds: [helper.taskId], wait: true });
        return result();
      }
      const helper = chat.tasks.find(task => task.parentTaskId === input.task.id)!;
      await input.callTool('grok_collect', { taskIds: [helper.id] });
      await input.callTool('grok_disposition', { taskId: helper.id, disposition: 'reference' });
      const review = await submitCurrentReview(input, 'passed', ['work']);
      assert.equal(review.reply.accepted, true);
      await input.callTool('task_complete', { result: review.report.relativePath });
      return result();
    }

    rootSegments++;
    if (rootSegments === 1) {
      await input.callTool('plan_update', { revision: 0, steps: [{ id: 'work', text: 'produce root proof', status: 'in_progress', verification: { kind: 'artifact', name: 'root-proof.txt' } }] });
      const proof = data<{ relativePath: string }>(await input.callTool('artifact_publish', { name: 'root-proof.txt', text: 'root proof', kind: 'report' }));
      await input.callTool('plan_update', { revision: 1, steps: [{ id: 'work', text: 'produce root proof', status: 'completed', evidenceRefs: [proof.relativePath], verification: { kind: 'artifact', name: 'root-proof.txt' } }] });
      const reviewer = data<{ taskId: string }[]>(await input.callTool('agent_submit', {
        role: 'astra', goal: 'review with a helper descendant', mode: 'verify', purpose: 'execution_review',
      }))[0]!;
      await input.callTool('grok_collect', { taskIds: [reviewer.taskId], wait: true });
      return result();
    }

    const reviewer = chat.tasks.find(task => task.executionReviewOfTaskId === input.task.id)!;
    const helper = chat.tasks.find(task => task.parentTaskId === reviewer.id)!;
    const helperArtifact = chat.artifacts.find(artifact => artifact.taskId === helper.id)!;
    const revision = chat.planRevision;
    const todos = JSON.stringify(chat.todos);
    await assert.rejects(input.callTool('plan_update', { revision, steps: [{
      id: 'smuggled-task', text: 'smuggle review helper task into root work', status: 'in_progress', linkedTaskIds: [helper.id],
      verification: { kind: 'task' },
    }] }), error => {
      taskLinkDenied = error instanceof HttpError && error.status === 409;
      return taskLinkDenied;
    });
    assert.equal(chat.planRevision, revision);
    assert.equal(JSON.stringify(chat.todos), todos);
    await assert.rejects(input.callTool('plan_update', { revision, steps: [{
      id: 'smuggled-artifact', text: 'smuggle review helper artifact into root work', status: 'in_progress', evidenceRefs: [helperArtifact.relativePath],
      verification: { kind: 'artifact', name: helperArtifact.name },
    }] }), error => {
      artifactLinkDenied = error instanceof HttpError && error.status === 409;
      return artifactLinkDenied;
    });
    assert.equal(chat.planRevision, revision);
    assert.equal(JSON.stringify(chat.todos), todos);
    await input.callTool('grok_collect', { taskIds: [reviewer.id] });
    await input.callTool('grok_disposition', { taskId: reviewer.id, disposition: 'adopted' });
    const report = chat.artifacts.find(artifact => artifact.taskId === reviewer.id && artifact.kind === 'report')!;
    await readAll(input, report.relativePath);
    await input.callTool('task_complete', { result: 'review subtree remained outside the work plan' });
    return result();
  }, { production: true });
  try {
    const chat = fx.runtime.create({});
    fx.runtime.send(chat.id, { text: 'keep review subtree out of work plan', clientMessageId: 'review-subtree-plan' });
    await fx.runtime.idle();
    assert.equal(reviewerPlanDenied, true);
    assert.equal(helperPlanDenied, true);
    assert.equal(taskLinkDenied, true);
    assert.equal(artifactLinkDenied, true);
    assert.equal(chat.tasks.find(task => !task.parentTaskId)?.status, 'completed');
    assert.deepEqual(chat.todos?.map(step => step.id), ['work']);
  } finally { fx.cleanup(); }
});

test('a passing review becomes stale when the root publishes new work evidence', async () => {
  let rootSegments = 0;
  let stale: { accepted: boolean; issues: string[]; next: string } | undefined;
  const fx = fixture(async (role, input) => {
    const chat = fx.runtime.get(input.chatId);
    if (role === 'astra') {
      const review = await submitCurrentReview(input, 'passed', ['work']);
      assert.equal(review.reply.accepted, true);
      await input.callTool('task_complete', { result: review.report.relativePath });
      return result();
    }
    rootSegments++;
    if (rootSegments === 1) {
      await input.callTool('plan_update', { revision: 0, steps: [{ id: 'work', text: 'produce original evidence', status: 'in_progress', verification: { kind: 'artifact', name: 'proof.txt' } }] });
      const proof = data<{ relativePath: string }>(await input.callTool('artifact_publish', { name: 'proof.txt', text: 'original proof', kind: 'report' }));
      await input.callTool('plan_update', { revision: 1, steps: [{ id: 'work', text: 'produce original evidence', status: 'completed', evidenceRefs: [proof.relativePath], verification: { kind: 'artifact', name: 'proof.txt' } }] });
      const reviewer = data<{ taskId: string }[]>(await input.callTool('agent_submit', { role: 'astra', goal: 'review original evidence', mode: 'verify', purpose: 'execution_review' }))[0]!;
      await input.callTool('grok_collect', { taskIds: [reviewer.taskId], wait: true });
      return result();
    }
    const reviewer = chat.tasks.find(task => task.executionReviewOfTaskId === input.task.id)!;
    await input.callTool('grok_collect', { taskIds: [reviewer.id] });
    await input.callTool('grok_disposition', { taskId: reviewer.id, disposition: 'adopted' });
    const report = chat.artifacts.find(artifact => artifact.taskId === reviewer.id)!;
    await readAll(input, report.relativePath);
    await input.callTool('artifact_publish', { name: 'late-evidence.txt', text: 'new evidence after review', kind: 'report' });
    stale = data<typeof stale>(await input.callTool('task_complete', { result: 'stale review must not complete' }));
    await input.callTool('task_fail', { reason: 'fixture confirmed stale evidence gate' });
    return result();
  }, { production: true });
  try {
    const chat = fx.runtime.create({});
    fx.runtime.send(chat.id, { text: 'review then mutate evidence', clientMessageId: 'stale-evidence' });
    await fx.runtime.idle();
    assert.equal(stale?.accepted, false);
    assert.equal(stale?.next, 'execution_read');
    assert.ok(stale?.issues.some(issue => /尚无评审|变化|失效/.test(issue)));
    const root = chat.tasks[0]!;
    const current = materializeExecutionView(chat, root, fx.runtime.store);
    assert.notEqual(current.evidenceHash, root.executionReviewAttempts?.[0]?.evidenceHash);
  } finally { fx.cleanup(); }
});

test('a negative review is immutable and the same hashes cannot create another attempt', async () => {
  let rootSegments = 0;
  let overwrite: { accepted: boolean; issues?: string[] } | undefined;
  let repeated: { accepted: boolean; code?: string } | undefined;
  let changedAttemptCreated = false;
  const fx = fixture(async (role, input) => {
    const chat = fx.runtime.get(input.chatId);
    if (role === 'astra') {
      const review = await submitCurrentReview(input, 'failed', ['work']);
      assert.equal(review.reply.accepted, true);
      overwrite = data<typeof overwrite>(await input.callTool('execution_submit_review', {
        contractHash: review.execution.contractHash,
        evidenceHash: review.execution.evidenceHash,
        outcome: 'passed',
        stepVerdicts: [{ stepId: 'work', outcome: 'passed' }],
        reportArtifactId: review.report.id,
      }));
      await input.callTool('task_complete', { result: 'negative review submitted safely' });
      return result();
    }
    rootSegments++;
    if (rootSegments === 1) {
      await input.callTool('plan_update', { revision: 0, steps: [{ id: 'work', text: 'work under review', status: 'in_progress', verification: { kind: 'artifact', name: 'proof.txt' } }] });
      const proof = data<{ relativePath: string }>(await input.callTool('artifact_publish', { name: 'proof.txt', text: 'proof', kind: 'report' }));
      await input.callTool('plan_update', { revision: 1, steps: [{ id: 'work', text: 'work under review', status: 'completed', evidenceRefs: [proof.relativePath], verification: { kind: 'artifact', name: 'proof.txt' } }] });
      const reviewer = data<{ taskId: string }[]>(await input.callTool('agent_submit', { role: 'astra', goal: 'negative review', mode: 'verify', purpose: 'execution_review' }))[0]!;
      await input.callTool('grok_collect', { taskIds: [reviewer.taskId], wait: true });
      return result();
    }
    const reviewer = chat.tasks.find(task => task.executionReviewOfTaskId === input.task.id)!;
    await input.callTool('grok_collect', { taskIds: [reviewer.id] });
    await input.callTool('grok_disposition', { taskId: reviewer.id, disposition: 'rejected' });
    repeated = data<typeof repeated>(await input.callTool('agent_submit', { role: 'astra', goal: 'same hashes again', mode: 'verify', purpose: 'execution_review' }));
    await input.callTool('artifact_publish', { name: 'corrected-proof.txt', text: 'changed evidence after negative review', kind: 'report' });
    const changed = data<{ taskId: string }[]>(await input.callTool('agent_submit', { role: 'astra', goal: 'review changed evidence', mode: 'verify', purpose: 'execution_review' }));
    changedAttemptCreated = typeof changed[0]?.taskId === 'string';
    await input.callTool('task_fail', { reason: 'negative result retained and changed hashes accepted for a new attempt' });
    return result();
  }, { production: true });
  try {
    const chat = fx.runtime.create({});
    fx.runtime.send(chat.id, { text: 'retain a negative review', clientMessageId: 'negative-immutable' });
    await fx.runtime.idle();
    const root = chat.tasks[0]!;
    assert.equal(overwrite?.accepted, false);
    assert.ok(overwrite?.issues?.some(issue => /不能覆盖/.test(issue)));
    assert.equal(repeated?.accepted, false);
    assert.equal(changedAttemptCreated, true);
    assert.equal(root.executionReviewAttempts?.length, 2);
    assert.equal(root.executionReviewAttempts?.[0]?.review?.outcome, 'failed');
    assert.notEqual(root.executionReviewAttempts?.[1]?.evidenceHash, root.executionReviewAttempts?.[0]?.evidenceHash);
  } finally { fx.cleanup(); }
});

test('a passing review from an unconfirmed reviewer exit cannot complete the root', async () => {
  let reviewAccepted = false;
  const fx = fixture(async (role, input) => {
    if (role === 'astra') {
      const review = await submitCurrentReview(input, 'passed', ['work']);
      reviewAccepted = review.reply.accepted;
      return { text: '', exitConfirmed: false, finishReason: 'exit_unknown' };
    }
    await input.callTool('plan_update', { revision: 0, steps: [{ id: 'work', text: 'produce proof', status: 'in_progress', verification: { kind: 'artifact', name: 'proof.txt' } }] });
    const proof = data<{ relativePath: string }>(await input.callTool('artifact_publish', { name: 'proof.txt', text: 'proof', kind: 'report' }));
    await input.callTool('plan_update', { revision: 1, steps: [{ id: 'work', text: 'produce proof', status: 'completed', evidenceRefs: [proof.relativePath], verification: { kind: 'artifact', name: 'proof.txt' } }] });
    const reviewer = data<{ taskId: string }[]>(await input.callTool('agent_submit', { role: 'astra', goal: 'unsafe exit review', mode: 'verify', purpose: 'execution_review' }))[0]!;
    await input.callTool('grok_collect', { taskIds: [reviewer.taskId], wait: true });
    return result();
  }, { production: true });
  try {
    const chat = fx.runtime.create({});
    fx.runtime.send(chat.id, { text: 'reviewer exit must be confirmed', clientMessageId: 'review-exit-unknown' });
    await fx.runtime.idle();
    assert.equal(reviewAccepted, true);
    assert.equal(chat.tasks.find(task => task.role === 'astra')?.status, 'interrupted');
    assert.notEqual(chat.tasks[0]?.status, 'completed');
    assert.ok(chat.blockedReason);
    assert.equal(fx.runtime.store.messages(chat.id).items.some(message => message.role === 'assistant'), false);
  } finally { fx.cleanup(); }
});

test('a snapshot failure after accepting a passing review blocks the chat instead of completing the root', async () => {
  let rootSegments = 0;
  const fx = fixture(async (role, input) => {
    if (role === 'astra') {
      await submitCurrentReview(input, 'passed', ['work']);
      assert.fail('execution_submit_review must throw when its accepted review snapshot cannot be saved');
    }
    rootSegments++;
    if (rootSegments === 1) {
      await input.callTool('plan_update', { revision: 0, steps: [{ id: 'work', text: 'produce durable proof', status: 'in_progress', verification: { kind: 'artifact', name: 'proof.txt' } }] });
      const proof = data<{ relativePath: string }>(await input.callTool('artifact_publish', { name: 'proof.txt', text: 'durable proof', kind: 'report' }));
      await input.callTool('plan_update', { revision: 1, steps: [{ id: 'work', text: 'produce durable proof', status: 'completed', evidenceRefs: [proof.relativePath], verification: { kind: 'artifact', name: 'proof.txt' } }] });
      const reviewer = data<{ taskId: string }[]>(await input.callTool('agent_submit', { role: 'astra', goal: 'review with injected snapshot failure', mode: 'verify', purpose: 'execution_review' }))[0]!;
      await input.callTool('grok_collect', { taskIds: [reviewer.taskId], wait: true });
    }
    return result();
  }, { production: true });
  const save = fx.runtime.store.save.bind(fx.runtime.store);
  let injected = false;
  fx.runtime.store.save = chat => {
    const acceptedReviewExists = chat.tasks.some(task => task.executionReviewAttempts?.some(attempt => attempt.review?.outcome === 'passed'));
    if (!injected && acceptedReviewExists) { injected = true; throw new Error('injected accepted-review snapshot failure'); }
    return save(chat);
  };
  try {
    const chat = fx.runtime.create({});
    fx.runtime.send(chat.id, { text: 'snapshot failure must fail closed', clientMessageId: 'review-save-failure' });
    await fx.runtime.idle();
    const root = chat.tasks.find(task => !task.parentTaskId)!;
    const reviewer = chat.tasks.find(task => task.executionReviewOfTaskId === root.id)!;
    assert.equal(injected, true);
    assert.ok(chat.blockedReason);
    assert.match(chat.blockedReason!, /评审提交未完整持久化/);
    assert.equal(reviewer.status, 'interrupted');
    assert.notEqual(root.status, 'completed');
    assert.equal(root.disposition, undefined);
    assert.equal(fx.runtime.store.messages(chat.id).items.some(message => message.role === 'assistant'), false);
  } finally {
    fx.runtime.store.save = save;
    fx.cleanup();
  }
});

test('a failed reviewer project export is correctable without poisoning the accepted report or root completion', async () => {
  mkdirSync(workRoot, { recursive: true });
  const rootDirectory = mkdtempSync(path.join(workRoot, 'chat-execution-project-output-'));
  const project = path.join(rootDirectory, 'selected-project');
  mkdirSync(project);
  const registry = new WorkspaceRegistry(path.join(rootDirectory, 'registry'));
  const grant = registry.grantFromNativeSelection(project, registry.issueNativeSelectionRequest());
  const store = new ChatStore(path.join(rootDirectory, 'sessions'));
  const projectOutputs = new ProjectOutputStore(registry);
  const saveProjectOutput = projectOutputs.save.bind(projectOutputs);
  projectOutputs.save = input => {
    if (input.name === 'failed-review.md') throw new Error('injected real project export failure');
    return saveProjectOutput(input);
  };
  const workspace: WorkspaceToolHost = {
    definitions: [],
    assertWorkspace: (id, version) => registry.assert(id, version),
    call: async () => { throw new Error('workspace tools are not used by this fixture'); },
  };
  let runtime!: ChatRuntime;
  let rootSegments = 0;
  let rejected: { accepted: boolean; code?: string; issues?: string[] } | undefined;
  let tampered: { accepted: boolean; code?: string; issues?: string[] } | undefined;
  const drivers = makeDrivers(async (role, input) => {
    const chat = runtime.get(input.chatId);
    if (role === 'astra') {
      const execution = data<ReviewRead>(await input.callTool('execution_read', {}));
      const view = JSON.parse(await readAll(input, execution.viewRef)) as { requiredRefs: { ref: string; kind: string }[] };
      for (const ref of new Set(view.requiredRefs.filter(item => item.kind !== 'file').map(item => item.ref))) await readAll(input, ref);
      const failed = data<{ id: string; projectExport?: { status: string } }>(await input.callTool('artifact_publish', {
        name: 'failed-review.md', text: 'session copy survives failed project export', kind: 'report',
      }));
      assert.equal(failed.projectExport?.status, 'failed');
      const submission = {
        contractHash: execution.contractHash,
        evidenceHash: execution.evidenceHash,
        outcome: 'passed',
        stepVerdicts: [{ stepId: 'work', outcome: 'passed' }],
      } as const;
      rejected = data<typeof rejected>(await input.callTool('execution_submit_review', { ...submission, reportArtifactId: failed.id }));
      const root = chat.tasks.find(task => task.id === input.task.executionReviewOfTaskId)!;
      assert.equal(root.executionReviewAttempts?.[0]?.review, undefined);
      const saved = data<{ id: string; relativePath: string; projectExport?: { status: string } }>(await input.callTool('artifact_publish', {
        name: 'saved-review.md', text: 'verified report saved to selected project', kind: 'report',
      }));
      assert.equal(saved.projectExport?.status, 'saved');
      const accepted = data<{ accepted: boolean }>(await input.callTool('execution_submit_review', { ...submission, reportArtifactId: saved.id }));
      assert.equal(accepted.accepted, true);
      await input.callTool('task_complete', { result: saved.relativePath });
      return result();
    }

    rootSegments++;
    if (rootSegments === 1) {
      await input.callTool('plan_update', { revision: 0, steps: [{ id: 'work', text: 'produce project proof', status: 'in_progress', verification: { kind: 'artifact', name: 'project-proof.txt' } }] });
      const proof = data<{ relativePath: string; projectExport?: { status: string } }>(await input.callTool('artifact_publish', {
        name: 'project-proof.txt', text: 'project proof', kind: 'report',
      }));
      assert.equal(proof.projectExport?.status, 'saved');
      await input.callTool('plan_update', { revision: 1, steps: [{ id: 'work', text: 'produce project proof', status: 'completed', evidenceRefs: [proof.relativePath], verification: { kind: 'artifact', name: 'project-proof.txt' } }] });
      const reviewer = data<{ taskId: string }[]>(await input.callTool('agent_submit', {
        role: 'astra', goal: 'verify project output recovery', mode: 'verify', purpose: 'execution_review',
      }))[0]!;
      await input.callTool('grok_collect', { taskIds: [reviewer.taskId], wait: true });
      return result();
    }

    const reviewer = chat.tasks.find(task => task.executionReviewOfTaskId === input.task.id)!;
    await input.callTool('grok_collect', { taskIds: [reviewer.id] });
    const report = chat.artifacts.find(artifact => artifact.taskId === reviewer.id && artifact.name === 'saved-review.md')!;
    await readAll(input, report.relativePath);
    await input.callTool('grok_disposition', { taskId: reviewer.id, disposition: 'adopted' });
    assert.equal(report.projectExport?.status, 'saved');
    if (report.projectExport?.status !== 'saved') throw new Error('expected accepted review project output');
    const originalProjectBytes = readFileSync(report.projectExport.path);
    writeFileSync(report.projectExport.path, 'tampered accepted review project copy');
    tampered = data<typeof tampered>(await input.callTool('task_complete', { result: 'tampered report must not complete' }));
    assert.notEqual(input.task.status, 'completed');
    writeFileSync(report.projectExport.path, originalProjectBytes);
    await input.callTool('task_complete', { result: 'saved review adopted after failed export was corrected' });
    return result();
  });
  runtime = createProductionChatRuntime({ store, drivers, workspace, projectOutputs, handoffMs: 5 });

  try {
    const chat = runtime.create({ workspaceId: grant.id });
    runtime.send(chat.id, { text: 'recover reviewer project export', clientMessageId: 'review-project-output' });
    await runtime.idle();
    assert.equal(rejected?.accepted, false);
    assert.equal(rejected?.code, 'PROJECT_OUTPUT_UNVERIFIED');
    assert.ok(rejected?.issues?.length);
    assert.equal(tampered?.accepted, false);
    assert.equal(tampered?.code, 'PROJECT_OUTPUT_UNVERIFIED');
    assert.ok(tampered?.issues?.length);
    const root = chat.tasks.find(task => !task.parentTaskId)!;
    assert.equal(root.executionReviewAttempts?.[0]?.review?.outcome, 'passed');
    assert.equal(root.status, 'completed');
    assert.equal(chat.artifacts.find(artifact => artifact.name === 'failed-review.md')?.projectExport?.status, 'failed');
    assert.equal(chat.artifacts.find(artifact => artifact.name === 'saved-review.md')?.projectExport?.status, 'saved');
  } finally {
    projectOutputs.save = saveProjectOutput;
    rmSync(rootDirectory, { recursive: true, force: true });
  }
});

test('recovery preserves a v1 review latch without replaying a terminal task', async () => {
  let calls = 0;
  const first = fixture(async (_role, input) => {
    calls++;
    await input.callTool('plan_update', { revision: 0, steps: [
      { id: 'one', text: 'first step', status: 'in_progress', verification: { kind: 'artifact', name: 'one.txt' } },
      { id: 'two', text: 'second step', status: 'pending', verification: { kind: 'artifact', name: 'two.txt' } },
    ] });
    await input.callTool('task_fail', { reason: 'terminal fixture for recovery' });
    return result();
  }, { production: true });
  try {
    const chat = first.runtime.create({});
    first.runtime.send(chat.id, { text: 'persist latch', clientMessageId: 'recover-latch' });
    await first.runtime.idle();
    assert.equal(chat.tasks[0]?.executionReviewRequired, true);
    const recovered = createProductionChatRuntime({ store: new ChatStore(first.root), drivers: makeDrivers(async () => { calls++; return result(); }), handoffMs: 5 });
    recovered.recover();
    await recovered.idle();
    const root = recovered.get(chat.id).tasks[0]!;
    assert.equal(root.executionPolicyVersion, 1);
    assert.equal(root.executionReviewRequired, true);
    assert.equal(root.status, 'failed');
    assert.equal(calls, 1);
  } finally { first.cleanup(); }
});

test('a two-step v1 task completes only after the bound reviewer reads the full view and evidence report', async () => {
  let rootSegments = 0;
  let reviewerCalls = 0;
  const fx = fixture(async (role, input) => {
    if (role === 'astra') {
      reviewerCalls++;
      assert.ok(input.task.executionReviewOfTaskId);
      const execution = data<ReviewRead>(await input.callTool('execution_read', {}));
      const viewBody = await readAll(input, execution.viewRef);
      assert.match(viewBody, /implement/);
      assert.match(viewBody, /verify/);
      const root = fx.runtime.get(input.chatId).tasks.find(task => task.id === input.task.executionReviewOfTaskId)!;
      const canonicalView = JSON.parse(viewBody) as { requiredRefs: { ref: string; kind: string }[] };
      const requiredRefs = [...new Set(canonicalView.requiredRefs.filter(item => item.kind !== 'file').map(item => item.ref))];
      assert.ok(requiredRefs.length >= 2);
      for (const ref of requiredRefs) assert.ok((await readAll(input, ref)).length > 0);
      const report = data<{ id: string; relativePath: string }>(await input.callTool('artifact_publish', {
        name: 'execution-review.md', text: `passed ${root.id} ${execution.contractHash} ${execution.evidenceHash}`, kind: 'report',
      }));
      const submission = {
        contractHash: execution.contractHash,
        evidenceHash: execution.evidenceHash,
        outcome: 'passed',
        stepVerdicts: [{ stepId: 'implement', outcome: 'passed' }, { stepId: 'verify', outcome: 'passed' }],
        reportArtifactId: report.id,
      } as const;
      const concurrent = await Promise.all([
        input.callTool('execution_submit_review', submission),
        input.callTool('execution_submit_review', submission),
      ]);
      const acknowledgements = concurrent.map(reply => data<{ accepted: boolean; duplicate?: boolean }>(reply));
      assert.equal(acknowledgements.every(reply => reply.accepted), true);
      assert.equal(acknowledgements.filter(reply => reply.duplicate === true).length, 1);
      const acceptedReview = structuredClone(root.executionReviewAttempts?.[0]?.review);
      const duplicate = data<{ accepted: boolean; duplicate?: boolean }>(await input.callTool('execution_submit_review', submission));
      assert.deepEqual(duplicate, { accepted: true, duplicate: true });
      assert.deepEqual(root.executionReviewAttempts?.[0]?.review, acceptedReview);
      await input.callTool('task_complete', { result: `review passed; report ${report.relativePath}` });
      return result();
    }

    rootSegments++;
    const chat = fx.runtime.get(input.chatId);
    if (rootSegments === 1) {
      await input.callTool('plan_update', { revision: 0, steps: [
        { id: 'implement', text: 'implement exact requested behavior', status: 'in_progress', verification: { kind: 'artifact', name: 'implementation.txt' } },
        { id: 'verify', text: 'verify exact requested behavior', status: 'in_progress', verification: { kind: 'artifact', name: 'verification.txt' } },
      ] });
      const implementation = data<{ relativePath: string }>(await input.callTool('artifact_publish', {
        name: 'implementation.txt', text: 'implemented exact requested behavior', kind: 'report',
      }));
      const verification = data<{ relativePath: string }>(await input.callTool('artifact_publish', {
        name: 'verification.txt', text: 'deterministic tests passed', kind: 'test',
      }));
      await input.callTool('plan_update', { revision: 1, steps: [
        { id: 'implement', text: 'implement exact requested behavior', status: 'completed', evidenceRefs: [implementation.relativePath], verification: { kind: 'artifact', name: 'implementation.txt' } },
        { id: 'verify', text: 'verify exact requested behavior', status: 'completed', evidenceRefs: [verification.relativePath], verification: { kind: 'artifact', name: 'verification.txt' } },
      ] });
      const reviewer = data<{ taskId: string }[]>(await input.callTool('agent_submit', {
        role: 'astra', goal: 'independently review completed execution', mode: 'verify', purpose: 'execution_review',
      }))[0]!;
      assert.equal(chat.todos!.some(step => step.linkedTaskIds.includes(reviewer.taskId)), false);
      await input.callTool('grok_collect', { taskIds: [reviewer.taskId], wait: true });
      return result();
    }

    const reviewer = chat.tasks.find(task => task.parentTaskId === input.task.id && task.executionReviewOfTaskId === input.task.id)!;
    assert.equal(reviewer.status, 'completed');
    await input.callTool('grok_collect', { taskIds: [reviewer.id] });
    await input.callTool('grok_disposition', { taskId: reviewer.id, disposition: 'adopted' });
    const report = chat.artifacts.find(artifact => artifact.taskId === reviewer.id && artifact.name === 'execution-review.md')!;
    assert.match(await readAll(input, report.relativePath), /passed/);
    await input.callTool('task_complete', { result: 'work completed and independently reviewed' });
    return result();
  }, { production: true });

  try {
    const chat = fx.runtime.create({});
    fx.runtime.send(chat.id, { text: 'implement and verify this long task', clientMessageId: 'positive-e2e' });
    await fx.runtime.idle();
    const root = chat.tasks.find(task => !task.parentTaskId)!;
    assert.equal(root.status, 'completed', JSON.stringify({
      rootSegments,
      reviewerCalls,
      blockedReason: chat.blockedReason,
      tasks: chat.tasks.map(task => ({ id: task.id, role: task.role, status: task.status, error: task.error, disposition: task.disposition })),
      attempts: root.executionReviewAttempts,
    }));
    assert.equal(root.executionReviewRequired, true);
    assert.equal(root.executionReviewAttempts?.length, 1);
    assert.equal(root.executionReviewAttempts?.[0]?.review?.outcome, 'passed');
    const reviewEvents = fx.runtime.store.events(chat.id).items.filter(event => event.type === 'execution_review');
    assert.equal(reviewEvents.length, 1);
    assert.equal(typeof (reviewEvents[0]?.data as { toolCallId?: unknown })?.toolCallId, 'string');
    const finalView = materializeExecutionView(chat, root, fx.runtime.store);
    assert.equal(finalView.contractHash, root.executionReviewAttempts?.[0]?.contractHash);
    assert.equal(finalView.evidenceHash, root.executionReviewAttempts?.[0]?.evidenceHash);
    assert.equal(reviewerCalls, 1);
    assert.ok(rootSegments >= 2);
    assert.equal(chat.todos?.length, 2);
    assert.equal(chat.todos?.every(step => step.status === 'completed'), true);
  } finally { fx.cleanup(); }
});
