import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MockAdapter } from '../src/adapters/mock.js';
import type { AdapterProgress, ModelTaskSpec } from '../src/adapters/types.js';
import { prdTraceability } from '../src/core/docs.js';
import { CreateRunInputZ, GateInputZ, type HandbookOutput, type PrdOutput } from '../src/core/schemas.js';
import type { Run } from '../src/core/types.js';
import { EventBus } from '../src/orchestrator/events.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { saveReferenceArchive } from '../src/orchestrator/reference-store.js';
import { RunStore } from '../src/orchestrator/store.js';
import { buildReferenceZip } from './fixtures/reference-zip.js';
import { makeHarness, runInput } from './helpers.js';

type Harness = ReturnType<typeof makeHarness>;

const G3 = { gate: 'G3_docs' as const, reviewers: null, conclusion: '通过' as const, handbookNotes: null, devdocNotes: null, reason: null };
const G4 = { gate: 'G4_final' as const, jobId: null, manualResults: [], failureClassOverrides: {}, reason: null };
const G5 = { gate: 'G5_prd' as const, reviewers: null, conclusion: '通过' as const, prdNotes: null, reason: null };

async function toFramework(h: Harness, scenario = 'preference', patch: Parameters<typeof runInput>[1] = {}): Promise<Run> {
  const run = h.orch.createRun(runInput(scenario, { writeDocs: true, writePrd: true, ...patch }));
  await h.orch.idle();
  h.orch.resolveGate(run.id, { gate: 'G1_answers', action: 'submit' });
  await h.orch.idle();
  return h.orch.getRun(run.id);
}

async function validate(h: Harness, run: Run, candidateId = run.decision!.winnerId!): Promise<Run> {
  const defaults = h.orch.frameworkGateDefaults(run.id).find((item) => item.candidateId === candidateId)!;
  h.orch.resolveGate(run.id, GateInputZ.parse({ gate: 'G2_framework', action: 'validate', candidateIds: [candidateId], specs: [defaults.spec] }));
  await h.orch.idle();
  return h.orch.getRun(run.id);
}

async function approveDocs(h: Harness, run: Run): Promise<Run> {
  h.orch.resolveGate(run.id, { ...G3, action: 'approve' });
  await h.orch.idle();
  return h.orch.getRun(run.id);
}

function passManual(h: Harness, run: Run): Run {
  const job = run.jobs.find((item) => item.batch === run.jobBatch)!;
  const criterion = job.spec.acceptance.find((item) => item.kind === 'manual')!;
  return h.orch.setManualResult(run.id, job.id, criterion.id, true, '人工核对通过');
}

test('明确接受文档型号不符时仍保留语义检查提示', async () => {
  const h = makeHarness();
  const mock = new MockAdapter({ delayMs: 0 });
  h.orch = new Orchestrator({ config: h.config, store: h.store, bus: h.bus, adapterFor: () => ({
    kind: 'mock',
    async run(spec, progress, signal) {
      const result = await mock.run(spec, progress, signal);
      if (spec.phase === 'handbook') {
        result.meta.reportedModelSource = 'server_usage';
        result.meta.reportedModels = ['wrong-model'];
      }
      return result;
    },
  }) });
  let run = await toFramework(h);
  run = await validate(h, run);
  assert.equal(run.phaseStatus, 'blocked');
  const task = run.tasks.find(item => item.phase === 'handbook')!;
  const validation = JSON.parse(h.store.readTaskFile(run.id, task.id, 'validation.json')!) as { warnings: string[] };
  assert.ok(validation.warnings.length > 0, '模拟手册中的无来源段落必须触发非阻塞提示');
  h.orch.acceptMismatch(run.id, task.id);
  await h.orch.idle();
  run = h.orch.getRun(run.id);
  assert.equal(run.phase, 'docs_gate');
  assert.deepEqual(run.docs.versions.find(item => item.kind === 'handbook')!.warnings, validation.warnings);
});

test('新建默认开启两类文档，G2 只排队构建，G3 批准后才启动 Sol', async () => {
  const h = makeHarness();
  const { writeDocs: _writeDocs, writePrd: _writePrd, ...withoutDocumentFlags } = runInput('preference');
  const created = h.orch.createRun(CreateRunInputZ.parse(withoutDocumentFlags));
  await h.orch.idle();
  h.orch.resolveGate(created.id, { gate: 'G1_answers', action: 'submit' });
  await h.orch.idle();
  let run = h.orch.getRun(created.id);
  assert.equal(run.writeDocs, true);
  assert.equal(run.writePrd, true);

  const candidateId = run.decision!.winnerId!;
  const defaults = h.orch.frameworkGateDefaults(run.id).find((item) => item.candidateId === candidateId)!;
  h.orch.resolveGate(run.id, GateInputZ.parse({ gate: 'G2_framework', action: 'validate', candidateIds: [candidateId], specs: [defaults.spec] }));
  run = h.orch.getRun(run.id);
  assert.deepEqual(run.jobs.map((job) => job.status), ['queued']);
  assert.equal(run.tasks.some((task) => task.phase === 'build' || task.role === 'sol'), false);

  await h.orch.idle();
  run = h.orch.getRun(run.id);
  assert.equal(run.phase, 'docs_gate');
  assert.deepEqual(run.docs.versions.map((version) => version.kind).sort(), ['devdoc', 'handbook']);
  run = await approveDocs(h, run);
  assert.equal(run.phase, 'final_gate');
  assert.equal(run.tasks.filter((task) => task.phase === 'build').length, 1);
});

test('G4 人工验收后接受的作业是 G5 PRD 的精确追踪依据', async () => {
  const h = makeHarness();
  let run = await validate(h, await toFramework(h));
  run = await approveDocs(h, run);
  run = passManual(h, run);
  const accepted = run.jobs.find((job) => job.batch === run.jobBatch)!;
  h.orch.resolveGate(run.id, { ...G4, action: 'accept', chosenCandidateId: accepted.candidateId });
  await h.orch.idle();
  run = h.orch.getRun(run.id);

  assert.equal(run.phase, 'prd_gate');
  const prd = run.docs.versions.find((version) => version.kind === 'prd')!;
  const content = prd.content as PrdOutput;
  assert.deepEqual([...new Set(content.mvpAcceptanceMap.map((item) => item.specRef))], [accepted.spec.ref]);
  assert.ok(prdTraceability(run, prd).flatMap((row) => row.mvpItems).every((item) => item.exec.state === 'pass'));
  h.orch.resolveGate(run.id, { ...G5, action: 'approve', reviewers: '王总（老板）' });
  assert.equal(h.orch.getRun(run.id).terminal, 'done');
});

test('文档修订保留旧版本历史并建立 previousVersion 链', async () => {
  const h = makeHarness();
  let run = await validate(h, await toFramework(h));
  const first = run.docs.versions.find((version) => version.kind === 'handbook')!;
  h.orch.resolveGate(run.id, { ...G3, action: 'revise', handbookNotes: '把成本说明写得更直白' });
  await h.orch.idle();
  run = h.orch.getRun(run.id);

  const second = run.docs.versions.find((version) => version.kind === 'handbook' && version.version === 2)!;
  assert.equal(first.status, 'superseded');
  assert.equal(second.previousVersion, first.version);
  assert.equal(second.reason, 'revision');
  assert.ok((second.content as HandbookOutput).pending.some((item) => item.item.includes('成本说明')));
});

test('G3 返回框架会取消未开始的整批作业并废弃草稿', async () => {
  const h = makeHarness();
  let run = await validate(h, await toFramework(h));
  h.orch.resolveGate(run.id, { ...G3, action: 'back_to_framework' });
  run = h.orch.getRun(run.id);

  assert.equal(run.phase, 'framework_gate');
  assert.ok(run.jobs.every((job) => job.status === 'cancelled' && job.taskIds.length === 0));
  assert.ok(run.docs.versions.every((version) => version.status === 'superseded'));
});

test('缺失的首次文档继续后进入 G3，并明确记录 missing', async () => {
  const h = makeHarness({ inject: { 'claude.handbook.1': 'process_error' } });
  let run = await validate(h, await toFramework(h));
  assert.equal(run.phaseStatus, 'blocked');
  h.orch.resolveBlocked(run.id, 'continue_single');
  await h.orch.idle();
  run = h.orch.getRun(run.id);

  assert.equal(run.phase, 'docs_gate');
  assert.deepEqual(run.docs.missing, ['handbook']);
});

class FailRevisionAdapter extends MockAdapter {
  override async run(spec: ModelTaskSpec, onProgress: (progress: AdapterProgress) => void, signal: AbortSignal) {
    if (spec.phase === 'handbook' && spec.prompt.includes('FAIL-REVISION')) {
      const result = await super.run({ ...spec, phase: 'probe' }, onProgress, signal);
      return { ...result, status: 'failed' as const, failure: { kind: 'process_error' as const, message: '模拟修订失败' }, rawText: null };
    }
    return super.run(spec, onProgress, signal);
  }
}

test('修订失败后继续沿用旧版本，并在 G3 context 标记 revisionFailed', async () => {
  const base = makeHarness();
  const orch = new Orchestrator({ config: base.config, store: base.store, bus: base.bus, adapterFor: () => new FailRevisionAdapter({ delayMs: 0 }) });
  const h = { ...base, orch };
  let run = await validate(h, await toFramework(h));
  h.orch.resolveGate(run.id, { ...G3, action: 'revise', handbookNotes: 'FAIL-REVISION 请改写摘要' });
  await h.orch.idle();
  h.orch.resolveBlocked(run.id, 'continue_single');
  await h.orch.idle();
  run = h.orch.getRun(run.id);

  assert.deepEqual(run.docs.missing, []);
  const gate = run.gates.filter((item) => item.id === 'G3_docs').at(-1)!;
  assert.deepEqual(gate.context.revisionFailed, ['handbook']);
  assert.deepEqual(gate.context.versions, ['handbook-v1', 'devdoc-v1']);
});

test('重启停在 G3 时不自动调用模型或启动排队构建', async () => {
  const h = makeHarness();
  const run = await validate(h, await toFramework(h, 'single'));
  let calls = 0;
  const adapter = new MockAdapter({ delayMs: 0 });
  const store = new RunStore(h.config.dataDir);
  const restarted = new Orchestrator({
    config: h.config,
    store,
    bus: new EventBus(store),
    adapterFor: () => ({ kind: 'mock' as const, run: async (...args: Parameters<MockAdapter['run']>) => { calls += 1; return adapter.run(...args); } }),
  });
  restarted.recover();
  await restarted.idle();
  const recovered = restarted.getRun(run.id);

  assert.equal(calls, 0);
  assert.equal(recovered.phase, 'docs_gate');
  assert.deepEqual(recovered.jobs.map((job) => job.status), ['queued']);
  assert.equal(recovered.tasks.some((task) => task.phase === 'build'), false);
});

test('D8 裁决历史与启用文档的 G2→G3 流程兼容', async () => {
  const h = makeHarness();
  let run = await toFramework(h, 'needs_adjudication');
  h.orch.resolveGate(run.id, GateInputZ.parse({ gate: 'G2_framework', action: 'recheck' }));
  await h.orch.idle();
  run = h.orch.getRun(run.id);
  const record = run.adjudications!.at(-1)!;
  const candidateId = record.report!.recommendation.candidateId!;
  run = await validate(h, run, candidateId);

  assert.equal(run.phase, 'docs_gate');
  assert.equal(run.adjudications!.at(-1)!.taskId, record.taskId);
  assert.deepEqual(run.adjudications!.at(-1)!.report, record.report);
  assert.equal(run.tasks.some((task) => task.phase === 'adjudicate' && task.meta?.requestedEffort === 'ultra'), true);
  assert.equal(run.tasks.some((task) => task.phase === 'build'), false);
});

test('writeDocs 与 writePrd 可以分别关闭且只跳过对应步骤', async () => {
  const pre = makeHarness();
  let preRun = await validate(pre, await toFramework(pre, 'single', { writeDocs: false }));
  assert.equal(preRun.phase, 'final_gate');
  assert.equal(preRun.gates.some((gate) => gate.id === 'G3_docs'), false);
  preRun = passManual(pre, preRun);
  pre.orch.resolveGate(preRun.id, { ...G4, action: 'accept', chosenCandidateId: preRun.jobs[0]!.candidateId });
  await pre.orch.idle();
  assert.equal(pre.orch.getRun(preRun.id).phase, 'prd_gate');

  const post = makeHarness();
  let postRun = await validate(post, await toFramework(post, 'single', { writePrd: false }));
  assert.equal(postRun.phase, 'docs_gate');
  postRun = await approveDocs(post, postRun);
  postRun = passManual(post, postRun);
  post.orch.resolveGate(postRun.id, { ...G4, action: 'accept', chosenCandidateId: postRun.jobs[0]!.candidateId });
  postRun = post.orch.getRun(postRun.id);
  assert.equal(postRun.terminal, 'done');
  assert.equal(postRun.docs.versions.some((version) => version.kind === 'prd'), false);
});

test('旧保存运行迁移关闭文档并把 G3_final 改为 G4_final，同时保留附件与 D8 历史', async () => {
  const h = makeHarness();
  const archive = saveReferenceArchive(h.config.dataDir, '依据.zip', buildReferenceZip([{ name: '依据.txt', content: '只作为参考材料' }]));
  const project = runInput('preference').project;
  let run = await toFramework(h, 'needs_adjudication', {
    writeDocs: false,
    writePrd: false,
    project: {
      ...project,
      prompt: '本地记账',
      coreFlows: ['记一笔'],
      referenceDocuments: [{ name: '说明.md', content: '保留这份附件' }],
      referenceArchives: [{ id: archive.id }],
    },
  });
  h.orch.resolveGate(run.id, GateInputZ.parse({ gate: 'G2_framework', action: 'recheck' }));
  await h.orch.idle();
  run = h.orch.getRun(run.id);
  run = await validate(h, run, run.adjudications!.at(-1)!.report!.recommendation.candidateId!);

  const savedFile = path.join(h.store.runDir(run.id), 'run.json');
  const old = JSON.parse(readFileSync(savedFile, 'utf8')) as Record<string, any>;
  delete old.writeDocs;
  delete old.writePrd;
  delete old.docWriter;
  delete old.docs;
  for (const gate of old.gates as { id: string }[]) if (gate.id === 'G4_final') gate.id = 'G3_final';
  writeFileSync(savedFile, JSON.stringify(old), 'utf8');

  const migrated = new RunStore(h.config.dataDir).load(run.id)!;
  assert.equal(migrated.writeDocs, false);
  assert.equal(migrated.writePrd, false);
  assert.equal(migrated.gates.some((gate) => gate.id === 'G4_final'), true);
  assert.deepEqual(migrated.snapshots[0]!.project.referenceDocuments, old.snapshots[0].project.referenceDocuments);
  assert.deepEqual(migrated.snapshots[0]!.project.referenceArchives, old.snapshots[0].project.referenceArchives);
  assert.deepEqual(migrated.adjudications, old.adjudications);
});
