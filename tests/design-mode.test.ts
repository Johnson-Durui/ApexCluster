import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultDocWriters,
  estimateCalls,
  rankQuestions,
  resolveDesignMode,
  resolveDocWriters,
  type ModelCatalog,
} from '../src/core/design-mode.js';
import type { Question } from '../src/core/types.js';

function question(id: string, priority: Question['priority'], status: Question['status'] = 'open'): Question {
  return {
    id,
    localId: id,
    topic: 'other',
    priority,
    text: `问题 ${id}`,
    whyItMatters: '测试排序',
    multiSelect: false,
    options: [{ id: `${id}-A`, label: 'A', implication: '含义' }],
    defaultOptionIds: [`${id}-A`],
    defaultAssumption: '默认',
    askedBy: 'claude',
    phase: 'clarify',
    taskId: 'task-1',
    createdAt: '2026-10-23T00:00:00.000Z',
    snapshotVersion: 1,
    status,
    answer: status === 'answered' ? { optionIds: [`${id}-A`], otherText: null, note: '保留', answeredAt: '2026-10-23T00:01:00.000Z' } : null,
    appliedInSnapshot: status === 'answered' ? 2 : null,
    relatedQuestionIds: [],
  };
}

const base = { riskLevel: 'low' as const, constraints: [], questions: [] as Question[] };

test('auto 的三条规则任一触发 dual，否则 single；跳过澄清仍使用同一解析规则', () => {
  assert.equal(resolveDesignMode({ ...base, mode: 'auto', constraints: [{}, {}, {}, {}] }).mode, 'dual');
  assert.equal(resolveDesignMode({ ...base, mode: 'auto', riskLevel: 'high' }).mode, 'dual');
  assert.equal(resolveDesignMode({ ...base, mode: 'auto', questions: [question('Q1', 'blocking'), question('Q2', 'blocking'), question('Q3', 'blocking')] }).mode, 'dual');
  assert.equal(
    resolveDesignMode({
      ...base,
      mode: 'auto',
      questions: [question('Q1', 'blocking', 'skipped'), question('Q2', 'blocking', 'skipped'), question('Q3', 'blocking', 'skipped')],
    }).mode,
    'dual',
    'G1 将未答题采用默认并标为 skipped 后，仍属于用户未明确回答的阻塞题',
  );
  assert.deepEqual(resolveDesignMode({ ...base, mode: 'auto' }), {
    mode: 'single',
    reasons: ['未触发 dual 规则'],
    architects: ['claude'],
    reviewers: ['astra'],
  });
});

test('显式模式覆盖 auto；架构师覆盖只能记录 Claude -> Astra 的非主导者方案', () => {
  assert.equal(resolveDesignMode({ ...base, mode: 'single', riskLevel: 'high' }).mode, 'single');
  assert.equal(resolveDesignMode({ ...base, mode: 'dual' }).mode, 'dual');
  const overridden = resolveDesignMode({
    ...base,
    mode: 'single',
    architectOverride: { from: 'claude', to: 'astra', reason: '用户明确要求本轮由 Astra 提案' },
  });
  assert.deepEqual(overridden.architects, ['astra']);
  assert.deepEqual(overridden.reviewers, ['claude']);
  assert.equal(overridden.architectOverride?.proposalIsNonLeading, true);
  assert.match(overridden.reasons.at(-1)!, /用户显式/);
  assert.throws(() => resolveDesignMode({ ...base, mode: 'dual', architectOverride: { from: 'claude', to: 'astra', reason: 'x' } }), /不接受/);
});

test('rankQuestions 稳定排序并折叠，不删除或改写题目、答案和选项', () => {
  const questions = Array.from({ length: 14 }, (_, index) => question(`Q${14 - index}`, index < 2 ? 'optional' : index < 6 ? 'important' : 'blocking', index === 10 ? 'answered' : 'open'));
  const answer = questions[10]!.answer;
  const options = questions[10]!.options;
  const ranked = rankQuestions(questions);
  assert.equal(ranked.visible.length, 12);
  assert.equal(ranked.collapsed.length, 2);
  assert.equal(ranked.all.length, questions.length);
  assert.deepEqual(new Set(ranked.all), new Set(questions));
  assert.deepEqual(ranked.all.slice(0, 3).map((item) => item.priority), ['blocking', 'blocking', 'blocking']);
  assert.equal(questions[10]!.answer, answer);
  assert.equal(questions[10]!.options, options);
});

const models: ModelCatalog = {
  claude: { model: 'claude-opus-5-5' },
  astra: { model: 'gpt-6-astra' },
  sol: { model: 'gpt-6.1-sol' },
};

test('旧运行缺少 docWriters 时三种文档严格映射旧 docWriter', () => {
  const legacy = { role: 'sol' as const, model: 'historical-sol', effort: 'high' as const };
  assert.deepEqual(resolveDocWriters(models, legacy), { handbook: legacy, devdoc: legacy, prd: legacy });
});

test('新运行的逐文档建议值使用准确型号和强度，部分输入不覆盖旧字段', () => {
  const defaults = defaultDocWriters(models);
  assert.deepEqual(defaults, {
    handbook: { role: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' },
    devdoc: { role: 'astra', model: 'gpt-6-astra', effort: 'max' },
    prd: { role: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' },
  });
  const legacy = { role: 'sol' as const, model: 'historical-sol', effort: 'high' as const };
  assert.deepEqual(resolveDocWriters(models, legacy, { devdoc: { role: 'astra', effort: 'max' } }), {
    handbook: legacy,
    devdoc: defaults.devdoc,
    prd: legacy,
  });
});

test('estimateCalls 分别计算 single/dual、多作业、文档与每作业终审', () => {
  const writers = defaultDocWriters(models);
  const single = estimateCalls({
    clarifyWith: 'claude',
    design: resolveDesignMode({ ...base, mode: 'single' }),
    writeDocs: true,
    writePrd: true,
    docWriters: writers,
    jobs: 2,
    evaluator: { enabled: true, role: 'astra' },
    finalReview: { enabled: true, role: 'claude' },
    maxModelCallsPerJob: 8,
  });
  assert.deepEqual(single.baseByRole, { claude: 6, astra: 4, sol: 2, grok: 0 });
  assert.equal(single.baseTotal, 12);
  assert.deepEqual(single.jobBudgetUpperBound, { perJob: 8, allJobs: 16 });
  assert.ok(single.conditionalAdditions.some((item) => item.key === 'structural_repair'));

  const dual = estimateCalls({
    clarifyWith: 'skip',
    design: resolveDesignMode({ ...base, mode: 'dual' }),
    writeDocs: false,
    writePrd: false,
    docWriters: writers,
    jobs: 3,
    finalReview: { enabled: true, role: 'claude' },
  });
  assert.deepEqual(dual.baseByRole, { claude: 5, astra: 2, sol: 3, grok: 0 });
  assert.equal(dual.jobBudgetUpperBound.allJobs, null);
  const contextual = estimateCalls({
    clarifyWith: 'skip', design: resolveDesignMode({ ...base, mode: 'single' }), writeDocs: false, writePrd: false,
    docWriters: writers, jobs: 2, contextEnabled: true,
  });
  assert.equal(contextual.baseByRole.sol, 4, '每作业至少一个里程碑和一次最终整轮验收，复杂计划仍另计');
});
