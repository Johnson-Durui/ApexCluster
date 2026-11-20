import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockDevDoc, mockHandbook, mockPrd } from '../src/adapters/mock-scenarios.js';
import { buildCodexArgs, DEFAULT_CODEX_OPTIONS } from '../src/adapters/codex.js';
import type { DocTaskContext, ModelTaskSpec } from '../src/adapters/types.js';
import { layoutDiagram, proposalToSvg, textWidth } from '../src/core/diagram.js';
import { docFileNames, encodeRfc5987, renderDocMaterials, sourceCatalog, sourceIds } from '../src/core/docs.js';
import { checkDevDoc, checkHandbook, checkPrd, findPlaceholders, isSafeRelativePath, type DevDocCheckContext, type PrdCheckContext } from '../src/core/doc-checks.js';
import { renderHtmlFragment, renderMarkdown, renderStandaloneHtml, type DocModel } from '../src/core/doc-model.js';
import { CreateRunInputZ, GateInputZ, OUTPUT_SCHEMAS, type PrdOutput } from '../src/core/schemas.js';
import { lintStrictSchema, toStrictJsonSchema } from '../src/core/strict-json-schema.js';
import type { DocBasis, MvpSpec, Run } from '../src/core/types.js';
import { validateOutput } from '../src/core/validate.js';
import { migrateRun } from '../src/orchestrator/store.js';
import { buildDocPrompt, renderTemplate } from '../src/prompts/render.js';

const spec: MvpSpec = {
  ref: 'spec-aaaaaaaaaaaa',
  candidateId: 'C1',
  goal: '验证核心闭环',
  scopeIn: ['记一笔', '看汇总'],
  scopeOut: ['多用户'],
  acceptance: [
    { id: 'AC1', description: '单元测试通过', kind: 'command', command: 'npm test', expectExitCode: 0, outputIncludes: null },
    { id: 'AC2', description: '浏览器里记一笔', kind: 'manual', command: null, expectExitCode: null, outputIncludes: null },
  ],
  hypotheses: [],
  timeboxMinutes: 120,
  allowNetwork: true,
  comparisonQuestions: [],
};

const d: DocTaskContext = {
  kind: 'prd',
  docRef: 'docs-prd-v1-abcdef0123',
  version: 1,
  title: '记账',
  sourceIds: ['F1', 'F2', 'H1', 'Q1', 'C1', spec.ref],
  facts: [
    { id: 'F1', text: '核心流程 1：记一笔' },
    { id: 'F2', text: '核心流程 2：看汇总' },
  ],
  constraintIds: ['H1'],
  candidates: [
    {
      id: 'C1',
      title: '本地 Node',
      stack: ['Node.js 22', 'SQLite'],
      modules: [{ id: 'ui', name: '界面' }, { id: 'api', name: '服务' }],
      flows: [{ from: 'ui', to: 'api', label: 'HTTP', kind: 'call' }],
      workstreams: [
        { id: 'ws-api', title: '后端接口', dependsOn: [] },
        { id: 'ws-ui', title: '前端页面', dependsOn: ['ws-api'] },
      ],
    },
  ],
  specs: [spec],
  previous: null,
  previousVersion: null,
  revisionNotes: null,
};

const prdCtx: PrdCheckContext = { docRef: d.docRef, sourceIds: d.sourceIds, specs: [{ ref: spec.ref, acceptanceIds: ['AC1', 'AC2'] }], previous: null };
const hbCtx = { docRef: d.docRef, sourceIds: d.sourceIds, candidates: [{ id: 'C1', moduleIds: ['ui', 'api'] }], previous: null };
const devCtx: DevDocCheckContext = {
  docRef: d.docRef,
  sourceIds: d.sourceIds,
  candidates: [
    {
      id: 'C1',
      moduleIds: ['ui', 'api'],
      workstreamIds: ['ws-api', 'ws-ui'],
      acceptance: spec.acceptance.map((a) => ({ id: a.id, kind: a.kind, command: a.command })),
      hypothesisIds: [],
    },
  ],
};

test('来源目录：仅有原始 prompt 也可追踪，内联参考文档按冻结顺序编号并严格校验引用', () => {
  const snapshot = {
    version: 1,
    ref: 'v1-traceability',
    hash: 'traceability',
    createdAt: '2026-10-12T00:00:00.000Z',
    reason: 'initial',
    project: {
      title: '只有原始需求',
      prompt: '请做一个只在本机运行的清单工具。',
      coreFlows: [],
      existingStack: '',
      deployment: '',
      budget: '',
      acceptance: '',
      context: '',
      referenceDocuments: [{ name: '背景.md', content: '现有流程每天需要人工核对一次。' }],
    },
    constraints: [],
    facts: [],
    assumptions: [],
    openItems: [],
  };
  const run = {
    snapshots: [snapshot],
    questions: [],
    proposals: [],
    judgments: [],
    jobs: [],
    finalChoice: null,
  } as unknown as Run;
  const basis: DocBasis = {
    batch: 1,
    createdAt: snapshot.createdAt,
    snapshotRef: snapshot.ref,
    designRound: 1,
    candidateIds: [],
    candidates: [],
    decision: null,
    specRefs: [],
    jobIds: [],
    confirmReason: null,
  };

  const catalog = sourceCatalog(run, basis);
  assert.deepEqual(catalog.map((x) => x.id), ['REQ-1', 'REF-1']);
  assert.equal(catalog[0]!.text, snapshot.project.prompt);
  assert.equal(catalog[1]!.text, `背景.md\n${snapshot.project.referenceDocuments[0]!.content}`);
  const materials = renderDocMaterials(run, basis, { targetPlatform: 'Windows 11 x64（PowerShell）' });
  assert.match(materials, /REQ-1.*只在本机运行的清单工具/);
  assert.match(materials, /REF-1.*背景\.md.*每天需要人工核对一次/);

  const allowed = sourceIds(run, basis);
  const handbook = mockHandbook({ ...d, docRef: 'docs-handbook-v1-trace', sourceIds: allowed, facts: [], candidates: [], specs: [] });
  handbook.summary.problem.sources = ['REQ-1'];
  handbook.summary.solution.sources = ['REF-1'];
  const ctx = { docRef: handbook.docRef, sourceIds: allowed, candidates: [], previous: null };
  assert.deepEqual(checkHandbook(handbook, ctx).errors, []);
  handbook.summary.solution.sources = ['REF-99'];
  assert.ok(checkHandbook(handbook, ctx).errors.some((e) => e.includes('REF-99') && e.includes('不能编造来源')));
});

function errorsAfter(mutate: (p: PrdOutput) => void, ctx: PrdCheckContext = prdCtx): string[] {
  const p = structuredClone(mockPrd(d));
  mutate(p);
  return checkPrd(p, ctx).errors;
}

test('PRD：模拟输出通过全部检查（编号双向一致、每个 MVP 验收项挂到 AC）', () => {
  const p = mockPrd(d);
  const r = checkPrd(p, prdCtx);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(p.requirements.map((x) => `${x.id}:${x.decision}`), ['R-01:纳入', 'R-02:纳入', 'R-03:延后']);
  assert.deepEqual(p.mvpAcceptanceMap.map((m) => `${m.specAcceptanceId}->${m.acId}`), ['AC1->AC-01', 'AC2->AC-03']);
  // 通过 zod + 语义校验的完整入口
  const v = validateOutput('prd', p, { docRef: d.docRef, docSourceIds: d.sourceIds, docSpecs: prdCtx.specs });
  assert.equal(v.ok, true, v.errors.join('\n'));
});

test('PRD：检查能抓住编造来源、占位符、追踪断裂、MVP 验收项漏挂、待验证需求被纳入、修订时编号消失', () => {
  const has = (errs: string[], re: RegExp) => assert.ok(errs.some((e) => re.test(e)), `应包含 ${re}：\n${errs.join('\n')}`);
  has(errorsAfter((p) => (p.docRef = 'docs-x')), /docRef 不匹配/);
  has(errorsAfter((p) => (p.background.startReason.text = '启动原因【填写】')), /模板占位符/);
  has(errorsAfter((p) => (p.requirements[0]!.sources = ['F99'])), /不能编造来源/);
  has(errorsAfter((p) => (p.background.goals.sources = ['P-01'])), /不存在的编号 P-01/);
  has(errorsAfter((p) => p.mvpAcceptanceMap.pop()), /缺少 MVP 验收项 spec-aaaaaaaaaaaa\/AC2/);
  has(errorsAfter((p) => p.mvpAcceptanceMap.push({ ...p.mvpAcceptanceMap[0]! })), /出现了多次/);
  has(errorsAfter((p) => (p.acceptance[0]!.inMvp = false)), /inMvp=true/);
  has(errorsAfter((p) => (p.features[0]!.requirementIds = ['R-02'])), /两边要一致/);
  has(errorsAfter((p) => (p.requirements[0]!.priority = '待验证')), /不能直接纳入/);
  has(errorsAfter((p) => (p.requirements[0]!.featureIds = [])), /至少关联 1 个功能/);
  has(errorsAfter((p) => (p.features[0]!.acceptanceIds = [])), /至少要有 1 条验收标准|验收标准里没有/);
  has(errorsAfter((p) => (p.acceptance[1]!.requirementId = 'R-02')), /不属于功能/);
  has(errorsAfter((p) => (p.requirements[0]!.id = 'R1')), /格式不对/);
  has(errorsAfter((p) => (p.states.reason = null)), /不适用时必须写明原因/);
  has(errorsAfter((p) => (p.pending[0]!.owner = '')), /必须指定负责人/);
  const prev = structuredClone(mockPrd(d));
  prev.requirements.push({ id: 'R-09', name: '导出', sources: ['F1'], priority: '可延后', decision: '延后', reason: '下期', featureIds: [] });
  has(errorsAfter(() => undefined, { ...prdCtx, previous: prev }), /R-09「导出」在本版本中消失了/);
  // 段落没有来源只给警告，不阻塞
  const p = structuredClone(mockPrd(d));
  p.background.nonGoals.sources = [];
  const r = checkPrd(p, prdCtx);
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.includes('非目标')));
});

test('PRD：重写时保持旧编号；旧批次的来源不在本次材料里时引用上一版本记号 PRD-vN，而不是随便找个编号', () => {
  const prev = structuredClone(mockPrd(d));
  prev.requirements.push({ id: 'R-04', name: '导出 Excel', sources: ['spec-old'], priority: '重要', decision: '延后', reason: '下期', featureIds: [] });
  const sourceIds = [...d.sourceIds, 'PRD-v1'];
  const next = mockPrd({ ...d, sourceIds, previous: prev, previousVersion: 1, revisionNotes: '补充导出' });
  assert.deepEqual(checkPrd(next, { ...prdCtx, sourceIds, previous: prev }).errors, []);
  const r4 = next.requirements.find((x) => x.id === 'R-04')!;
  assert.equal(r4.decision, '延后');
  assert.deepEqual(r4.sources, ['PRD-v1']);
  assert.ok(next.pending.some((x) => x.item.includes('补充导出')));
  // 没有上一版本记号时，旧来源仍会被拒绝（不能编造）
  const bad = structuredClone(next);
  bad.requirements.find((x) => x.id === 'R-04')!.sources = ['spec-old'];
  assert.ok(checkPrd(bad, { ...prdCtx, sourceIds, previous: prev }).errors.some((e) => e.includes('spec-old')));
});

test('PRD：纳入的需求必须有直接指向它的验收标准；主流程不能引用不存在的需求', () => {
  // R-01 与 R-02 共用 F-01，但 F-01 的验收都指向 R-01 → R-02 没有验收
  const shared = errorsAfter((p) => {
    const f1 = p.features[0]!;
    const f2 = p.features[1]!;
    p.requirements[1]!.featureIds = ['F-01'];
    f1.requirementIds = ['R-01', 'R-02'];
    p.features = [f1];
    p.acceptance = p.acceptance.filter((a) => a.featureId === 'F-01');
    f1.acceptanceIds = p.acceptance.map((a) => a.id);
    p.mvpAcceptanceMap = p.mvpAcceptanceMap.map((m) => ({ ...m, acId: 'AC-01' }));
    void f2;
  });
  assert.ok(shared.some((e) => e.includes('R-02') && e.includes('没有任何验收标准')), shared.join('\n'));
  assert.ok(errorsAfter((p) => (p.flows[0]!.requirementIds = ['R-77'])).some((e) => e.includes('R-77')));
});

test('架构手册：模拟输出通过检查；缺模块、多候选、无关键流程都会被退回', () => {
  const h = mockHandbook(d);
  assert.deepEqual(checkHandbook(h, hbCtx).errors, []);
  const bad = structuredClone(h);
  bad.candidates[0]!.modules.pop();
  assert.ok(checkHandbook(bad, hbCtx).errors.some((e) => e.includes('缺少模块 api')));
  const extra = structuredClone(h);
  extra.candidates.push({ ...structuredClone(h.candidates[0]!), candidateId: 'C9' });
  assert.ok(checkHandbook(extra, hbCtx).errors.some((e) => e.includes('C9')));
  const noFlow = structuredClone(h);
  noFlow.candidates[0]!.keyFlows = [];
  assert.ok(checkHandbook(noFlow, hbCtx).errors.some((e) => e.includes('关键流程')));
  const fake = structuredClone(h);
  fake.summary.costAndTimeline.sources = ['预算表'];
  assert.ok(checkHandbook(fake, hbCtx).errors.some((e) => e.includes('不能编造来源')));
});

test('开发文档：模拟输出通过检查（模块逐一覆盖、验收命令原样照抄、步骤对应 MVP 工作流）', () => {
  const v = mockDevDoc(d);
  assert.deepEqual(checkDevDoc(v, devCtx).errors, []);
  const c = v.candidates[0]!;
  assert.deepEqual(c.modules.map((m) => m.moduleId), ['ui', 'api']);
  assert.deepEqual(c.testPlan.map((t) => `${t.acceptanceId}:${t.command}`), ['AC1:npm test', 'AC2:null']);
  assert.deepEqual(c.plan.filter((s) => s.workstreamId).map((s) => s.workstreamId), ['ws-api', 'ws-ui']);
  assert.ok(/验收命令/.test(c.plan.at(-1)!.step), '最后一步是原样运行全部验收命令');
  const ok = validateOutput('devdoc', v, { docRef: d.docRef, docSourceIds: d.sourceIds, devCandidates: devCtx.candidates });
  assert.equal(ok.ok, true, ok.errors.join('\n'));
  // 模拟“坏”输出：绝对路径会被退回
  assert.ok(checkDevDoc(mockDevDoc(d, true), devCtx).errors.some((e) => e.includes('相对路径')));
});

test('开发文档：不能改框架、不能改验收命令、不能漏验收项或假设、不能乱引编号', () => {
  const errs = (mutate: (c: ReturnType<typeof mockDevDoc>['candidates'][number]) => void, ctx: DevDocCheckContext = devCtx) => {
    const v = structuredClone(mockDevDoc(d));
    mutate(v.candidates[0]!);
    return checkDevDoc(v, ctx).errors;
  };
  const has = (list: string[], re: RegExp) => assert.ok(list.some((e) => re.test(e)), `应包含 ${re}：\n${list.join('\n')}`);
  has(errs((c) => c.modules.pop()), /缺少模块 api/);
  has(errs((c) => c.modules.push({ ...c.modules[0]!, moduleId: 'cache' })), /cache 不在已确认的框架中/);
  has(errs((c) => (c.modules[1]!.dependsOn = ['db'])), /依赖了不存在的模块 db/);
  has(errs((c) => (c.modules[0]!.interfaces = ' ')), /对外接口/);
  has(errs((c) => (c.testPlan[0]!.command = 'npm run test')), /AC1 的命令必须原样写成「npm test」/);
  has(errs((c) => (c.testPlan = c.testPlan.slice(1))), /testPlan 缺少 MVP 验收项 AC1/);
  has(errs((c) => c.testPlan.push({ acceptanceId: 'AC9', approach: 'x', command: null })), /不存在的验收项 AC9/);
  has(errs((c) => (c.plan[1]!.dependsOn = ['S99'])), /依赖了不存在的步骤 S99/);
  has(errs((c) => (c.plan[1]!.workstreamId = 'ws-x')), /工作流 ws-x 不在 MVP 计划中/);
  has(errs((c) => (c.layout[0]!.path = '../outside')), /相对路径/);
  has(errs((c) => c.openQuestions.push({ question: 'q', defaultDecision: '先按默认', relatedIds: ['Z9'] })), /不存在的编号 Z9/);
  has(errs((c) => c.openQuestions.push({ question: 'q', defaultDecision: ' ', relatedIds: [] })), /默认处理方式/);
  has(errs((c) => (c.purpose = '证明【填写】')), /模板占位符/);
  // 待验证假设必须有验证方法
  const withHyp: DevDocCheckContext = { ...devCtx, candidates: [{ ...devCtx.candidates[0]!, hypothesisIds: ['HY1'] }] };
  has(errs(() => undefined, withHyp), /缺少待验证假设 HY1/);
  // 候选不在本批 / 缺候选
  const v2 = structuredClone(mockDevDoc(d));
  v2.candidates[0]!.candidateId = 'C7';
  const e2 = checkDevDoc(v2, devCtx).errors;
  has(e2, /缺少候选 C1/);
  has(e2, /不在本批验证中的候选 C7/);
  // 命令空白差异不算改命令；没写进 commands.test 只给警告
  const spaced = errs((c) => (c.testPlan[0]!.command = '  npm   test '));
  assert.deepEqual(spaced, []);
  const v3 = structuredClone(mockDevDoc(d));
  v3.candidates[0]!.commands.test = ['npm run lint'];
  const r3 = checkDevDoc(v3, devCtx);
  assert.deepEqual(r3.errors, []);
  assert.ok(r3.warnings.some((w) => w.includes('npm test')));
});

test('开发文档：工作区相对路径判断', () => {
  for (const ok of ['src/', 'src\\app.ts', 'README.md', './tests', 'a/b..c/d']) assert.equal(isSafeRelativePath(ok), true, ok);
  for (const bad of ['', '  ', 'C:\\app', 'c:/x', '/etc/passwd', '\\\\server\\share', '~/x', '../x', 'src/../../x', 'a\\..\\b']) assert.equal(isSafeRelativePath(bad), false, bad);
});

test('占位符检查：返回字段路径', () => {
  assert.deepEqual(findPlaceholders({ a: '正常', b: ['x', '【填写】'], c: { d: 'TBD' } }), ['$.b[1]', '$.c.d']);
  assert.deepEqual(findPlaceholders({ a: '没有占位符的“引号”' }), []);
});

test('严格 schema：PRD、架构手册与开发文档可以生成且通过体检', () => {
  for (const k of ['prd', 'handbook', 'devdoc'] as const) {
    const s = toStrictJsonSchema(OUTPUT_SCHEMAS[k]);
    assert.deepEqual(lintStrictSchema(s), []);
  }
});

test('渲染：所有文字转义；Markdown 表格转义竖线；独立 HTML 无脚本、无外部资源', () => {
  const doc: DocModel = {
    title: '标题 <script>alert(1)</script>',
    subtitle: 'v1',
    banners: [{ tone: 'danger', text: '模拟数据 & 测试' }],
    blocks: [
      { t: 'h', level: 2, text: '1 <b>章</b>' },
      { t: 'p', label: '背景', text: '第一行\n第二行 <img src=x onerror=alert(1)>', sources: ['F1'] },
      { t: 'p', label: '无来源', text: '待确认', sources: [] },
      { t: 'table', head: ['a|b', 'c'], rows: [['x|y', '多行\n内容']] },
      { t: 'diagram', svg: proposalToSvg({ modules: [{ id: 'a', name: 'A<模块>', responsibility: '', tech: null }], flows: [] }), mermaid: 'flowchart LR', caption: '图' },
      { t: 'checklist', title: '检查', items: [{ ok: true, text: '一', note: '' }, { ok: false, text: '二', note: '缺' }] },
    ],
    footer: '页脚',
  };
  const html = renderStandaloneHtml(doc);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('第一行<br>第二行'));
  assert.ok(html.includes('A&lt;模块&gt;'));
  assert.ok(html.includes('〔来源：F1〕'));
  assert.ok(html.includes('无来源编号，请核对'));
  assert.ok(!/<script|https?:\/\/(?!www\.w3\.org\/2000\/svg)/i.test(html));
  // 检查清单的说明可以换行（不换行的长说明会让 Chrome 打印时把整页缩小）
  assert.ok(html.includes('<span class="ck-note none">（缺）</span>'));
  assert.ok(!/\.src\{[^}]*nowrap/.test(html));
  const frag = renderHtmlFragment(doc);
  assert.ok(frag.startsWith('<article class="dmw-doc">'));
  const md = renderMarkdown(doc);
  assert.ok(md.includes('| a\\|b | c |'));
  assert.ok(md.includes('| x\\|y | 多行<br>内容 |'));
  assert.ok(md.includes('```mermaid'));
  assert.ok(md.includes('☐ 二（缺）'));
});

test('Markdown 导出：模型文字不能伪造章节、加粗或代码块', () => {
  const doc: DocModel = {
    title: 'T',
    subtitle: 's',
    banners: [],
    blocks: [
      { t: 'p', label: '背景', text: '正常文字\n## 6 验收结论\n**结论**：通过', sources: [] },
      { t: 'h', level: 3, text: '流程\n# 假标题' },
      { t: 'list', items: ['一\n> 引用'] },
      { t: 'diagram', svg: '', mermaid: 'flowchart LR\n  a["x```y"]', caption: 'c' },
    ],
    footer: 'f',
  };
  const md = renderMarkdown(doc);
  const lines = md.split('\n');
  assert.ok(!lines.some((l) => /^## 6/.test(l)), '不能出现伪造的二级标题');
  assert.ok(!lines.some((l) => /^# 假标题/.test(l)));
  assert.ok(!lines.some((l) => /^> 引用/.test(l)));
  assert.ok(md.includes('\\*\\*结论\\*\\*'));
  assert.equal(md.split('```').length - 1, 2, '只能有一对代码围栏');
});

test('下载文件名：按字符截断不切开表情；filename* 编码合法', () => {
  const run = { title: `${'项目'.repeat(19)}x😀工具` } as unknown as Run;
  const v = { kind: 'prd', version: 1 } as unknown as Parameters<typeof docFileNames>[1];
  const names = docFileNames(run, v, 'md');
  assert.doesNotThrow(() => encodeRfc5987(names.utf8));
  assert.ok(!/[\uD800-\uDFFF]/.test(names.utf8.replace(/\uD83D\uDE00/g, '')));
  assert.equal(encodeRfc5987("a'(b)*"), "a%27%28b%29%2A");
  const lone = { title: 'ab\uD83D' } as unknown as Run;
  assert.doesNotThrow(() => encodeRfc5987(docFileNames(lone, v, 'html').utf8));
});

/** 简单的 XML 结构检查：标签成对、正确嵌套 */
function wellFormed(xml: string): boolean {
  const stack: string[] = [];
  for (const m of xml.matchAll(/<(\/?)([a-zA-Z][\w:-]*)[^>]*?(\/?)>/g)) {
    const [, close, name, self] = m;
    if (self) continue;
    if (close) {
      if (stack.pop() !== name) return false;
    } else stack.push(name!);
  }
  return stack.length === 0;
}

test('架构图 SVG：结构完整；跨层的边从下方绕行；回边从上方绕行；自环与未定义模块；节点互不重叠', () => {
  const p = {
    modules: [
      { id: 'user', name: '用户', responsibility: '', tech: null },
      { id: 'ui', name: '浏览器界面（名字很长很长很长很长很长很长很长很长很长）', responsibility: '', tech: 'React' },
      { id: 'api', name: 'API', responsibility: '', tech: 'Fastify' },
      { id: 'queue', name: '队列', responsibility: '', tech: null },
      { id: 'worker', name: '后台任务', responsibility: '', tech: null },
      { id: 'db', name: '数据库', responsibility: '', tech: 'SQLite' },
    ],
    flows: [
      { from: 'user', to: 'ui', label: '操作', kind: 'call' as const },
      { from: 'ui', to: 'api', label: 'HTTP', kind: 'call' as const },
      { from: 'api', to: 'queue', label: '入队', kind: 'event' as const },
      { from: 'queue', to: 'worker', label: '取任务', kind: 'event' as const },
      { from: 'worker', to: 'db', label: '写', kind: 'data' as const },
      { from: 'api', to: 'db', label: '读写', kind: 'data' as const },
      { from: 'worker', to: 'api', label: '完成', kind: 'event' as const },
      { from: 'api', to: 'api', label: '重试', kind: 'call' as const },
      { from: 'api', to: 'mail', label: '通知', kind: 'call' as const },
    ],
  };
  const L = layoutDiagram(p);
  const route = (from: string, to: string) => L.edges.find((e) => e.from === from && e.to === to)!.route;
  assert.equal(route('api', 'db'), 'under');
  assert.equal(route('worker', 'api'), 'over');
  assert.equal(route('api', 'api'), 'self');
  assert.equal(route('ui', 'api'), 'forward');
  assert.ok(L.nodes.find((n) => n.id === 'mail')!.missing);
  for (const a of L.nodes) {
    for (const b of L.nodes) {
      if (a === b) continue;
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.equal(overlap, false, `${a.id} 与 ${b.id} 重叠`);
    }
    assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.w <= L.width && a.y + a.h <= L.height);
  }
  const svg = proposalToSvg(p, { idPrefix: 'C1-v1' });
  assert.ok(wellFormed(svg));
  for (let n = 1; n <= p.flows.length; n++) assert.ok(svg.includes(`>${n}</text>`), `缺少编号 ${n}`);
  assert.ok(svg.includes('未定义模块：mail'));
  assert.ok(svg.includes('…'), '过长的名字应截断');
  assert.ok(svg.includes('id="C1-v1-arrow-call"'));
  assert.ok(textWidth('中文', 10) > textWidth('ab', 10));
});

test('提示词：文档提示词包含 docRef、修订意见和上一版本；用户内容里的 {{…}} 不会被当成未替换变量', () => {
  const schema = toStrictJsonSchema(OUTPUT_SCHEMAS.prd);
  const p = buildDocPrompt({
    kind: 'prd',
    request: { kind: 'prd', version: 2, seq: 3, docRef: 'docs-prd-v2-0123456789', reason: 'revision', revisionNotes: '把导出写进本期不做', previousVersion: 1, abandoned: false },
    materials: '材料里有用户写的 {{模板}} 文字',
    previous: { version: 1, content: { requirements: [{ id: 'R-01' }] } },
    schema,
  });
  assert.ok(p.includes('docs-prd-v2-0123456789'));
  assert.ok(p.includes('把导出写进本期不做'));
  assert.ok(p.includes('以 v1 为基础'));
  assert.ok(p.includes('"R-01"'));
  assert.ok(p.includes('{{模板}}'));
  assert.ok(p.includes('sources 填 PRD-v1'));
  // 新批次重写且带修订意见：两段说明都要有
  const both = buildDocPrompt({
    kind: 'handbook',
    request: { kind: 'handbook', version: 3, seq: 5, docRef: 'docs-handbook-v3-0123456789', reason: 'new_basis', revisionNotes: '请重写缺失的手册', previousVersion: 2, abandoned: false },
    materials: '材料',
    previous: { version: 2, content: {} },
    schema: toStrictJsonSchema(OUTPUT_SCHEMAS.handbook),
  });
  assert.ok(both.includes('重写原因') && both.includes('请重写缺失的手册') && both.includes('HB-v2'));
  // 开发文档：修订意见里无法处理的写进 openQuestions；沿用上一版本用 DEV-vN
  const dev = buildDocPrompt({
    kind: 'devdoc',
    request: { kind: 'devdoc', version: 2, seq: 4, docRef: 'docs-b1-devdoc-v2-r4', reason: 'revision', revisionNotes: '接口写到函数签名', previousVersion: 1, abandoned: false },
    materials: '材料',
    previous: { version: 1, content: {} },
    schema: toStrictJsonSchema(OUTPUT_SCHEMAS.devdoc),
  });
  assert.ok(dev.includes('docs-b1-devdoc-v2-r4'));
  assert.ok(dev.includes('relatedIds 填 DEV-v1'));
  assert.ok(dev.includes('写进 openQuestions'));
  assert.ok(dev.includes('一字不差'), '开发文档提示词要求验收命令原样照抄');
  assert.ok(!dev.includes('写进 pending'));
  assert.throws(() => renderTemplate('{{a}} {{b}}', { a: '1' }), /\{\{b\}\}/);
});

test('Codex：按配置让某些阶段不传 --output-schema（schema 只写在提示词里）', () => {
  const s = { phase: 'prd', model: 'gpt-6.1-sol', effort: 'max', sandbox: 'read_only', allowWeb: false, allowNetwork: false, gitRepo: false, resumeSessionId: null } as unknown as ModelTaskSpec;
  assert.ok(buildCodexArgs(s, DEFAULT_CODEX_OPTIONS, 'schema.json', 'out.txt').includes('--output-schema'));
  const args = buildCodexArgs(s, { ...DEFAULT_CODEX_OPTIONS, promptOnlySchemaPhases: ['prd'] }, 'schema.json', 'out.txt');
  assert.ok(!args.includes('--output-schema'));
  assert.ok(args.includes('-o'));
});

test('文档契约：新建默认开启两类文档；旧 G3_final 输入归一化为 G4_final', () => {
  const created = CreateRunInputZ.parse({ title: 't', mode: 'mock', project: { prompt: 'p' } });
  assert.equal(created.writeDocs, true);
  assert.equal(created.writePrd, true);
  const gate = GateInputZ.parse({ gate: 'G3_final', action: 'accept' });
  assert.equal(gate.gate, 'G4_final');
});

test('旧数据迁移：没有文档字段的运行补齐默认值，G3_final 改名为 G4_final', () => {
  const old = {
    gates: [{ id: 'G3_final', openedAt: '', resolvedAt: null, resolution: null, context: {} }],
    models: { sol: { role: 'sol', adapter: 'codex', model: 'gpt-6.1-sol', effort: 'max' } },
  } as unknown as Run;
  const r = migrateRun(old);
  assert.equal(r.writeDocs, false);
  assert.equal(r.writePrd, false, '旧运行没有 MVP 之后写 PRD 这一步');
  assert.deepEqual(r.docWriter, { role: 'sol', model: 'gpt-6.1-sol', effort: 'max' }, '旧运行的文档由 Sol 撰写');
  assert.deepEqual(r.docs, { batch: 0, bases: [], requests: [], versions: [], missing: [], requestSeq: 0 });
  assert.equal(r.gates[0]!.id, 'G4_final');
});

test('PRD：同时验证两个候选时，两份 MVP 规格的验收项都要挂到 AC', () => {
  const spec2: MvpSpec = { ...spec, ref: 'spec-bbbbbbbbbbbb', candidateId: 'C2', acceptance: [{ ...spec.acceptance[0]!, command: 'python -m pytest' }] };
  const d2: DocTaskContext = { ...d, sourceIds: [...d.sourceIds, 'C2', spec2.ref], specs: [spec, spec2] };
  const ctx2: PrdCheckContext = { ...prdCtx, sourceIds: d2.sourceIds, specs: [...prdCtx.specs, { ref: spec2.ref, acceptanceIds: ['AC1'] }] };
  const p = mockPrd(d2);
  assert.deepEqual(checkPrd(p, ctx2).errors, []);
  assert.equal(p.mvpAcceptanceMap.filter((m) => m.specRef === spec2.ref).length, 1);
  // 只挂了第一个规格 → 第二个规格的验收项会被指出
  const partial = structuredClone(p);
  partial.mvpAcceptanceMap = partial.mvpAcceptanceMap.filter((m) => m.specRef === spec.ref);
  assert.ok(checkPrd(partial, ctx2).errors.some((e) => e.includes(`${spec2.ref}/AC1`)));
});
