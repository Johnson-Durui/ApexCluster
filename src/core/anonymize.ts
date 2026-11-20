/**
 * 匿名化：评审时候选以 P1..Pn 出现，顺序按（种子 × 评审）随机，且用统一模板渲染，
 * 不显示作者、不显示提出者的约束自评。种子与映射记录在 run.anonymization，便于审计。
 * 注意：匿名化只能降低、不能消除自评偏差（模型可能认出自己的思路），所以决策引擎另外做区间处理与诊断。
 */
import type { DesignRole, Proposal } from './types.js';
import type { ProposalOut } from './schemas.js';
import { seededShuffle } from './util.js';

const JUDGE_SALT: Record<DesignRole, number> = { claude: 0x9e3779b9, astra: 0x85ebca6b };

export function anonymizeForJudge(proposals: Proposal[], seed: number, judge: DesignRole): Record<string, string> {
  const shuffled = seededShuffle(proposals, (seed ^ JUDGE_SALT[judge]) >>> 0);
  const map: Record<string, string> = {};
  shuffled.forEach((p, i) => {
    map[`P${i + 1}`] = p.id;
  });
  return map;
}

/** 已知模型/厂商名字出现在方案正文里时给出提示（不改写正文，避免破坏合法内容，比如“调用 OpenAI API”） */
export function selfReferenceWarnings(p: ProposalOut): string[] {
  const text = JSON.stringify(p);
  const hits = ['Claude', 'Anthropic', 'GPT', 'OpenAI', 'Astra', 'Codex'].filter((w) => text.includes(w));
  return hits.length ? [`方案正文提到了 ${hits.join('、')}，评审可能据此识别作者`] : [];
}

const SEV = { high: '高', medium: '中', low: '低' } as const;
const FLOW = { call: '调用', data: '数据', event: '事件' } as const;

export function renderProposalCard(p: ProposalOut, label: string): string {
  const L: string[] = [];
  L.push(`### 候选 ${label}：${p.title}`);
  L.push('');
  L.push(`**摘要**：${p.summary}`);
  if (p.fitWhen.length) L.push(`**适用前提**：\n${p.fitWhen.map((x) => `- ${x}`).join('\n')}`);
  if (p.notFitWhen.length) L.push(`**不适用于**：\n${p.notFitWhen.map((x) => `- ${x}`).join('\n')}`);
  L.push('**技术栈**：');
  L.push('| 层 | 选择 | 理由 |');
  L.push('| --- | --- | --- |');
  for (const s of p.stack) L.push(`| ${s.layer} | ${s.choice} | ${s.reason.replace(/\|/g, '/')} |`);
  L.push('**模块**：');
  for (const m of p.modules) L.push(`- \`${m.id}\` ${m.name}${m.tech ? `（${m.tech}）` : ''}：${m.responsibility}`);
  if (p.flows.length) {
    L.push('**调用与数据流**：');
    for (const f of p.flows) L.push(`- \`${f.from}\` → \`${f.to}\`（${FLOW[f.kind]}）：${f.label}`);
  }
  L.push(`**数据模型**：${p.dataModel}`);
  L.push(`**部署与运行**：${p.deployment}`);
  if (p.tradeoffs.length) L.push(`**取舍**：\n${p.tradeoffs.map((t) => `- 得：${t.gain}｜代价：${t.cost}`).join('\n')}`);
  if (p.risks.length) L.push(`**已知风险**：\n${p.risks.map((r) => `- [${SEV[r.severity]}] ${r.text}${r.mitigation ? `；缓解：${r.mitigation}` : ''}`).join('\n')}`);
  if (p.assumptions.length) L.push(`**依赖的假设**：\n${p.assumptions.map((a) => `- ${a.text}${a.questionId ? `（${a.questionId}）` : ''}`).join('\n')}`);
  const m = p.mvpPlan;
  L.push('**最小 MVP 计划**：');
  L.push(`- 目标：${m.goal}`);
  if (m.scopeIn.length) L.push(`- 范围内：${m.scopeIn.join('；')}`);
  if (m.scopeOut.length) L.push(`- 范围外：${m.scopeOut.join('；')}`);
  for (const a of m.acceptance) L.push(`- 验收 ${a.id}：${a.description}${a.kind === 'command' && a.command ? `（命令：\`${a.command}\`）` : '（人工）'}`);
  for (const h of m.hypotheses) L.push(`- 待验证假设 ${h.id}：${h.text}；通过标准：${h.passCriteria}`);
  L.push(`- 预计投入：${m.estimatedEffort}`);
  return L.join('\n');
}
