// Read-only views the server derives from a Run (src/orchestrator/store.ts summarizeRun, src/core/metrics.ts runMetrics,
// src/server/app.ts docs/g2-defaults/diagram routes, src/core/report.ts decision record). Re-implemented here for the
// demo data so that every derived endpoint agrees with GET /api/runs/:id. No product module is imported at runtime.
import type { DocKind, DocVersion, Run, RunMetrics, RunSummary, TaskRecord } from '../../../src/lib/types';
import { effortFor, type ChecklistItem, type RunBundle, type TraceItem } from './common';

// ---------------------------------------------------------------- summary

export function summarizeRun(run: Run): RunSummary {
  return {
    id: run.id, title: run.title, mode: run.mode, createdAt: run.createdAt, updatedAt: run.updatedAt,
    phase: run.phase, phaseStatus: run.phaseStatus, terminal: run.terminal, writeDocs: run.writeDocs, writePrd: run.writePrd, finalChoice: run.finalChoice,
    gates: run.gates.map(gate => {
      const resolution = gate.resolution as { action?: unknown } | null;
      return { id: gate.id, resolved: Boolean(gate.resolvedAt), action: resolution && typeof resolution.action === 'string' ? resolution.action : null };
    }),
    activeTasks: run.tasks.filter(task => task.status === 'running' || task.status === 'queued').map(task => ({ role: task.role, phase: task.phase, status: task.status, startedAt: task.startedAt })),
  };
}

// ---------------------------------------------------------------- metrics

type Duration = RunMetrics['modelTime']['total'];
type Bucket = RunMetrics['modelTime']['buckets'][number];
type GateWait = RunMetrics['gateWait']['gates'][number];

function between(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function add(target: Duration, ms: number | null): void {
  if (ms === null) target.unknownCount += 1;
  else { target.minutes += ms / 60_000; target.knownCount += 1; }
}

const finish = <T extends Duration>(metric: T): T => ({ ...metric, minutes: Number(metric.minutes.toFixed(6)) });

function metricStatus(status: TaskRecord['status']): Bucket['status'] {
  if (status === 'timed_out' || status === 'failed') return 'failed';
  return status === 'queued' ? 'unknown' : status;
}

/** Same rules as runMetrics in src/core/metrics.ts, evaluated at `asOf`. */
export function runMetrics(run: Run, asOf: string): RunMetrics {
  const buckets = new Map<string, Bucket>();
  const total: Duration = { minutes: 0, knownCount: 0, unknownCount: 0 };
  for (const task of run.tasks) {
    for (const call of task.executionCalls ?? []) {
      const status = metricStatus(call.status);
      const key = `${task.phase}/${task.role}/${call.kind}/${status}`;
      const bucket = buckets.get(key) ?? { phase: task.phase, role: task.role, kind: call.kind, status, minutes: 0, knownCount: 0, unknownCount: 0 };
      const ms = between(call.startedAt, call.status === 'running' ? asOf : call.endedAt);
      add(bucket, ms);
      add(total, ms);
      buckets.set(key, bucket);
    }
  }
  const gates = new Map<string, GateWait>();
  const gateTotal: Duration = { minutes: 0, knownCount: 0, unknownCount: 0 };
  for (const gate of run.gates) {
    const metric = gates.get(gate.id) ?? { gate: gate.id, minutes: 0, knownCount: 0, unknownCount: 0 };
    const ms = between(gate.openedAt, gate.resolvedAt ?? (run.terminal === null ? asOf : null));
    add(metric, ms);
    add(gateTotal, ms);
    gates.set(gate.id, metric);
  }
  const clarify = run.questions.filter(question => question.phase === 'clarify');
  const answered = clarify.filter(question => question.status === 'answered').length;
  const rounds = run.jobs.flatMap(job => job.rounds ?? []);
  const firstRound = run.jobs.map(job => ({ jobId: job.id, verdict: job.rounds?.find(round => round.round === 1)?.verification?.verdict }));
  const firstKnown = firstRound.length > 0 && firstRound.every(item => item.verdict !== undefined);
  const wall = between(run.createdAt, run.terminal === null ? asOf : run.updatedAt);
  return {
    runId: run.id, asOf,
    grouping: { mode: run.mode === 'mock' ? 'mock' : 'live', specRefs: [...new Set(run.jobs.map(job => job.spec.ref))].sort(), frozenConfigFingerprint: null },
    modelTime: { total: finish(total), buckets: [...buckets.values()].map(finish).sort((a, b) => `${a.phase}/${a.role}`.localeCompare(`${b.phase}/${b.role}`)) },
    wallClockMinutes: wall === null ? null : Number((wall / 60_000).toFixed(6)),
    gateWait: { total: finish(gateTotal), gates: [...gates.values()].map(finish).sort((a, b) => a.gate.localeCompare(b.gate)) },
    clarification: { questionCount: clarify.length, answeredCount: answered, answerRate: clarify.length ? answered / clarify.length : null },
    firstRoundVerification: firstKnown ? (() => {
      const jobs = firstRound.map(item => ({ jobId: item.jobId, verdict: item.verdict! }));
      return { conclusion: new Set(jobs.map(job => job.verdict)).size === 1 ? jobs[0]!.verdict : 'mixed', jobs };
    })() : null,
    buildAttempts: run.tasks.filter(task => task.phase === 'build' && task.status !== 'queued').length,
    buildRounds: run.jobs.length ? rounds.length : null,
    reviewSequence: run.jobs.length ? rounds.flatMap(round => round.evaluation ? [round.evaluation.verdict] : []) : null,
    quotaBlocks: run.tasks.filter(task => task.failure?.kind === 'rate_limited').length,
    contextHealth: { enabled: run.contextBudget?.enabled ?? null, knownSessions: 0, unknownSessions: 0, sessions: [] },
  };
}

// ---------------------------------------------------------------- documents

const DOC_TITLES: Record<DocKind, string> = { handbook: '架构说明手册', devdoc: '开发文档', prd: '产品需求文档（PRD）' };
export const docTitle = (kind: DocKind) => DOC_TITLES[kind];

function statusLabel(run: Run, version: DocVersion): string {
  if (version.status === 'approved') return `已确认（${version.approval?.conclusion ?? '通过'}）`;
  if (version.status === 'superseded') return version.approval ? '已确认，但已被更新的版本取代' : '已被取代（未确认）';
  const gateId = version.kind === 'prd' ? 'G5_prd' : 'G3_docs';
  return run.gates.some(gate => gate.id === gateId && !gate.resolvedAt) ? '待评审' : '草稿';
}

export function findDoc(run: Run, kind: string, version: string): DocVersion | undefined {
  return /^\d{1,4}$/.test(version) ? run.docs.versions.find(item => item.kind === kind && item.version === Number(version)) : undefined;
}

/** GET /api/runs/:id/docs */
export function docsOverview(bundle: RunBundle) {
  const run = bundle.run;
  const current = (kind: DocKind) => [...run.docs.versions].reverse().find(item => item.kind === kind && item.batch === run.docs.batch && item.status !== 'superseded')?.version ?? null;
  return {
    writeDocs: run.writeDocs, writePrd: run.writePrd, docWriter: run.docWriter, batch: run.docs.batch, missing: run.docs.missing, requests: run.docs.requests,
    current: { handbook: current('handbook'), devdoc: current('devdoc'), prd: current('prd') },
    versions: run.docs.versions.map(version => ({
      kind: version.kind, version: version.version, batch: version.batch, docRef: version.docRef, reason: version.reason, status: version.status,
      statusLabel: statusLabel(run, version), createdAt: version.createdAt, taskId: version.taskId, warnings: version.warnings,
      approval: version.approval, approvedAt: version.approvedAt, checklist: version.kind === 'prd' ? prdChecklist(bundle) : null,
    })),
  };
}

const prdChecklist = (bundle: RunBundle): ChecklistItem[] => bundle.prd?.checklist ?? [];
const prdTrace = (bundle: RunBundle): TraceItem[] => bundle.prd?.traceability ?? [];

/** GET /api/runs/:id/docs/:kind/:version */
export function docDetail(bundle: RunBundle, version: DocVersion) {
  const prd = version.kind === 'prd';
  return { ...version, traceability: prd ? prdTrace(bundle) : null, checklist: prd ? prdChecklist(bundle) : null };
}

/** Download names, as docFileNames in src/core/docs.ts builds them. */
export function docFileNames(run: Run, version: DocVersion, ext: 'md' | 'html'): { ascii: string; utf8: string } {
  const safe = Array.from(run.title.replace(/[\\/:*?"<>|\r\n\t]+/g, '_').replace(/\s+/g, '_')).slice(0, 40).join('') || 'project';
  const label: Record<DocKind, string> = { prd: 'PRD', handbook: '架构说明手册', devdoc: '开发文档' };
  return { ascii: `${version.kind}-v${version.version}.${ext}`, utf8: `${label[version.kind]}-${safe}-v${version.version}.${ext}` };
}

// ---------------------------------------------------------------- G2 defaults and diagrams

/** GET /api/runs/:id/g2-defaults (frameworkGateDefaults + defaultSpecInput + chooseSolEffort). */
export function g2Defaults(run: Run) {
  return run.candidates.flatMap(item => {
    const rep = run.proposals.find(proposal => proposal.id === item.representativeProposalId);
    if (!rep) return [];
    return [{
      candidateId: item.id,
      spec: {
        candidateId: item.id, goal: rep.mvpPlan.goal, scopeIn: rep.mvpPlan.scopeIn, scopeOut: rep.mvpPlan.scopeOut,
        acceptance: rep.mvpPlan.acceptance.map(entry => ({ ...entry, command: entry.command ?? null, expectExitCode: entry.expectExitCode ?? 0, outputIncludes: entry.outputIncludes ?? null })),
        hypotheses: rep.mvpPlan.hypotheses.map(entry => ({ id: entry.id, text: entry.text, passCriteria: entry.passCriteria })),
        timeboxMinutes: 120, allowNetwork: true,
      },
      effort: effortFor(rep.mvpPlan.workstreams),
    }];
  });
}

const esc = (text: string) => text.replace(/"/g, '#quot;').replace(/</g, '#lt;').replace(/>/g, '#gt;').replace(/`/g, "'").replace(/[\r\n]+/g, ' ').trim();

/** GET /api/runs/:id/diagram/:proposalId — the same text proposalToMermaid in src/core/diagram.ts generates. */
export function proposalMermaid(proposal: Run['proposals'][number]): string {
  const lines = ['flowchart LR'];
  const ids = new Map<string, string>();
  proposal.modules.forEach((module, index) => {
    const id = `n${index + 1}`;
    ids.set(module.id, id);
    lines.push(`  ${id}["${module.tech ? `${esc(module.name)}<br/><small>${esc(module.tech)}</small>` : esc(module.name)}"]`);
  });
  for (const flow of proposal.flows) {
    const from = ids.get(flow.from);
    const to = ids.get(flow.to);
    if (!from || !to) continue;
    const arrow = flow.kind === 'data' ? '-.->' : flow.kind === 'event' ? '==>' : '-->';
    lines.push(`  ${from} ${arrow}|"${esc(flow.label).replace(/\|/g, '/').slice(0, 60)}"| ${to}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- task files

/** GET /api/runs/:id/tasks/:taskId/files: the raw files a finished task leaves behind (shortened sample texts). */
export function taskFiles(bundle: RunBundle, task: TaskRecord): { name: string; content: string }[] {
  const run = bundle.run;
  const snapshot = run.snapshots.find(item => item.ref === task.inputRef) ?? run.snapshots.at(-1);
  const files: { name: string; content: string }[] = [{
    name: 'prompt.md',
    content: `# 任务 ${task.id}\n\n角色：${task.role} · 阶段：${task.phase} · 输入：${task.inputRef ?? '—'}\n\n## 需求快照 v${snapshot?.version ?? '?'}\n\n${snapshot?.project.prompt ?? ''}\n\n## 硬约束\n\n${(snapshot?.constraints ?? []).map(item => `- ${item.id} ${item.kind === 'must' ? '必须' : '禁止'}：${item.text}`).join('\n')}\n\n（在线演示中的提示词为节选。）\n`,
  }];
  const output = taskOutput(run, task);
  if (output !== undefined) files.push({ name: 'output.json', content: JSON.stringify(output, null, 2) });
  if (task.failure) files.push({ name: 'final-message.txt', content: `${task.failure.kind}: ${task.failure.message}\n` });
  if (task.meta) files.push({ name: 'meta.json', content: JSON.stringify(task.meta, null, 2) });
  if (task.outputValidity === 'valid') files.push({ name: 'validation.json', content: JSON.stringify({ outputValidity: 'valid', errors: [], repaired: false }, null, 2) });
  const tools = bundle.toolLogs?.[task.id];
  if (tools) files.push({ name: 'tool-log.json', content: JSON.stringify(tools, null, 2) });
  return files;
}

function taskOutput(run: Run, task: TaskRecord): unknown {
  if (task.status !== 'succeeded') return undefined;
  if (task.phase === 'clarify') return { snapshotRef: task.inputRef, understanding: run.modelNotes.find(note => note.taskId === task.id)?.understanding ?? null, questions: run.questions.filter(item => item.taskId === task.id).map(item => ({ localId: item.localId, topic: item.topic, priority: item.priority, text: item.text })) };
  if (task.phase === 'propose') return { snapshotRef: task.inputRef, proposals: run.proposals.filter(item => item.taskId === task.id).map(item => ({ localId: item.localId, title: item.title, summary: item.summary })) };
  if (task.phase === 'review') return { snapshotRef: task.inputRef, judgments: run.judgments.filter(item => item.taskId === task.id).map(item => ({ proposal: item.anonymousId, objections: item.objections.length, constraintChecks: item.constraintChecks.map(check => `${check.constraintId}:${check.status}`) })) };
  if (task.phase === 'build') return run.jobs.find(job => job.id === task.jobId)?.report ?? null;
  const version = run.docs.versions.find(item => item.taskId === task.id);
  return version ? { docRef: version.docRef, kind: version.kind, version: version.version, warnings: version.warnings } : null;
}

// ---------------------------------------------------------------- decision record

const gateNames: Record<string, string> = { G1_answers: 'G1 确认回答', G2_framework: 'G2 确认框架与 MVP 范围', G3_docs: 'G3 确认构建前文档', G4_final: 'G4 验收 MVP', G5_prd: 'G5 确认 PRD' };

/** GET /api/runs/:id/export: a Markdown decision record built from the run (shorter than src/core/report.ts). */
export function decisionRecord(run: Run): string {
  const snapshot = run.snapshots.find(item => item.version === run.currentSnapshotVersion) ?? run.snapshots.at(-1);
  const title = (id: string) => run.proposals.find(item => item.id === run.candidates.find(c => c.id === id)?.representativeProposalId)?.title ?? id;
  const out: string[] = [`# 决策记录 · ${run.title}`, '', `- 运行：\`${run.id}\``, `- 创建：${run.createdAt}`, `- 更新：${run.updatedAt}`, `- 状态：${run.phase} / ${run.phaseStatus}${run.terminal ? ` / ${run.terminal}` : ''}`, '- 来源：在线演示的预设数据', ''];
  if (snapshot) {
    out.push(`## 需求快照 v${snapshot.version}（${snapshot.ref}）`, '', snapshot.project.prompt, '', '### 硬约束', '', ...snapshot.constraints.map(item => `- ${item.id} ${item.kind === 'must' ? '必须' : '禁止'}：${item.text}`), '');
    if (snapshot.facts.length) out.push('### 事实', '', ...snapshot.facts.map(item => `- ${item.id} ${item.text}（${item.source}）`), '');
    if (snapshot.assumptions.length) out.push('### 假设', '', ...snapshot.assumptions.map(item => `- ${item.id} ${item.text}（${item.source}）`), '');
  }
  if (run.questions.length) out.push('## 澄清问题', '', '| 编号 | 问题 | 状态 |', '| --- | --- | --- |', ...run.questions.map(item => `| ${item.id} | ${item.text} | ${item.status} |`), '');
  if (run.candidates.length) out.push('## 候选方案', '', ...run.candidates.map(item => `- ${item.id}（${item.origin}）：${title(item.id)}`), '');
  if (run.decision) {
    out.push('## 规则结论', '', `- 结论：${run.decision.outcome} · 依据：${run.decision.basis ?? '—'} · 推荐：${run.decision.winnerId ?? '无'}`, ...run.decision.totals.map(item => `- ${item.candidateId} 总分区间 ${item.lo.toFixed(2)}–${item.hi.toFixed(2)}（${item.status}）`), '', ...run.decision.explanation.map(line => `> ${line}`), '');
  }
  if (run.gates.length) out.push('## 关卡决定', '', ...run.gates.map(gate => `- ${gateNames[gate.id] ?? gate.id}：打开 ${gate.openedAt}，${gate.resolvedAt ? `提交 ${gate.resolvedAt}（${String((gate.resolution as { action?: string } | null)?.action ?? '—')}）` : '等待确认'}`), '');
  for (const job of run.jobs) {
    out.push(`## MVP 作业 ${job.id}（${job.candidateId}）`, '', `- 状态：${job.status} · 规格：\`${job.spec.ref}\``, '', '| 验收项 | 说明 | 核验 |', '| --- | --- | --- |',
      ...job.spec.acceptance.map(item => `| ${item.id} | ${item.description} | ${job.verification?.items.find(entry => entry.criterionId === item.id)?.status ?? '未观察到'} |`), '');
  }
  if (run.blockedReason) out.push('## 阻塞原因', '', run.blockedReason, '');
  if (run.finalChoice) out.push('## 最终选择', '', `${run.finalChoice.candidateId ?? '无'}：${run.finalChoice.reason ?? ''}`, '');
  return out.join('\n');
}
