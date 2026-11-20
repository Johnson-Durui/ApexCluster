import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anonymizeForJudge, renderProposalCard, selfReferenceWarnings } from '../src/core/anonymize.js';
import { consolidate } from '../src/core/consolidate.js';
import { applyWeights, DEFAULT_CRITERIA } from '../src/core/criteria.js';
import { proposalToMermaid } from '../src/core/diagram.js';
import { answerQuestion, findInvalidatedAssumptions, groupQuestions, registerQuestions } from '../src/core/questions.js';
import type { ProposalOut, QuestionOut } from '../src/core/schemas.js';
import { buildConstraints, buildSnapshot, renderSnapshot } from '../src/core/snapshot.js';
import type { MvpSpec, Proposal, ProjectInput } from '../src/core/types.js';
import { extractJson, validateOutput } from '../src/core/validate.js';
import { commandMatches, normalizeCommand, verifyAcceptance, type ToolLogItem } from '../src/core/verify-mvp.js';
import { mockOutput } from '../src/adapters/mock-scenarios.js';
import type { ModelTaskSpec } from '../src/adapters/types.js';
import { buildReviewPrompt, renderTemplate } from '../src/prompts/render.js';
import { toStrictJsonSchema } from '../src/core/strict-json-schema.js';
import { OUTPUT_SCHEMAS } from '../src/core/schemas.js';

const project: ProjectInput = { title: '记账', prompt: '本地记账工具', coreFlows: ['记一笔', '看汇总'], existingStack: '', deployment: 'Windows 11', budget: '', acceptance: '', context: '' };
const constraints = buildConstraints([
  { text: '必须本机运行', kind: 'must' },
  { text: '不得依赖付费云服务', kind: 'must_not' },
]);
const now = '2026-10-08T00:00:00.000Z';

function qOut(localId: string, topic: QuestionOut['topic'] = 'data'): QuestionOut {
  return {
    localId,
    topic,
    priority: 'blocking',
    text: '需要同步吗？',
    whyItMatters: '影响架构',
    multiSelect: false,
    options: [
      { id: 'a', label: '不需要', implication: '纯本地' },
      { id: 'b', label: '需要', implication: '需要服务端' },
    ],
    defaultOptionIds: ['a'],
    defaultAssumption: '不需要同步',
  };
}

function mockSpec(phase: ModelTaskSpec['phase'], role: ModelTaskSpec['role'], ctx: Partial<ModelTaskSpec['context']> = {}): ModelTaskSpec {
  return {
    taskId: 't',
    runId: 'r',
    role,
    phase,
    attempt: 1,
    model: 'm',
    effort: 'max',
    prompt: '',
    outputSchema: toStrictJsonSchema(OUTPUT_SCHEMAS[phase]),
    cwd: '/tmp',
    logDir: '/tmp',
    timeoutMs: 1000,
    sandbox: 'read_only',
    allowNetwork: false,
    allowWeb: false,
    gitRepo: false,
    resumeSessionId: null,
    context: { snapshotRef: 'v1-abc', constraintIds: ['H1', 'H2'], criterionIds: DEFAULT_CRITERIA.map((c) => c.id), knownQuestionIds: ['Q1'], anonymousMap: null, recheckItems: null, spec: null, mockScenario: 'preference', ...ctx },
  };
}

function proposal(id: string, author: 'claude' | 'astra', out: ProposalOut, snapshotVersion = 2): Proposal {
  return { ...out, id, author, taskId: 't', snapshotVersion, designRound: 1 };
}

test('快照：用户输入=事实；回答=事实；跳过=假设；不确定=待确认；哈希随内容变化', () => {
  const s1 = buildSnapshot({ version: 1, project, constraints, questions: [], reason: '用户输入', now });
  assert.equal(s1.facts.length, 3); // 两条核心流程 + 部署条件
  assert.match(s1.ref, /^v1-[0-9a-f]{12}$/);
  let qs = registerQuestions([], [qOut('q1'), qOut('q2', 'deployment'), qOut('q3', 'security')], { role: 'claude', phase: 'clarify', taskId: 't', snapshotVersion: 1, now });
  qs = [
    answerQuestion(qs[0]!, { status: 'answered', optionIds: ['b'], otherText: null, note: '手机也要看' }, now),
    { ...qs[1]!, status: 'skipped' },
    answerQuestion(qs[2]!, { status: 'unsure', optionIds: [], otherText: null, note: null }, now),
  ];
  const s2 = buildSnapshot({ version: 2, project, constraints, questions: qs, reason: '回答', now });
  assert.equal(s2.facts.filter((f) => f.source.startsWith('answer:')).length, 1);
  assert.ok(s2.facts.at(-1)!.text.includes('需要') && s2.facts.at(-1)!.text.includes('手机也要看'));
  assert.equal(s2.assumptions.length, 1);
  assert.equal(s2.openItems.length, 1);
  assert.notEqual(s1.hash, s2.hash);
  const text = renderSnapshot(s2);
  assert.ok(text.includes('H2 [禁止]'));
  assert.ok(text.includes(s2.ref));
});

test('问题：全局编号、同主题的他方问题互相关联、按主题和优先级分组；回答校验', () => {
  const a = registerQuestions([], [qOut('q1'), qOut('q2', 'security')], { role: 'claude', phase: 'clarify', taskId: 't1', snapshotVersion: 1, now });
  const b = registerQuestions(a, [qOut('q1')], { role: 'astra', phase: 'clarify', taskId: 't2', snapshotVersion: 1, now });
  assert.deepEqual([...a, ...b].map((q) => q.id), ['Q1', 'Q2', 'Q3']);
  assert.deepEqual(b[0]!.relatedQuestionIds, ['Q1']);
  const groups = groupQuestions([...a, ...b]);
  assert.equal(groups[0]!.topic, 'data');
  assert.equal(groups[0]!.questions.length, 2);
  assert.throws(() => answerQuestion(a[0]!, { status: 'answered', optionIds: ['a', 'b'], otherText: null, note: null }, now), /单选/);
  assert.throws(() => answerQuestion(a[0]!, { status: 'answered', optionIds: ['zzz'], otherText: null, note: null }, now), /没有选项/);
  assert.throws(() => answerQuestion(a[0]!, { status: 'answered', optionIds: [], otherText: null, note: null }, now), /其他/);
  const other = answerQuestion(a[0]!, { status: 'answered', optionIds: [], otherText: '只在局域网', note: null }, now);
  assert.equal(other.answer?.otherText, '只在局域网');
});

test('被推翻的假设：方案在旧快照上依赖默认答案，之后回答不同 → 标记；已看到回答的方案不标记', () => {
  const [q] = registerQuestions([], [qOut('q1')], { role: 'claude', phase: 'clarify', taskId: 't', snapshotVersion: 1, now });
  const base = (mockOutput(mockSpec('propose', 'claude')).output as { proposals: ProposalOut[] }).proposals[0]!;
  const p = proposal('r1-claude-1', 'claude', { ...base, assumptions: [{ text: '不同步', questionId: 'Q1' }] }, 2);
  const changed = { ...answerQuestion(q!, { status: 'answered', optionIds: ['b'], otherText: null, note: null }, now), appliedInSnapshot: null };
  assert.deepEqual(findInvalidatedAssumptions([p], [changed]).get(p.id), ['Q1']);
  const same = answerQuestion(q!, { status: 'answered', optionIds: ['a'], otherText: null, note: null }, now);
  assert.equal(findInvalidatedAssumptions([p], [same]).size, 0);
  const seen = { ...changed, appliedInSnapshot: 2 };
  assert.equal(findInvalidatedAssumptions([p], [seen]).size, 0);
});

test('候选整理：两位评审都认为相同才合并；只有一方认为相同 → 只提示可能重复', () => {
  const base = (mockOutput(mockSpec('propose', 'claude')).output as { proposals: ProposalOut[] }).proposals[0]!;
  const ps = [proposal('c1', 'claude', base), proposal('a1', 'astra', base), proposal('a2', 'astra', base)];
  const both = consolidate(ps, { claude: [['c1', 'a1']], astra: [['a1', 'c1']] }, ['claude', 'astra']);
  assert.equal(both.length, 2);
  assert.equal(both[0]!.origin, 'both');
  assert.equal(both[0]!.representativeProposalId, 'c1');
  const one = consolidate(ps, { claude: [['c1', 'a2']], astra: [] }, ['claude', 'astra']);
  assert.equal(one.length, 3);
  assert.deepEqual(one.find((c) => c.memberProposalIds[0] === 'c1')!.possibleDuplicateOf.length, 1);
  const manual = consolidate(ps, { claude: [['c1', 'a2']], astra: [] }, ['claude', 'astra'], [['c1', 'a2']]);
  assert.equal(manual.length, 2);
  // 提案顺序交替：Claude-1、Astra-1、Astra-2（避免整体排在一方之后）
  assert.deepEqual(consolidate(ps, {}, ['claude', 'astra']).map((c) => c.memberProposalIds[0]), ['c1', 'a1', 'a2']);
});

test('匿名化：每位评审的顺序可复现且互相独立；卡片不含作者与自评', () => {
  const base = (mockOutput(mockSpec('propose', 'claude')).output as { proposals: ProposalOut[] }).proposals[0]!;
  const ps = ['c1', 'c2', 'a1', 'a2', 'a3'].map((id) => proposal(id, id.startsWith('c') ? 'claude' : 'astra', base));
  const m1 = anonymizeForJudge(ps, 42, 'claude');
  assert.deepEqual(m1, anonymizeForJudge(ps, 42, 'claude'));
  assert.deepEqual(Object.keys(m1), ['P1', 'P2', 'P3', 'P4', 'P5']);
  assert.notDeepEqual(Object.values(m1), Object.values(anonymizeForJudge(ps, 42, 'astra')));
  const card = renderProposalCard(base, 'P3');
  assert.ok(card.startsWith('### 候选 P3'));
  assert.ok(!card.includes('claude') && !card.includes('constraintChecks') && !card.includes('提出者自评'));
  assert.deepEqual(selfReferenceWarnings({ ...base, summary: '作为 Claude，我建议…' }).length, 1);
});

test('架构图：由模块与数据流确定性生成；未定义模块用虚线标出；转义特殊字符', () => {
  const m = proposalToMermaid({
    modules: [
      { id: 'ui', name: '浏览器 "界面"', responsibility: '', tech: 'React' },
      { id: 'api', name: 'API', responsibility: '', tech: null },
    ],
    flows: [
      { from: 'ui', to: 'api', label: '调用|JSON', kind: 'call' },
      { from: 'api', to: 'db', label: '读写', kind: 'data' },
    ],
  });
  assert.ok(m.startsWith('flowchart LR'));
  assert.ok(m.includes('n1["浏览器 #quot;界面#quot;<br/><small>React</small>"]'));
  assert.ok(m.includes('n1 -->|"调用/JSON"| n2'));
  assert.ok(m.includes('x1["未定义模块：db"]:::missing'));
  assert.ok(m.includes('n2 -.->|"读写"| x1'));
});

test('验收核验：只认“最后一次修改代码之后”执行的命令；自报与日志不符会被标出', () => {
  const spec: MvpSpec = {
    ref: 'spec-x',
    candidateId: 'C1',
    goal: 'g',
    scopeIn: [],
    scopeOut: [],
    acceptance: [
      { id: 'AC1', description: '测试', kind: 'command', command: 'npm test', expectExitCode: 0, outputIncludes: null },
      { id: 'AC2', description: '构建', kind: 'command', command: 'npm run build', expectExitCode: 0, outputIncludes: 'built' },
      { id: 'AC3', description: '人工', kind: 'manual', command: null, expectExitCode: null, outputIncludes: null },
    ],
    hypotheses: [],
    timeboxMinutes: 60,
    allowNetwork: true,
    comparisonQuestions: [],
  };
  const log: ToolLogItem[] = [
    { seq: 0, type: 'command_execution', command: 'powershell.exe -Command "npm run build"', exitCode: 0, output: 'built', status: 'completed', paths: [] },
    { seq: 1, type: 'file_change', command: null, exitCode: null, output: null, status: 'completed', paths: ['a.ts'] },
    { seq: 2, type: 'command_execution', command: 'powershell.exe -Command "npm test"', exitCode: 1, output: '1 failing', status: 'failed', paths: [] },
  ];
  const report = { acceptanceResults: [{ criterionId: 'AC1', status: 'pass', evidence: '' }] } as never;
  const v = verifyAcceptance(spec, log, report, []);
  assert.deepEqual(v.items.map((i) => i.status), ['verified_fail', 'not_observed', 'awaiting_user']);
  assert.ok(v.items[1]!.note.includes('之前'));
  assert.equal(v.verdict, 'failed');
  assert.equal(v.selfReportMismatches.length, 1);
  assert.equal(commandMatches('npm run test:e2e', 'npm run test'), false);
  assert.equal(commandMatches('cmd /c "npm run test && echo ok"', 'npm run test'), true);
  assert.equal(commandMatches('python -m pytest -q', 'python -m pytest -q'), true);
  assert.equal(commandMatches('python -m pytest -q -k smoke', 'python -m pytest -q'), false);
});

test('验收命令：识别 Windows 包装的转义引号，保留脚本差异、退出码和路径边界', () => {
  const expected = `node -e "const p=require('./package.json');console.log('deps='+Object.keys(p.dependencies??{}).length);process.exit(0)"`;
  const wrapped = `pwsh.exe -Command "${expected.replaceAll('"', '\\"')}"`;
  assert.equal(commandMatches(wrapped, expected), true);
  assert.equal(commandMatches(wrapped.replace('process.exit(0)', 'process.exit(1)'), expected), false);
  assert.equal(commandMatches(wrapped.replace('p.dependencies', 'p.devDependencies'), expected), false);
  assert.equal(commandMatches('npm run test:e2e', 'npm run test'), false);
  assert.equal(normalizeCommand(String.raw`node C:\work\test.js`), String.raw`node c:\work\test.js`);
  const spec = { acceptance: [{ id: 'A4', kind: 'command', command: expected, expectExitCode: 0, outputIncludes: null }] } as MvpSpec;
  const log: ToolLogItem[] = [{ seq: 0, type: 'command_execution', command: wrapped, exitCode: -1, output: 'process failed', status: 'failed', paths: [] }];
  assert.equal(verifyAcceptance(spec, log, null).items[0]?.status, 'verified_fail');
});

test('输出校验：模拟数据全部合法；常见错误能被发现（缺评分、无依据给分、引用不存在模块、问题缺选项、版本不符）', () => {
  const clarify = mockOutput(mockSpec('clarify', 'claude')).output;
  assert.equal(validateOutput('clarify', clarify, { snapshotRef: 'v1-abc' }).ok, true);
  assert.match(validateOutput('clarify', clarify, { snapshotRef: 'v9-zzz' }).errors[0]!, /snapshotRef 不匹配/);

  const propose = mockOutput(mockSpec('propose', 'claude')).output as { proposals: ProposalOut[] };
  assert.equal(validateOutput('propose', propose, { snapshotRef: 'v1-abc', constraintIds: ['H1', 'H2'], knownQuestionIds: ['Q1'] }).ok, true);
  const badFlow = structuredClone(propose);
  badFlow.proposals[0]!.flows.push({ from: 'ui', to: 'nowhere', label: 'x', kind: 'call' });
  assert.ok(validateOutput('propose', badFlow, { snapshotRef: 'v1-abc', constraintIds: ['H1', 'H2'] }).errors.some((e) => e.includes('nowhere')));

  const map = { P1: 'r1-claude-1', P2: 'r1-astra-1' };
  const review = mockOutput(mockSpec('review', 'astra', { anonymousMap: map })).output as { reviews: { scores: { score: number | null; evidence: unknown[] }[] }[] };
  const ctx = { snapshotRef: 'v1-abc', constraintIds: ['H1', 'H2'], criterionIds: DEFAULT_CRITERIA.map((c) => c.id), anonymousIds: ['P1', 'P2'] };
  assert.equal(validateOutput('review', review, ctx).ok, true);
  const noEvidence = structuredClone(review);
  noEvidence.reviews[0]!.scores[0]!.evidence = [];
  assert.ok(validateOutput('review', noEvidence, ctx).errors.some((e) => e.includes('依据')));
  const half = structuredClone(review);
  half.reviews[0]!.scores[0]!.score = 3.5;
  assert.ok(validateOutput('review', half, ctx).errors.some((e) => e.includes('整数')));
  const missing = structuredClone(review);
  missing.reviews.pop();
  assert.ok(validateOutput('review', missing, ctx).errors.some((e) => e.includes('缺少对候选')));

  const badQ = structuredClone(clarify) as { questions: QuestionOut[] };
  badQ.questions[0]!.options = badQ.questions[0]!.options.slice(0, 1);
  assert.ok(validateOutput('clarify', badQ, { snapshotRef: 'v1-abc' }).errors.some((e) => e.includes('至少需要 2 个选项')));
});

test('extractJson：纯 JSON、代码块、夹在文字里的 JSON', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('结果如下：\n```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJson('好的 {"a":3} 完毕'), { a: 3 });
  assert.equal(extractJson('没有 JSON'), null);
});

test('权重：和必须为 1；不静默归一化', () => {
  assert.throws(() => applyWeights(DEFAULT_CRITERIA, { fit: 0.5 }), /之和必须为 1/);
  const w = applyWeights(DEFAULT_CRITERIA, { fit: 0.4, cost: 0.2, reliability: 0.2, performance: 0.1, evolution: 0.1 });
  assert.equal(w.find((c) => c.id === 'fit')!.weight, 0.4);
  assert.throws(() => applyWeights(DEFAULT_CRITERIA, { nope: 1 } as never), /未知评分项/);
});

test('提示词：评审提示词含匿名卡片与评分锚点、不含作者；未替换变量会报错', () => {
  const s = buildSnapshot({ version: 2, project, constraints, questions: [], reason: 'x', now });
  const base = (mockOutput(mockSpec('propose', 'claude')).output as { proposals: ProposalOut[] }).proposals[0]!;
  const ps = [proposal('r1-claude-1', 'claude', base), proposal('r1-astra-1', 'astra', { ...base, title: '另一个' })];
  const text = buildReviewPrompt(s, DEFAULT_CRITERIA, { P1: 'r1-astra-1', P2: 'r1-claude-1' }, ps, { maxQuestions: 12, maxProposals: 3 }, toStrictJsonSchema(OUTPUT_SCHEMAS.review));
  assert.ok(text.includes('### 候选 P1：另一个'));
  assert.ok(text.includes('0 分：'));
  assert.ok(text.includes(s.ref));
  assert.ok(!/r1-claude|r1-astra|author/.test(text));
  assert.throws(() => renderTemplate('a {{b}}', {}), /未替换/);
});
