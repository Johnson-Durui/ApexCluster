/**
 * PRD 与架构手册的语义检查（纯函数）。
 * errors：结构性问题 → 触发一次修复，仍失败则任务标记“输出结构不合法”；
 * warnings：不阻塞，随文档版本保存，在文档页和导出里提示评审人重点核对。
 *
 * 核心原则：文档里的每个来源编号都必须来自工作台已有的记录（需求快照、问题、候选、MVP 规格），
 * 不能编造；材料里没有的信息只能写进“待确认事项”，并给出负责人和期限。
 */
import type { DevDocOutput, HandbookOutput, Para, PendingItem, PrdOutput } from './schemas.js';

export const ID_PATTERNS = {
  requirement: /^R-\d{2,3}$/,
  feature: /^F-\d{2,3}$/,
  acceptance: /^AC-\d{2,3}$/,
  metric: /^M-\d{2,3}$/,
} as const;

export interface PrdCheckContext {
  docRef: string;
  /** 材料中可以引用的来源编号（F1/A1/O1/H1/Q1/C1/U1/spec-…） */
  sourceIds: string[];
  /** 本批 MVP 规格及其验收项 */
  specs: { ref: string; acceptanceIds: string[] }[];
  /** 上一版本（修订或重写时检查编号稳定性） */
  previous: PrdOutput | null;
}

export interface HandbookCheckContext {
  docRef: string;
  sourceIds: string[];
  /** 本批候选及其模块编号 */
  candidates: { id: string; moduleIds: string[] }[];
  previous: HandbookOutput | null;
}

export interface CheckResult {
  errors: string[];
  warnings: string[];
}

function dupes(xs: string[]): string[] {
  const seen = new Set<string>();
  const d = new Set<string>();
  for (const x of xs) (seen.has(x) ? d : seen).add(x);
  return [...d];
}

const PLACEHOLDER = /[【】]|\bTBD\b|填写示例|（虚构）|\(虚构\)/i;

/** 找出仍含模板占位符的字段路径（例如“【填写】”） */
export function findPlaceholders(value: unknown, path = '$', out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (PLACEHOLDER.test(value)) out.push(path);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => findPlaceholders(v, `${path}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) findPlaceholders(v, `${path}.${k}`, out);
  }
  return out;
}

function checkParas(paras: [string, Para][], allowed: Set<string>, errors: string[], warnings: string[]): void {
  for (const [where, p] of paras) {
    if (!p.text.trim()) errors.push(`${where}：正文不能为空（材料不足就写明“待确认”并加入待确认事项）`);
    const bad = p.sources.filter((s) => !allowed.has(s));
    if (bad.length) errors.push(`${where}：引用了材料中不存在的编号 ${bad.join('、')}（不能编造来源）`);
    if (p.sources.length === 0) warnings.push(`${where}：没有来源编号，评审时请重点核对`);
  }
}

function checkPending(items: PendingItem[], allowed: Set<string>, errors: string[]): void {
  items.forEach((x, i) => {
    const w = `待确认事项 ${i + 1}`;
    if (!x.item.trim()) errors.push(`${w}：事项不能为空`);
    if (!x.owner.trim()) errors.push(`${w}：必须指定负责人（不知道就写“待指定”）`);
    if (!x.due.trim()) errors.push(`${w}：必须写期限（不知道就写“待定”）`);
    const bad = x.relatedIds.filter((id) => !allowed.has(id));
    if (bad.length) errors.push(`${w}：关联了不存在的编号 ${bad.join('、')}`);
  });
}

function checkNa(where: string, x: { applicable: boolean; reason: string | null }, hasContent: boolean, errors: string[]): void {
  if (!x.applicable && !x.reason?.trim()) errors.push(`${where}：标为不适用时必须写明原因`);
  if (x.applicable && !hasContent) errors.push(`${where}：标为适用但没有内容`);
}

// =====================================================================================
// PRD
// =====================================================================================
export function checkPrd(v: PrdOutput, ctx: PrdCheckContext): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (v.docRef !== ctx.docRef) errors.push(`docRef 不匹配：期望 ${ctx.docRef}，实际 ${v.docRef}`);
  if (!v.module.trim()) errors.push('module 不能为空');
  if (!v.plannedVersion.trim()) errors.push('plannedVersion 不能为空');
  for (const p of findPlaceholders(v).slice(0, 20)) errors.push(`${p}：仍含模板占位符或示例文字（【…】、TBD、虚构示例），请替换为实际内容或写入待确认事项`);

  const materials = new Set(ctx.sourceIds);
  const rIds = v.requirements.map((r) => r.id);
  const fIds = v.features.map((f) => f.id);
  const acIds = v.acceptance.map((a) => a.id);
  const mIds = v.metrics.map((m) => m.id);
  const own = new Set([...rIds, ...fIds, ...acIds, ...mIds]);
  const allowedForText = new Set([...materials, ...own]);

  // ---- 编号格式与唯一性
  const fmt = (ids: string[], re: RegExp, name: string, example: string) => {
    for (const id of ids) if (!re.test(id)) errors.push(`${name}编号「${id}」格式不对，应为 ${example}`);
    const d = dupes(ids);
    if (d.length) errors.push(`${name}编号重复：${d.join('、')}`);
  };
  fmt(rIds, ID_PATTERNS.requirement, '需求', 'R-01');
  fmt(fIds, ID_PATTERNS.feature, '功能', 'F-01');
  fmt(acIds, ID_PATTERNS.acceptance, '验收', 'AC-01');
  fmt(mIds, ID_PATTERNS.metric, '指标', 'M-01');
  if (v.requirements.length === 0) errors.push('需求总表不能为空');

  // ---- 段落来源
  checkParas(
    [
      ['背景与证据', v.background.evidence],
      ['本期启动原因', v.background.startReason],
      ['目标', v.background.goals],
      ['约束', v.background.constraints],
      ['非目标', v.background.nonGoals],
      ['本期必交付', v.boundary.mustDeliver],
      ['本期不做', v.boundary.notDoing],
      ...v.userStories.map((p, i): [string, Para] => [`用户故事 ${i + 1}`, p]),
    ],
    allowedForText,
    errors,
    warnings,
  );
  v.roles.forEach((r, i) => {
    const bad = r.sources.filter((s) => !allowedForText.has(s));
    if (bad.length) errors.push(`角色 ${i + 1}「${r.role}」：引用了不存在的编号 ${bad.join('、')}`);
  });

  // ---- 需求
  for (const r of v.requirements) {
    const w = `需求 ${r.id}`;
    if (!r.name.trim()) errors.push(`${w}：名称不能为空`);
    if (r.sources.length === 0) errors.push(`${w}：必须注明来源编号（需求快照、问题等）`);
    const bad = r.sources.filter((s) => !materials.has(s));
    if (bad.length) errors.push(`${w}：来源 ${bad.join('、')} 不在材料中（不能编造来源）`);
    if (!r.reason.trim()) errors.push(`${w}：本期处理必须写明理由`);
    if (r.priority === '待验证' && r.decision === '纳入') errors.push(`${w}：优先级为“待验证”的需求不能直接纳入本期开发`);
    if (r.decision === '纳入' && r.featureIds.length === 0) errors.push(`${w}：纳入本期的需求至少关联 1 个功能`);
    for (const f of r.featureIds) if (!fIds.includes(f)) errors.push(`${w}：关联了不存在的功能 ${f}`);
  }

  // ---- 功能（与需求双向一致）
  for (const f of v.features) {
    const w = `功能 ${f.id}`;
    if (f.requirementIds.length === 0) errors.push(`${w}：必须关联至少 1 条需求`);
    for (const r of f.requirementIds) {
      const req = v.requirements.find((x) => x.id === r);
      if (!req) errors.push(`${w}：关联了不存在的需求 ${r}`);
      else if (!req.featureIds.includes(f.id)) errors.push(`${w} 关联了 ${r}，但 ${r} 的关联功能里没有 ${f.id}（两边要一致）`);
    }
    for (const a of f.acceptanceIds) {
      const ac = v.acceptance.find((x) => x.id === a);
      if (!ac) errors.push(`${w}：关联了不存在的验收标准 ${a}`);
      else if (ac.featureId !== f.id) errors.push(`${w} 列出了 ${a}，但 ${a} 关联的功能是 ${ac.featureId}`);
    }
    const included = f.requirementIds.some((r) => v.requirements.find((x) => x.id === r)?.decision === '纳入');
    if (included && f.acceptanceIds.length === 0) errors.push(`${w}：属于本期纳入的需求，至少要有 1 条验收标准`);
    if (!f.emptyAndFailure.trim()) warnings.push(`${w}：没有写空态与失败处理`);
  }
  for (const r of v.requirements) {
    for (const f of r.featureIds) {
      const feat = v.features.find((x) => x.id === f);
      if (feat && !feat.requirementIds.includes(r.id)) errors.push(`需求 ${r.id} 关联了 ${f}，但 ${f} 的关联需求里没有 ${r.id}（两边要一致）`);
    }
  }

  // ---- 验收标准
  for (const a of v.acceptance) {
    const w = `验收 ${a.id}`;
    const feat = v.features.find((x) => x.id === a.featureId);
    if (!feat) errors.push(`${w}：关联了不存在的功能 ${a.featureId}`);
    else if (!feat.acceptanceIds.includes(a.id)) errors.push(`${w} 关联 ${a.featureId}，但 ${a.featureId} 的验收标准里没有 ${a.id}`);
    if (!rIds.includes(a.requirementId)) errors.push(`${w}：关联了不存在的需求 ${a.requirementId}`);
    else if (feat && !feat.requirementIds.includes(a.requirementId)) errors.push(`${w}：需求 ${a.requirementId} 不属于功能 ${a.featureId}`);
    if (!a.given.trim() || !a.when.trim() || !a.then.trim()) errors.push(`${w}：给定条件、执行操作、预期结果都必须填写`);
  }
  // 纳入本期的每条需求，都要有验收标准直接指向它（不能只靠共用功能下其他需求的验收）
  for (const r of v.requirements) {
    if (r.decision === '纳入' && !v.acceptance.some((a) => a.requirementId === r.id)) errors.push(`需求 ${r.id}：纳入本期，但没有任何验收标准的 requirementId 指向它`);
  }

  // ---- MVP 验收项 → AC
  const mappedAc = new Set<string>();
  const seen = new Set<string>();
  for (const m of v.mvpAcceptanceMap) {
    const key = `${m.specRef}/${m.specAcceptanceId}`;
    const spec = ctx.specs.find((s) => s.ref === m.specRef);
    if (!spec) errors.push(`mvpAcceptanceMap：MVP 规格 ${m.specRef} 不存在`);
    else if (!spec.acceptanceIds.includes(m.specAcceptanceId)) errors.push(`mvpAcceptanceMap：${m.specRef} 中没有验收项 ${m.specAcceptanceId}`);
    if (seen.has(key)) errors.push(`mvpAcceptanceMap：${key} 出现了多次（每个 MVP 验收项只挂到一条 AC）`);
    seen.add(key);
    const ac = v.acceptance.find((x) => x.id === m.acId);
    if (!ac) errors.push(`mvpAcceptanceMap：${key} 挂到了不存在的验收标准 ${m.acId}`);
    else if (!ac.inMvp) errors.push(`mvpAcceptanceMap：${key} 挂到的 ${m.acId} 必须标为本期 MVP 验证（inMvp=true）`);
    mappedAc.add(m.acId);
  }
  for (const s of ctx.specs) {
    for (const id of s.acceptanceIds) if (!seen.has(`${s.ref}/${id}`)) errors.push(`mvpAcceptanceMap：缺少 MVP 验收项 ${s.ref}/${id} 对应的 AC`);
  }
  for (const a of v.acceptance) if (a.inMvp && !mappedAc.has(a.id)) warnings.push(`验收 ${a.id} 标为本期 MVP 验证，但没有任何 MVP 验收项对应它，MVP 不会检查这一条`);

  // ---- 指标
  for (const m of v.metrics) for (const r of m.requirementIds) if (!rIds.includes(r)) errors.push(`指标 ${m.id}：关联了不存在的需求 ${r}`);

  // ---- 可不适用的章节
  checkNa('业务状态', v.states, v.states.rows.length > 0, errors);
  checkNa('角色权限', v.permissions, v.permissions.rows.length > 0, errors);
  checkNa('发布计划', v.release, !!(v.release.scope.trim() && v.release.rollback.trim()), errors);
  checkNa('AI 功能补充', v.ai, !!v.ai.boundary.trim(), errors);
  if (v.flows.length === 0) errors.push('至少需要 1 条主流程');
  v.flows.forEach((f, i) => {
    const bad = f.requirementIds.filter((r) => !rIds.includes(r));
    if (bad.length) errors.push(`主流程 ${i + 1}「${f.name}」：关联了不存在的需求 ${bad.join('、')}`);
  });
  for (const q of v.quality) if (!q.threshold.trim() || !q.method.trim()) warnings.push(`质量要求「${q.kind}」：缺少阈值或验证方法，无法测试`);

  // ---- 待确认事项
  checkPending(v.pending, allowedForText, errors);

  // ---- 修订时编号稳定
  if (ctx.previous) {
    for (const r of ctx.previous.requirements) {
      if (!rIds.includes(r.id)) errors.push(`上一版本的需求 ${r.id}「${r.name}」在本版本中消失了：删除需求也要保留记录（把本期处理改为“延后”并写明原因）`);
    }
    const lostF = ctx.previous.features.map((f) => f.id).filter((id) => !fIds.includes(id));
    if (lostF.length) warnings.push(`上一版本的功能 ${lostF.join('、')} 在本版本中不存在，请确认是有意删除`);
    const lostAc = ctx.previous.acceptance.map((a) => a.id).filter((id) => !acIds.includes(id));
    if (lostAc.length) warnings.push(`上一版本的验收标准 ${lostAc.join('、')} 在本版本中不存在，请确认是有意删除`);
  }
  return { errors, warnings };
}

// =====================================================================================
// 架构手册
// =====================================================================================
export function checkHandbook(v: HandbookOutput, ctx: HandbookCheckContext): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (v.docRef !== ctx.docRef) errors.push(`docRef 不匹配：期望 ${ctx.docRef}，实际 ${v.docRef}`);
  for (const p of findPlaceholders(v).slice(0, 20)) errors.push(`${p}：仍含模板占位符或示例文字，请替换为实际内容或写入待确认事项`);
  const allowed = new Set(ctx.sourceIds);
  const s = v.summary;
  checkParas(
    [
      ['摘要·要解决的问题', s.problem],
      ['摘要·方案', s.solution],
      ['摘要·为什么选它', s.whyThis],
      ['摘要·投入与时间', s.costAndTimeline],
      ['摘要·主要风险', s.risks],
      ['摘要·需要决定的事', s.decisionsNeeded],
    ],
    allowed,
    errors,
    warnings,
  );
  const got = v.candidates.map((c) => c.candidateId);
  const d = dupes(got);
  if (d.length) errors.push(`候选重复：${d.join('、')}`);
  for (const c of ctx.candidates) if (!got.includes(c.id)) errors.push(`缺少候选 ${c.id} 的说明`);
  for (const id of got) if (!ctx.candidates.some((c) => c.id === id)) errors.push(`说明了不在本批验证中的候选 ${id}`);
  for (const c of v.candidates) {
    const ref = ctx.candidates.find((x) => x.id === c.candidateId);
    const w = `候选 ${c.candidateId}`;
    checkParas(
      [
        [`${w}·概述`, c.overview],
        [`${w}·数据与安全`, c.dataAndSecurity],
        [`${w}·运维`, c.operations],
        [`${w}·质量与测试`, c.quality],
      ],
      allowed,
      errors,
      warnings,
    );
    if (ref) {
      const mids = c.modules.map((m) => m.moduleId);
      for (const id of ref.moduleIds) if (!mids.includes(id)) errors.push(`${w}：缺少模块 ${id} 的通俗说明`);
      for (const id of mids) if (!ref.moduleIds.includes(id)) errors.push(`${w}：说明了方案中不存在的模块 ${id}`);
      const md = dupes(mids);
      if (md.length) errors.push(`${w}：模块说明重复：${md.join('、')}`);
    }
    for (const m of c.modules) if (!m.plainExplanation.trim()) errors.push(`${w}：模块 ${m.moduleId} 的说明不能为空`);
    if (c.keyFlows.length === 0) errors.push(`${w}：至少写 1 条关键流程，帮助非技术读者理解系统怎么工作`);
    c.keyFlows.forEach((f, i) => {
      if (f.steps.length < 2) warnings.push(`${w}·关键流程 ${i + 1}「${f.name}」：步骤少于 2 步`);
      const bad = f.sources.filter((x) => !allowed.has(x));
      if (bad.length) errors.push(`${w}·关键流程 ${i + 1}：引用了材料中不存在的编号 ${bad.join('、')}`);
    });
  }
  const gd = dupes(v.glossary.map((g) => g.term));
  if (gd.length) warnings.push(`术语表有重复：${gd.join('、')}`);
  checkPending(v.pending, allowed, errors);
  return { errors, warnings };
}

// =====================================================================================
// 开发文档（给 AI 开发者）
// =====================================================================================
export interface DevDocCheckContext {
  docRef: string;
  sourceIds: string[];
  /** 本批每个候选：模块、工作流、MVP 验收项（命令型的命令）、待验证假设 */
  candidates: {
    id: string;
    moduleIds: string[];
    workstreamIds: string[];
    acceptance: { id: string; kind: 'command' | 'manual'; command: string | null }[];
    hypothesisIds: string[];
  }[];
}

const normCmd = (c: string | null | undefined) => (c ?? '').trim().replace(/\s+/g, ' ');

/** 工作区内的相对路径：不能是绝对路径、盘符、UNC，也不能用 .. 跳出工作区 */
export function isSafeRelativePath(p: string): boolean {
  const t = p.trim();
  if (!t) return false;
  if (/^[a-zA-Z]:/.test(t) || t.startsWith('/') || t.startsWith('\\') || t.startsWith('~')) return false;
  return !t.split(/[\\/]+/).some((seg) => seg === '..');
}

export function checkDevDoc(v: DevDocOutput, ctx: DevDocCheckContext): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (v.docRef !== ctx.docRef) errors.push(`docRef 不匹配：期望 ${ctx.docRef}，实际 ${v.docRef}`);
  for (const p of findPlaceholders(v).slice(0, 20)) errors.push(`${p}：仍含模板占位符或示例文字，请替换为实际内容或写进 openQuestions`);
  const allowed = new Set(ctx.sourceIds);
  const got = v.candidates.map((c) => c.candidateId);
  const d = dupes(got);
  if (d.length) errors.push(`候选重复：${d.join('、')}`);
  for (const c of ctx.candidates) if (!got.includes(c.id)) errors.push(`缺少候选 ${c.id} 的开发文档`);
  for (const id of got) if (!ctx.candidates.some((c) => c.id === id)) errors.push(`写了不在本批验证中的候选 ${id}`);

  for (const c of v.candidates) {
    const ref = ctx.candidates.find((x) => x.id === c.candidateId);
    const w = `候选 ${c.candidateId}`;
    if (!c.purpose.trim()) errors.push(`${w}：purpose 不能为空`);
    // 模块：必须逐一覆盖已确认框架的模块，不能新增（新增模块等于改框架）
    const mids = c.modules.map((m) => m.moduleId);
    if (ref) {
      for (const id of ref.moduleIds) if (!mids.includes(id)) errors.push(`${w}：缺少模块 ${id} 的说明`);
      for (const id of mids) if (!ref.moduleIds.includes(id)) errors.push(`${w}：模块 ${id} 不在已确认的框架中（开发文档不能改变框架；需要时写进 openQuestions）`);
    }
    const md = dupes(mids);
    if (md.length) errors.push(`${w}：模块重复：${md.join('、')}`);
    for (const m of c.modules) {
      if (!m.interfaces.trim()) errors.push(`${w}·${m.moduleId}：必须写清对外接口（输入、输出、错误）`);
      for (const dep of m.dependsOn) if (!mids.includes(dep)) errors.push(`${w}·${m.moduleId}：依赖了不存在的模块 ${dep}`);
    }
    // 目录：只能是工作区内的相对路径
    if (c.layout.length === 0) errors.push(`${w}：至少列出主要目录或文件（layout）`);
    for (const l of c.layout) if (!isSafeRelativePath(l.path)) errors.push(`${w}：路径「${l.path}」必须是工作区内的相对路径（不能用绝对路径、盘符或 ..）`);
    // 实施步骤
    const sids = c.plan.map((s) => s.id);
    if (c.plan.length === 0) errors.push(`${w}：至少写 1 个实施步骤（plan）`);
    if (dupes(sids).length) errors.push(`${w}：实施步骤编号重复：${dupes(sids).join('、')}`);
    for (const s of c.plan) {
      for (const dep of s.dependsOn) if (!sids.includes(dep)) errors.push(`${w}·${s.id}：依赖了不存在的步骤 ${dep}`);
      if (s.workstreamId && ref && !ref.workstreamIds.includes(s.workstreamId)) errors.push(`${w}·${s.id}：工作流 ${s.workstreamId} 不在 MVP 计划中`);
      if (!s.done.trim()) warnings.push(`${w}·${s.id}：没有写完成标志`);
    }
    // 验收：每个 MVP 验收项恰好一条；命令型必须原样使用规格里的命令
    if (ref) {
      const seen = c.testPlan.map((t) => t.acceptanceId);
      const dd = dupes(seen);
      if (dd.length) errors.push(`${w}：验收项重复：${dd.join('、')}`);
      for (const a of ref.acceptance) {
        const t = c.testPlan.find((x) => x.acceptanceId === a.id);
        if (!t) {
          errors.push(`${w}：testPlan 缺少 MVP 验收项 ${a.id}`);
          continue;
        }
        if (a.kind === 'command' && normCmd(t.command) !== normCmd(a.command)) {
          errors.push(`${w}：验收项 ${a.id} 的命令必须原样写成「${a.command}」（工作台按这条命令核对执行日志），实际「${t.command ?? ''}」`);
        }
        if (a.kind === 'command' && !c.commands.test.some((x) => normCmd(x) === normCmd(a.command))) {
          warnings.push(`${w}：commands.test 里没有验收命令「${a.command}」`);
        }
      }
      for (const id of seen) if (!ref.acceptance.some((a) => a.id === id)) errors.push(`${w}：testPlan 引用了不存在的验收项 ${id}`);
      for (const h of ref.hypothesisIds) if (!c.hypothesisChecks.some((x) => x.hypothesisId === h)) errors.push(`${w}：缺少待验证假设 ${h} 的验证方法`);
      for (const x of c.hypothesisChecks) if (!ref.hypothesisIds.includes(x.hypothesisId)) errors.push(`${w}：hypothesisChecks 引用了不存在的假设 ${x.hypothesisId}`);
    }
    c.openQuestions.forEach((q, i) => {
      const bad = q.relatedIds.filter((id) => !allowed.has(id));
      if (bad.length) errors.push(`${w}·未定问题 ${i + 1}：关联了材料中不存在的编号 ${bad.join('、')}`);
      if (!q.defaultDecision.trim()) errors.push(`${w}·未定问题 ${i + 1}：必须写默认处理方式`);
    });
    if (c.commands.run.length === 0) warnings.push(`${w}：commands.run 为空`);
  }
  return { errors, warnings };
}
