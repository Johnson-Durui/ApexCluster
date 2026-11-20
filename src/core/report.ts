/**
 * 决策记录导出（Markdown）：需求版本、问题与回答、候选、评分依据、推荐理由、你的选择、MVP 验证结果、执行元数据。
 */
import { DOC_NAME } from './docs.js';
import { runMetrics } from './metrics.js';
import { renderPreflight } from './preflight.js';
import type { Run } from './types.js';
import { TOPIC_NAME } from './questions.js';
import { renderReferenceArchives, renderReferenceDocuments } from './snapshot.js';

const ROLE: Record<string, string> = { claude: 'Claude', astra: 'Astra', sol: 'Sol', grok: 'Grok' };
const OUTCOME: Record<string, string> = {
  recommend: '推荐',
  single: '唯一可行方案',
  tie: '平局（需要你选择）',
  needs_verification: '需要先验证',
  none_viable: '无可行方案',
};

const DOC_KIND_ORDER = ['handbook', 'devdoc', 'prd'] as const;
const observed = (value: number | string | null): string => value === null ? 'unknown' : String(value);

function renderRoundContext(lines: string[], round: NonNullable<Run['jobs'][number]['rounds']>[number]): void {
  const context = round.context;
  if (!context) return;
  lines.push(`- PLAN：${context.planPath || '未记录'}；hash：${context.planHash ?? 'unknown'}；状态：${context.plan ? '已冻结' : '缺失'}`);
  if (context.dispatchBlocked) lines.push(`- 派发停止：${context.dispatchBlocked}`);
  for (const state of context.states) {
    lines.push(`- 里程碑 ${state.id}：${state.status}；尝试 ${state.attempts}；核验提交 ${state.verifiedAtCommit ?? 'unknown'}`);
  }
  for (const session of context.sessions) {
    lines.push(`##### 会话 ${session.id}（${session.kind} / ${session.outcome}）`);
    lines.push(`- 里程碑：${session.milestoneIds.join('、') || '无'}；任务：${session.taskId}；线程：${session.threadId ?? 'unknown'}；续接来源：${session.resumedFrom ?? '新线程'}；原因：${session.resumeReason}`);
    lines.push(`- 提交：${session.startCommit ?? 'unknown'} → ${session.endCommit ?? 'unknown'}；HANDOFF：${session.handoffPath ?? '未生成'}`);
    lines.push(`- 实际上下文：语义 ${session.context.usageSemantics}；来源 ${session.context.usageSource ?? 'unknown'}；窗口 ${observed(session.context.contextWindow)}；峰值 ${observed(session.context.contextTokensPeak)}；峰值比例 ${observed(session.context.contextRatioPeak)}；compactions ${observed(session.context.compactions)}`);
    if (session.material) {
      lines.push(`- 提示材料估算（非实际上下文）：${session.material.estimatedTokens}/${session.material.targetTokens} tokens；依据 ${session.material.estimateReference}`);
      for (const item of session.material.omitted) lines.push(`  - 省略 ${item.id}（${item.sourcePath}）：${item.reason}`);
    }
    if (session.outcome === 'stopped') lines.push('- 会话停止：outcome=stopped');
  }
}

export function renderDecisionRecord(run: Run): string {
  const L: string[] = [];
  const s = run.snapshots.find((x) => x.version === (run.designSnapshotVersion ?? run.currentSnapshotVersion)) ?? run.snapshots.at(-1)!;
  L.push(`# 架构决策记录：${run.title}`);
  L.push('');
  if (run.mode === 'mock') L.push('> ⚠️ **模拟数据**：本记录由模拟适配器生成，没有调用任何真实模型。\n');
  if (run.degraded.length) L.push(`> ⚠️ **不完整**：${run.degraded.map((d) => `${ROLE[d.role]} 在 ${d.phase} 阶段失败后按单模型继续（${d.reason}）`).join('；')}。结果不代表双模型共识。\n`);
  L.push(`- 运行编号：${run.id}（创建于 ${run.createdAt}）`);
  L.push(`- 需求快照：${s.ref}（${s.reason}）`);
  L.push(`- 状态：${run.terminal ?? run.phase}`);
  if (run.designMode || run.riskLevel || run.designResolution) {
    L.push('', '## 设计策略（创建时冻结）');
    if (run.designMode) L.push(`- 请求模式：${run.designMode}`);
    if (run.riskLevel) L.push(`- 风险等级：${run.riskLevel}`);
    if (run.designResolution) {
      L.push(`- 本轮解析：${run.designResolution.mode}；架构师：${run.designResolution.architects.map(role => ROLE[role]).join('、')}；评审者：${run.designResolution.reviewers.map(role => ROLE[role]).join('、')}`);
      for (const reason of run.designResolution.reasons) L.push(`  - 解析依据：${reason}`);
      if (run.designResolution.architectOverride) L.push(`- 单架构师覆盖：${ROLE[run.designResolution.architectOverride.from]} → ${ROLE[run.designResolution.architectOverride.to]}；${run.designResolution.architectOverride.reason}；非主导者方案=${run.designResolution.architectOverride.proposalIsNonLeading}`);
    }
    for (const item of run.designResolutionHistory ?? []) L.push(`- 历史第 ${item.round} 轮：${item.resolution.mode}（${item.resolution.reasons.join('；')}）`);
  }
  L.push('');
  L.push('## 需求快照');
  L.push(s.project.prompt);
  L.push('');
  L.push('**硬约束**');
  for (const h of s.constraints) L.push(`- ${h.id} [${h.kind === 'must' ? '必须' : '禁止'}] ${h.text}`);
  L.push('');
  L.push('**事实 / 假设 / 待确认**');
  for (const f of s.facts) L.push(`- 事实 ${f.id}：${f.text}`);
  for (const a of s.assumptions) L.push(`- 假设 ${a.id}：${a.text}`);
  for (const o of s.openItems) L.push(`- 待确认 ${o.id}：${o.text}`);
  L.push('');
  const references = renderReferenceDocuments(s.project.referenceDocuments);
  if (references) L.push(references, '');
  const archives = renderReferenceArchives(s.project.referenceArchives);
  if (archives) L.push(archives, '');
  L.push('## 问题与回答');
  for (const q of run.questions) {
    const ans =
      q.status === 'answered'
        ? q.answer!.optionIds.map((id) => q.options.find((o) => o.id === id)?.label ?? id).concat(q.answer!.otherText ? [`其他：${q.answer!.otherText}`] : []).join('；')
        : q.status === 'skipped'
          ? `未回答，采用默认：${q.defaultAssumption}`
          : q.status === 'unsure'
            ? '暂不确定'
            : '未处理';
    L.push(`- ${q.id}〔${ROLE[q.askedBy]}·${TOPIC_NAME[q.topic]}·${q.priority}〕${q.text} → ${ans}`);
  }
  if (run.questionGroups || run.chores?.qgroup) {
    const groups = run.questionGroups;
    L.push('', '### Grok 问题分组提示');
    L.push('分组只用于导航；原问题与答案仍逐题保留。');
    L.push(`- 状态：${groups?.status ?? '未记录'}；任务：${groups?.taskId ?? '未记录'}${groups?.reason ? `；跳过/缺失原因：${groups.reason}` : ''}`);
    if (groups?.output) {
      L.push(`- 来源快照：${groups.output.snapshotRef}`);
      for (const group of groups.output.groups) L.push(`- ${group.label}：${group.questionIds.join('、') || '空组'}`);
    }
  }
  L.push('');
  const d = run.decision;
  if (d) {
    L.push('## 推荐结论');
    L.push(`**${OUTCOME[d.outcome]}**${d.winnerId ? `：${d.winnerId}` : ''}${d.basis ? `（依据：${d.basis}）` : ''}`);
    L.push('');
    for (const e of d.explanation) L.push(`- ${e}`);
    L.push('');
    L.push('| 候选 | 来源 | 状态 | 得分区间 |');
    L.push('| --- | --- | --- | --- |');
    for (const t of d.totals) {
      const cand = run.candidates.find((c) => c.id === t.candidateId);
      const p = run.proposals.find((x) => x.id === cand?.representativeProposalId);
      L.push(`| ${t.candidateId} ${p?.title ?? ''} | ${t.origin} | ${t.status} | ${t.lo.toFixed(2)}–${t.hi.toFixed(2)} |`);
    }
    if (d.keyUncertainties.length) {
      L.push('');
      L.push('**关键不确定项**');
      for (const u of d.keyUncertainties) L.push(`- ${u.id}${u.isKey ? '（关键）' : ''}：${u.description}`);
    }
    L.push('');
  }
  if (run.adjudications?.length) {
    L.push('## Astra Ultra 裁决建议（D8）');
    L.push('裁决只作为 G2 输入，不改写规则评分，不代表双模型共识或 MVP 验证通过。');
    for (const record of run.adjudications) {
      L.push(`### 设计轮次 ${record.designRound} · 复核批次 ${record.batch}`);
      L.push(`- 任务：${record.taskId ?? '尚未开始'}；输入：${record.snapshotRef}；决策时间：${record.decisionComputedAt}`);
      L.push(`- 状态：${record.staleReason ? `已过期（${record.staleReason}）` : record.report ? '已形成裁决建议' : '尚无合法裁决输出'}`);
      if (!record.report) continue;
      L.push(`- 建议候选：${record.report.recommendation.candidateId ?? '证据不足，暂不建议'}；${record.report.recommendation.rationale}`);
      for (const item of record.report.items) {
        L.push(`- ${item.itemId}（${record.items.find(input => input.id === item.itemId)?.description ?? ''}）：${item.verdict === 'resolved' ? '已形成建议' : '证据不足'}；${item.rationale}`);
        for (const evidence of item.evidence) L.push(`  - 依据〔${evidence.kind}〕${evidence.summary}${evidence.ref ? `（${evidence.ref}）` : ''}`);
        if (item.verification) L.push(`  - 补证方法：${item.verification}`);
      }
      for (const risk of record.report.risks) L.push(`- 风险：${risk}`);
    }
    L.push('');
  }
  for (const g of run.gates.filter((x) => x.resolvedAt)) {
    L.push(`- 关卡 ${g.id} 于 ${g.resolvedAt} 处理：\`${JSON.stringify(g.resolution).slice(0, 400)}\``);
  }
  if (run.writeDocs || run.writePrd || run.docs.versions.length || run.docWriters) {
    L.push('');
    const w = run.docWriter;
    L.push('## 文档（手册与开发文档在 G3 确认，PRD 在 G5 确认）');
    if (run.docWriters) {
      for (const kind of DOC_KIND_ORDER) {
        const writer = run.docWriters[kind];
        L.push(`- ${DOC_NAME[kind]}撰写者：${ROLE[writer.role]} ${writer.model} · ${writer.effort}`);
      }
    } else {
      L.push(`- 旧版统一撰写者：${ROLE[w.role]} ${w.model} · ${w.effort}`);
    }
    L.push(`- 构建前写手册与开发文档：${run.writeDocs ? '是' : '否'}；MVP 接受后写 PRD：${run.writePrd ? '是' : '否'}`);
    if (run.docs.versions.length === 0) L.push('- 尚未撰写');
    const order: Record<string, number> = { handbook: 0, devdoc: 1, prd: 2 };
    for (const v of [...run.docs.versions].sort((a, b) => order[a.kind]! - order[b.kind]! || a.version - b.version)) {
      const st = { draft: '草稿', approved: `已确认（${v.kind === 'prd' ? 'G5' : 'G3'}）`, superseded: '已被取代' }[v.status];
      const ap = v.approval ? `；${v.approval.conclusion}；评审人：${v.approval.reviewers ?? '未填写'}` : '';
      const writer = run.docWriters?.[v.kind] ?? w;
      L.push(`- ${DOC_NAME[v.kind]} v${v.version}（${ROLE[writer.role]} ${writer.model} · ${writer.effort}；验证批次 ${v.batch}；${st}${ap}；${v.docRef}）${v.warnings.length ? `；程序提示 ${v.warnings.length} 条` : ''}`);
    }
    if (run.docs.missing.length) L.push(`- ⚠️ 缺失（撰写失败后你选择继续）：${run.docs.missing.map((k) => DOC_NAME[k]).join('、')}`);
  }
  if (run.jobs.length) {
    L.push('');
    L.push('## MVP 验证（Sol）');
    for (const j of run.jobs) {
      L.push(`### ${j.id}（候选 ${j.candidateId}，强度 ${j.effort}：${j.effortReason}）`);
      L.push(`- 状态：${j.status}${j.failureClass ? `；失败分类：${j.failureClass}（来源：${j.failureClassSource}）` : ''}`);
      L.push(`- 工作区：${j.workspaceDir}`);
      if (j.preflight) L.push(renderPreflight(j.preflight));
      if (j.preflightOverride) L.push(`- 忽略本次预检（${j.preflightOverride.checkedAt}）：${j.preflightOverride.reason}；记录于 ${j.preflightOverride.at}`);
      for (const audit of j.preflightAudit ?? []) {
        L.push(`- 忽略预检审计（${audit.ignoredAt}）：${audit.reason}；绑定报告 ${audit.report.checkedAt}`);
        L.push(renderPreflight(audit.report));
      }
      if (j.taskIds.length) L.push(`- 开发文档：${j.devGuideVersion ? `v${j.devGuideVersion}（已写入 DEV_GUIDE.md 与构建提示词）` : '未使用（没有 G3 确认的开发文档）'}`);
      for (const v of j.verification?.items ?? []) L.push(`- 验收 ${v.criterionId}：${v.status}${v.note ? `（${v.note}）` : ''}`);
      for (const m of j.verification?.selfReportMismatches ?? []) L.push(`- ⚠️ ${m}`);
      if (j.report) L.push(`- Sol 总结：${j.report.summary}`);
      for (const checkpoint of j.workspaceCheckpoints ?? []) {
        L.push(`- 代码保留检查点：${checkpoint.commit}；时间 ${checkpoint.at}；${checkpoint.reason}。此操作不代表验收通过，原证据审计：${checkpoint.auditPath}`);
      }
      for (const round of j.rounds ?? []) for (const session of round.context?.sessions ?? []) for (const call of session.invocations ?? []) {
        L.push(`- CLI 会话调用 ${call.id}（${call.kind}）：线程 ${call.threadId ?? 'unknown'}；状态 ${call.status}；用量语义 ${call.context.usageSemantics}；压缩 ${call.context.compactions ?? 'unknown'}；${call.startedAt} → ${call.endedAt ?? 'unknown'}。计入本轮会话上限。`);
      }
      if (j.digest || run.chores?.digest) {
        L.push(`- Grok 构建摘要：${j.digest?.status ?? '未记录'}；任务 ${j.digest?.taskId ?? '未记录'}${j.digest?.reason ? `；跳过/缺失原因：${j.digest.reason}` : ''}`);
        if (j.digest?.output) {
          L.push(`  - 来源锚点：规格 ${j.digest.output.specRef ?? 'unknown'}；提交 ${j.digest.output.workspaceCommit ?? 'unknown'}`);
          for (const entry of j.digest.output.entries) L.push(`  - ${entry.text}〔来源 ${entry.sourceId}；逐字引用：${entry.quote}〕`);
        }
        L.push('  - 此摘要仅作导航，不能替代程序核验。');
      }
      if (j.budget) {
        const { usage: u, limits: b } = j.budget;
        L.push(`- 共同预算：轮次 ${u.buildRounds}/${b.maxRounds}；写者 ${u.writerSessions}/${b.maxWriterSessions}；模型调用 ${u.modelCalls}/${b.maxModelCalls}；主动运行 ${(u.activeMs / 60_000).toFixed(2)}/${b.maxActiveMinutes} 分钟`);
        L.push(`- 未决预留：调用 ${j.budget.reservedCalls.length}；写者 ${j.budget.reservedWriterSessions.length}；停止原因：${j.budget.exhaustedReason ?? '无'}`);
      }
      for (const round of j.rounds ?? []) {
        L.push(`#### 构建轮次 ${round.round}（${round.kind} / ${round.writer} / ${round.outcome}）`);
        L.push(`- 规格 ${j.spec.ref}；提交 ${round.workspaceCommit ?? '未知'}；代码树 ${round.treeHash ?? '未知'}；构建任务 ${round.buildTaskId}；评审任务 ${round.evaluateTaskId ?? '无'}`);
        L.push(`- 程序核验：${round.verification?.verdict ?? '缺失'}；独立评审：${round.evaluation?.verdict ?? '缺失'}${round.staleReason ? `；证据过期：${round.staleReason}` : ''}`);
        if (round.stoppedReason) L.push(`- 停止原因：${round.stoppedReason}`);
        if (round.reviewIntegrity && !round.reviewIntegrity.ok) L.push(`- 副本异常：${round.reviewIntegrity.errors.join('；')}`);
        for (const defect of round.evaluation?.defects ?? []) L.push(`- ${defect.id}〔${defect.severity}〕${defect.location}：${defect.fix}；${round.verifiedDefectIds.includes(defect.id) ? '复现日志已核对' : '未形成程序可核对的返工证据'}`);
        renderRoundContext(L, round);
      }
      if (run.finalReview?.enabled) L.push(`- Claude 终审：${j.finalReview?.verdict ?? '缺失'}；${j.finalReview?.summary ?? j.finalReviewMissingReason ?? '尚无结果'}`);
    }
  }
  if (run.finalChoice) {
    L.push('');
    L.push('## 最终选择');
    L.push(`- ${run.finalChoice.candidateId ?? '未选择（停止）'}${run.finalChoice.reason ? `：${run.finalChoice.reason}` : ''}`);
  }
  L.push('');
  L.push('## 执行元数据');
  L.push('| 任务 | 角色 | 请求型号/强度 | 执行端报告 | 型号已确认 | 输入版本 | 状态 | 用时 |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const t of run.tasks) {
    const m = t.meta;
    const writer = run.docWriters?.[t.phase as 'handbook' | 'devdoc' | 'prd'] ?? run.docWriter;
    const requestedModel = t.phase === 'adjudicate' ? '未记录' : ['prd', 'handbook', 'devdoc'].includes(t.phase) ? writer.model : run.models[t.role]?.model ?? '未记录';
    const requestedEffort = t.phase === 'adjudicate' ? 'ultra' : ['prd', 'handbook', 'devdoc'].includes(t.phase) ? writer.effort : run.models[t.role]?.effort ?? '未记录';
    L.push(
      `| ${t.id} | ${ROLE[t.role]} | ${m?.requestedModel ?? requestedModel} / ${m?.requestedEffort ?? requestedEffort} | ${m?.reportedModels.join(', ') || '未确认'}${m?.reportedModelSource ? `（${m.reportedModelSource}）` : ''} | ${m?.modelConfirmed ? '是' : '未确认'} | ${t.inputRef ?? ''} | ${t.status}/${t.outputValidity}${t.simulated ? '（模拟）' : ''} | ${m ? Math.round(m.durationMs / 1000) + 's' : ''} |`,
    );
  }
  const metrics = runMetrics(run);
  const minutes = (value: { minutes: number; unknownCount: number }) => `${value.minutes.toFixed(2)} 分钟${value.unknownCount ? `（另有 ${value.unknownCount} 项用时未知）` : ''}`;
  L.push('', '## 运行度量', `- 总模型时间：${minutes(metrics.modelTime.total)}（实际调用区间相加，包含结构修复/失败/取消，与墙钟时间不同）`);
  L.push(`- 墙钟时间：${metrics.wallClockMinutes === null ? '未知' : metrics.wallClockMinutes.toFixed(2) + ' 分钟'}`);
  L.push(`- 关卡等待：${minutes(metrics.gateWait.total)}`);
  L.push(`- 澄清题：${metrics.clarification.questionCount}；已作答：${metrics.clarification.answeredCount}；作答率：${metrics.clarification.answerRate === null ? '未知' : (metrics.clarification.answerRate * 100).toFixed(1) + '%'}`);
  L.push(`- 构建尝试：${metrics.buildAttempts}；轮次：${metrics.buildRounds ?? '未知（尚无轮次归档）'}；配额阻塞：${metrics.quotaBlocks}`);
  L.push(`- 首轮核验：${metrics.firstRoundVerification?.conclusion ?? '未知（不能从当前结果反推首轮）'}`);
  const contextHealth = metrics.contextHealth;
  L.push(`- 上下文健康：治理 ${contextHealth?.enabled === null || contextHealth === undefined ? 'unknown' : contextHealth.enabled ? '启用' : '关闭'}；实际观测已知 ${contextHealth?.knownSessions ?? 0}；unknown ${contextHealth?.unknownSessions ?? 0}`);
  for (const session of contextHealth?.sessions ?? []) {
    L.push(`  - ${session.jobId}/round-${session.round}/${session.sessionId}：语义 ${session.usageSemantics}；窗口 ${observed(session.contextWindow)}；峰值 ${observed(session.contextTokensPeak)}；compactions ${observed(session.compactions)}${session.promptEstimate ? `；提示估算 ${session.promptEstimate.estimatedTokens}/${session.promptEstimate.targetTokens}（${session.promptEstimate.estimateReference}，非实际观测）` : ''}`);
  }
  L.push('| 阶段 | 角色 | 调用 | 状态 | 模型时间 |', '| --- | --- | --- | --- | --- |');
  for (const bucket of metrics.modelTime.buckets) L.push(`| ${bucket.phase} | ${ROLE[bucket.role]} | ${bucket.kind} | ${bucket.status} | ${minutes(bucket)} |`);
  L.push('- 跨运行比较按模拟/真实、规格与冻结配置分组；度量不构成因果结论。');
  return L.join('\n');
}
