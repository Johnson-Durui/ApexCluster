/**
 * 提示词渲染。模板是同目录下的 .md 文件（方便你直接阅读和修改），变量写作 {{name}}。
 * 模板自身缺少变量时直接报错；用户需求与参考文档里的 {{…}} 保持原样。
 */
import { readFileSync } from 'node:fs';
import { renderProposalCard } from '../core/anonymize.js';
import { renderCriteriaForPrompt } from '../core/criteria.js';
import { previousToken } from '../core/docs.js';
import { renderSnapshot } from '../core/snapshot.js';
import { schemaToCompactString, type JsonSchema } from '../core/strict-json-schema.js';
import type { AdjudicationRecord, Criterion, DocKind, DocRequest, MvpSpec, Proposal, RequirementSnapshot, Run } from '../core/types.js';

export type TemplateName = 'clarify' | 'propose' | 'review' | 'recheck' | 'adjudicate' | 'build' | 'build-rework' | 'evaluate' | 'final-review' | 'prd' | 'handbook' | 'devdoc' | 'repair' | 'probe';

export function buildEvaluationPrompt(material: unknown, schema: JsonSchema): string {
  return renderTemplate(loadTemplate('evaluate'), { material: JSON.stringify(material, null, 2), schemaBlock: schemaBlock(schema) });
}

export function buildFinalReviewPrompt(material: unknown, schema: JsonSchema): string {
  return renderTemplate(loadTemplate('final-review'), { material: JSON.stringify(material, null, 2), schemaBlock: schemaBlock(schema) });
}

export function buildReworkPrompt(material: unknown): string {
  return renderTemplate(loadTemplate('build-rework'), { material: JSON.stringify(material, null, 2) });
}

const cache = new Map<TemplateName, string>();

export function loadTemplate(name: TemplateName): string {
  const hit = cache.get(name);
  if (hit) return hit;
  const text = readFileSync(new URL(`./${name}.md`, import.meta.url), 'utf8');
  cache.set(name, text);
  return text;
}

export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    if (!Object.hasOwn(vars, key)) throw new Error(`提示词变量未替换：${match}`);
    return vars[key]!;
  });
}

export function schemaBlock(schema: JsonSchema): string {
  return `## 输出格式（JSON Schema；工作台会严格校验）\n\`\`\`json\n${schemaToCompactString(schema)}\n\`\`\``;
}

const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '- （无）');

export interface PromptLimits {
  maxQuestions: number;
  maxProposals: number;
}

export function buildClarifyPrompt(s: RequirementSnapshot, limits: PromptLimits, schema: JsonSchema): string {
  return renderTemplate(loadTemplate('clarify'), {
    maxQuestions: String(limits.maxQuestions),
    snapshotRef: s.ref,
    snapshot: renderSnapshot(s),
    schemaBlock: schemaBlock(schema),
  });
}

export function buildProposePrompt(s: RequirementSnapshot, limits: PromptLimits, targetPlatform: string, schema: JsonSchema): string {
  return renderTemplate(loadTemplate('propose'), {
    maxProposals: String(limits.maxProposals),
    maxQuestions: String(limits.maxQuestions),
    targetPlatform,
    constraintIds: s.constraints.map((h) => h.id).join('、') || '（无硬约束）',
    snapshotRef: s.ref,
    snapshot: renderSnapshot(s),
    schemaBlock: schemaBlock(schema),
  });
}

/** 按匿名映射渲染候选卡片（顺序 = P1..Pn） */
export function renderCards(map: Record<string, string>, proposals: Proposal[]): string {
  return Object.entries(map)
    .sort((a, b) => Number(a[0].slice(1)) - Number(b[0].slice(1)))
    .map(([anon, pid]) => renderProposalCard(proposals.find((p) => p.id === pid)!, anon))
    .join('\n\n---\n\n');
}

export function buildReviewPrompt(s: RequirementSnapshot, criteria: Criterion[], map: Record<string, string>, proposals: Proposal[], limits: PromptLimits, schema: JsonSchema): string {
  return renderTemplate(loadTemplate('review'), {
    constraintIds: s.constraints.map((h) => h.id).join('、') || '（无硬约束）',
    maxQuestions: String(limits.maxQuestions),
    criteria: renderCriteriaForPrompt(criteria),
    snapshotRef: s.ref,
    snapshot: renderSnapshot(s),
    candidates: renderCards(map, proposals),
    schemaBlock: schemaBlock(schema),
  });
}

export function buildRecheckPrompt(s: RequirementSnapshot, criteria: Criterion[], cardsText: string, itemsText: string, schema: JsonSchema): string {
  return renderTemplate(loadTemplate('recheck'), {
    criteria: renderCriteriaForPrompt(criteria),
    snapshotRef: s.ref,
    snapshot: renderSnapshot(s),
    candidates: cardsText,
    items: itemsText,
    schemaBlock: schemaBlock(schema),
  });
}

export function buildAdjudicationPrompt(run: Run, snapshot: RequirementSnapshot, record: AdjudicationRecord, schema: JsonSchema): string {
  const proposals = run.proposals.filter(p => p.designRound === run.designRound);
  const candidates = run.candidates.map(candidate => ({
    candidateId: candidate.id,
    proposals: candidate.memberProposalIds.map(id => renderProposalCard(proposals.find(p => p.id === id)!, candidate.id)),
    reviews: run.judgments.filter(j => j.designRound === run.designRound && candidate.memberProposalIds.includes(j.proposalId)),
  }));
  return renderTemplate(loadTemplate('adjudicate'), {
    snapshotRef: snapshot.ref,
    snapshot: renderSnapshot(snapshot),
    criteria: renderCriteriaForPrompt(run.criteria),
    material: JSON.stringify({ candidates, eligibleCandidateIds: record.candidateIds, items: record.items,
      decision: run.decision, recheckLog: run.recheckLog.filter(entry =>
        (entry.designRound === record.designRound || (entry.designRound === undefined && record.designRound === 1)) && entry.batch === record.batch), questions: run.questions }, null, 2),
    schemaBlock: schemaBlock(schema),
  });
}

export function buildBuildPrompt(args: {
  snapshot: RequirementSnapshot;
  candidateCard: string;
  spec: MvpSpec;
  effort: 'max' | 'ultra';
  workstreams: { id: string; title: string; dependsOn: string[] }[];
  targetPlatform: string;
  schema: JsonSchema;
  devGuide?: string | null;
  preflight?: string | null;
}): string {
  const { spec } = args;
  const parallelHint =
    args.effort === 'ultra' && args.workstreams.length > 1
      ? `11. 本次以 Ultra 强度运行：下列工作流相互独立，可以交给子代理并行完成，最后由你统一集成并运行验收：\n${args.workstreams
          .map((w) => `   - ${w.id} ${w.title}${w.dependsOn.length ? `（依赖 ${w.dependsOn.join('、')}）` : ''}`)
          .join('\n')}`
      : '';
  const comparison = spec.comparisonQuestions.length
    ? `\n本次是多个候选的对比验证之一，以下问题必须用实测数据回答（写进 hypothesisResults 或 openIssues）：\n${list(spec.comparisonQuestions)}`
    : '';
  return renderTemplate(loadTemplate('build'), {
    targetPlatform: args.targetPlatform,
    timeboxMinutes: String(spec.timeboxMinutes),
    specRef: spec.ref,
    parallelHint,
    candidate: args.candidateCard,
    goal: spec.goal,
    scopeIn: list(spec.scopeIn),
    scopeOut: list(spec.scopeOut),
    acceptance: list(
      spec.acceptance.map((a) => `${a.id}（${a.kind === 'command' ? `命令：\`${a.command}\`，期望退出码 ${a.expectExitCode ?? 0}${a.outputIncludes ? `，输出包含「${a.outputIncludes}」` : ''}` : '人工'}）：${a.description}`),
    ),
    hypotheses: list(spec.hypotheses.map((h) => `${h.id}：${h.text}；通过标准：${h.passCriteria}`)),
    comparison,
    preflight: args.preflight ?? '（本次没有环境预检报告；不得据此推断工具或网络已可用。）',
    devGuide: args.devGuide
      ? `## 开发文档（G3 已确认；也已写入工作区 DEV_GUIDE.md）\n优先级：MVP 规格 > 已确认的框架 > 开发文档。三者冲突时以前者为准；没有按开发文档做的地方写进 deviations。\n\n${args.devGuide}`
      : '## 开发文档\n（本次没有开发文档：新建时关闭了 MVP 前的文档，或它在撰写失败后被跳过。按已确认的框架和 MVP 规格实现。）',
    snapshot: renderSnapshot(args.snapshot),
    schemaBlock: schemaBlock(args.schema),
  });
}

/** 架构说明手册、开发文档（MVP 前）与 PRD（MVP 后） */
export function buildDocPrompt(args: {
  kind: DocKind;
  request: DocRequest;
  materials: string;
  previous: { version: number; content: unknown } | null;
  schema: JsonSchema;
}): string {
  const { request: r, previous } = args;
  const token = previous ? previousToken(args.kind, previous.version) : '';
  const dev = args.kind === 'devdoc';
  const keepIds = { prd: 'R/F/AC/M 编号', handbook: '编号', devdoc: '实施步骤编号（S1、S2…）' }[args.kind];
  const carry = dev
    ? `沿用上一版本、但本批材料里找不到依据的未定问题，relatedIds 填 ${token}。`
    : `沿用上一版本、但本批材料里找不到来源的内容，sources 填 ${token}。`;
  const revisionRule = previous
    ? `这是 v${r.version}，以 v${previous.version} 为基础：已有的${keepIds}${dev ? '尽量' : ''}保持不变；${args.kind === 'prd' ? '删除的需求也要保留（本期处理改为“延后”并写明原因）；' : ''}新增内容使用新的编号。${carry}`
    : `这是第一版（v${r.version}）。`;
  let revision = '';
  if (r.reason === 'new_basis') revision += `\n## 重写原因\n用户在 G2 重新确认了框架或 MVP 范围，下面的材料已经更新。以新材料为准重写${dev ? '（模块、验收项和工作流以新材料为准）' : '，保持已有编号稳定'}。\n`;
  if (r.revisionNotes) revision += `\n## 评审修订意见（逐条处理；无法处理的写进 ${dev ? 'openQuestions' : 'pending'} 并说明原因）\n${r.revisionNotes}\n`;
  const prev = previous ? `\n## 上一版本（v${previous.version}）的内容（只用于保持编号与沿用已确认的写法）\n\`\`\`json\n${JSON.stringify(previous.content, null, 1)}\n\`\`\`\n` : '';
  return renderTemplate(loadTemplate(args.kind), {
    docRef: r.docRef,
    revisionRule,
    revision,
    materials: args.materials,
    previous: prev,
    schemaBlock: schemaBlock(args.schema),
  });
}

export function buildRepairPrompt(errors: string[], previousOutput: string, originalPrompt: string | null, schema: JsonSchema): string {
  return renderTemplate(loadTemplate('repair'), {
    errors: list(errors.slice(0, 40)),
    previousOutput: `\`\`\`\n${previousOutput.slice(0, 60_000)}\n\`\`\``,
    originalTask: originalPrompt ? `\n## 原始任务（供参考）\n${originalPrompt}` : '',
    schemaBlock: schemaBlock(schema),
  });
}

export function buildProbePrompt(schema: JsonSchema): string {
  return renderTemplate(loadTemplate('probe'), { schemaBlock: schemaBlock(schema) });
}
