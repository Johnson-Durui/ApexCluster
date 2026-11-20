import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRouteLightRework, checkDigest, checkQgroup, DigestOutputZ, QgroupOutputZ, safeLightReworkDefectPath, type LightReworkInput } from '../src/core/chores.js';
import { createJobBudget } from '../src/core/job-budget.js';

const source = {
  id: 'S1', text: '按钮必须在离线状态下保持禁用。', specRef: 'spec-1', workspaceCommit: 'abc123', taskId: 't-build', logRange: { from: 1, to: 3 },
};

test('digest 只接受同锚点、已知来源的逐字引用，语义仍标记未核验', () => {
  const valid = checkDigest(
    { specRef: 'spec-1', workspaceCommit: 'abc123', entries: [{ text: '离线时禁用按钮', sourceId: 'S1', quote: '离线状态下保持禁用' }] },
    { specRef: 'spec-1', workspaceCommit: 'abc123', sources: [source] },
  );
  assert.deepEqual(valid, { ok: true, errors: [], validation: 'source_exact_semantics_unverified' });
  const context = { specRef: 'spec-1', workspaceCommit: 'abc123', sources: [source] };
  assert.equal(checkDigest({ specRef: 'old', workspaceCommit: 'abc123', entries: [] }, context).ok, false);
  assert.equal(checkDigest({ specRef: 'spec-1', workspaceCommit: 'old', entries: [] }, context).ok, false);
  assert.match(checkDigest({ specRef: 'spec-1', workspaceCommit: 'abc123', entries: [{ text: 'x', sourceId: 'unknown', quote: 'x' }] }, context).errors.join('\n'), /未知/);
  assert.match(checkDigest({ specRef: 'spec-1', workspaceCommit: 'abc123', entries: [{ text: 'x', sourceId: 'S1', quote: '' }] }, context).errors.join('\n'), /不能为空/);
  assert.match(checkDigest({ specRef: 'spec-1', workspaceCommit: 'abc123', entries: [{ text: '任意结论', sourceId: 'S1', quote: '   ' }] }, { ...context, sources: [{ ...source, text: '包含   空格' }] }).errors.join('\n'), /纯空白/);
  assert.match(checkDigest({ specRef: 'spec-1', workspaceCommit: 'abc123', entries: [{ text: 'x', sourceId: 'S1', quote: '并不存在' }] }, context).errors.join('\n'), /逐字子串/);
  assert.match(checkDigest({ specRef: 'spec-1', workspaceCommit: 'abc123', entries: [{ text: ' ', sourceId: 'S1', quote: '按钮' }] }, context).errors.join('\n'), /text/);
  assert.match(checkDigest({ specRef: 'spec-1', workspaceCommit: 'abc123', entries: [{ text: '错误的模型解读', sourceId: 'S1', quote: '按钮' }] }, context).validation, /semantics_unverified/);
  const staleSource = { ...source, workspaceCommit: 'different' };
  assert.match(checkDigest({ specRef: 'spec-1', workspaceCommit: 'abc123', entries: [{ text: 'x', sourceId: 'S1', quote: '按钮' }] }, { ...context, sources: [staleSource] }).errors.join('\n'), /不同锚点/);
});

test('digest/qgroup schema 严格拒绝额外字段', () => {
  assert.equal(DigestOutputZ.safeParse({ specRef: null, workspaceCommit: null, entries: [], extra: true }).success, false);
  assert.equal(DigestOutputZ.safeParse({ specRef: null, workspaceCommit: null, entries: [{ text: 'x', sourceId: 'S', quote: 'x', extra: true }] }).success, false);
  assert.equal(QgroupOutputZ.safeParse({ snapshotRef: 'v1-x', groups: [], extra: true }).success, false);
  assert.equal(QgroupOutputZ.safeParse({ snapshotRef: 'v1-x', groups: [{ label: 'a', questionIds: [], extra: true }] }).success, false);
});

test('qgroup 恢复同一快照下每个原问题编号且恰好一次', () => {
  const context = { snapshotRef: 'v2-hash', questionIds: ['Q1', 'Q2', 'Q3'] };
  const valid = checkQgroup({ snapshotRef: 'v2-hash', groups: [{ label: '部署', questionIds: ['Q2'] }, { label: '功能', questionIds: ['Q1', 'Q3'] }] }, context);
  assert.deepEqual(valid, { ok: true, errors: [], validation: 'question_ids_exact' });
  assert.match(checkQgroup({ snapshotRef: 'old', groups: [{ label: 'a', questionIds: ['Q1', 'Q2', 'Q3'] }] }, context).errors.join('\n'), /snapshotRef/);
  assert.match(checkQgroup({ snapshotRef: 'v2-hash', groups: [{ label: 'a', questionIds: ['Q1', 'Q2'] }] }, context).errors.join('\n'), /遗漏问题：Q3/);
  assert.match(checkQgroup({ snapshotRef: 'v2-hash', groups: [{ label: 'a', questionIds: ['Q1', 'Q2', 'Q3', 'Q4'] }] }, context).errors.join('\n'), /未知问题：Q4/);
  assert.match(checkQgroup({ snapshotRef: 'v2-hash', groups: [{ label: 'a', questionIds: ['Q1', 'Q2'] }, { label: 'b', questionIds: ['Q1', 'Q3'] }] }, context).errors.join('\n'), /重复分组：Q1/);
});

const limits = { maxRounds: 3, maxWriterSessions: 3, maxModelCalls: 5, maxActiveMinutes: 30 };
function light(overrides: Partial<LightReworkInput> = {}): LightReworkInput {
  return {
    enabled: true,
    capabilities: { verifiedAt: '2026-10-23T00:00:00.000Z', cliVersion: 'cursor-agent 2026.10.0', model: 'grok-4.7-high-fast', commandExitEventsVerified: false, toolPolicy: 'workspace_edits_only', terminationVerified: true, fileChangesVerified: true, workspaceWriteVerified: true, isolatedWorkspaceVerified: true },
    expectedCliVersion: 'cursor-agent 2026.10.0', expectedModel: 'grok-4.7-high-fast',
    specRef: 'spec-1', workspaceCommit: 'abc123', round: 1,
    defects: [{ id: 'D1', severity: 'minor', location: 'src/a.ts:12', fix: '修复边界条件', failureClass: 'implementation_defect', specRef: 'spec-1', workspaceCommit: 'abc123', round: 1 }],
    verifiedDefectIds: ['D1'], used: 0, lastWriter: 'sol', budget: createJobBudget(limits),
    now: '2026-10-23T00:00:00.000Z', reserveFinalReview: false,
    frozenCapabilityRef: 'capability-a', currentCapabilityRef: 'capability-a',
    ...overrides,
  };
}

test('light rework 只在所有写入能力与独立范围经 H7 验证后开放', () => {
  assert.equal(canRouteLightRework(light()).allowed, true);
  assert.match(canRouteLightRework(light({ enabled: false })).reason, /未显式启用/);
  assert.match(canRouteLightRework(light({ capabilities: null })).reason, /缺少/);
  assert.match(canRouteLightRework(light({ frozenCapabilityRef: null })).reason, /能力引用/);
  assert.match(canRouteLightRework(light({ currentCapabilityRef: null })).reason, /能力引用/);
  assert.match(canRouteLightRework(light({ currentCapabilityRef: 'capability-b' })).reason, /能力引用/);
  for (const [key, expected] of [
    ['terminationVerified', /完整终止/], ['fileChangesVerified', /文件变更/],
    ['workspaceWriteVerified', /写权限/], ['isolatedWorkspaceVerified', /独立安全/],
  ] as const) {
    const caps = { ...light().capabilities!, [key]: false };
    assert.match(canRouteLightRework(light({ capabilities: caps })).reason, expected);
  }
  assert.match(canRouteLightRework(light({ capabilities: { ...light().capabilities!, toolPolicy: null } })).reason, /workspace_edits_only/);
  assert.equal(canRouteLightRework(light({ capabilities: { ...light().capabilities!, commandExitEventsVerified: false } })).allowed, true);
  assert.match(canRouteLightRework(light({ capabilities: { ...light().capabilities!, cliVersion: 'changed' } })).reason, /版本不一致/);
  assert.match(canRouteLightRework(light({ capabilities: { ...light().capabilities!, model: 'other' } })).reason, /型号不一致/);
  assert.match(canRouteLightRework(light({ capabilities: { ...light().capabilities!, verifiedAt: null } })).reason, /verifiedAt/);
});

test('light rework 只接受精确匹配的 minor 缺陷、安全位置和非空修复', () => {
  assert.match(canRouteLightRework(light({ defects: [] })).reason, /没有/);
  const defect = light().defects[0]!;
  assert.match(canRouteLightRework(light({ defects: [{ ...defect, severity: 'major' }] })).reason, /minor/);
  for (const location of ['../outside.ts', 'C:outside.ts', 'src/a.ts:secret']) {
    assert.match(canRouteLightRework(light({ defects: [{ ...defect, location }] })).reason, /安全/, location);
  }
  assert.match(canRouteLightRework(light({ defects: [{ ...defect, fix: ' ' }] })).reason, /非空/);
  assert.match(canRouteLightRework(light({ defects: [{ ...defect, failureClass: 'environment_issue' }] })).reason, /implementation_defect/);
  assert.match(canRouteLightRework(light({ defects: [{ ...defect, workspaceCommit: 'old' }] })).reason, /当前规格、代码提交与轮次/);
  assert.match(canRouteLightRework(light({ verifiedDefectIds: ['D2'] })).reason, /精确一致/);
  assert.match(canRouteLightRework(light({ verifiedDefectIds: ['D1', 'D1'] })).reason, /精确一致/);
  const six = Array.from({ length: 6 }, (_, index) => ({ ...defect, id: `D${index}`, location: `src/${index}.ts` }));
  assert.match(canRouteLightRework(light({ defects: six, verifiedDefectIds: six.map((item) => item.id) })).reason, /5 个/);
  assert.equal(safeLightReworkDefectPath('Src/Feature.ts:12:3'), 'Src/Feature.ts');
  assert.equal(safeLightReworkDefectPath('../Src/Feature.ts'), null);
  const caseDuplicates = Array.from({ length: 6 }, (_, index) => ({ ...defect, id: `C${index}`, location: index % 2 ? 'SRC/A.ts' : 'src/a.ts' }));
  assert.equal(canRouteLightRework(light({ defects: caseDuplicates, verifiedDefectIds: caseDuplicates.map((item) => item.id) })).allowed, true);
});

test('light rework 最多一次、不连续由 Grok 写，且不绕过共享调用/轮次预算', () => {
  assert.match(canRouteLightRework(light({ used: 1 })).reason, /最多一次/);
  assert.match(canRouteLightRework(light({ lastWriter: 'grok' })).reason, /不能连续/);
  const callsSpent = createJobBudget({ ...limits, maxModelCalls: 1 });
  callsSpent.usage.modelCalls = 1;
  assert.match(canRouteLightRework(light({ budget: callsSpent })).reason, /调用预算/);
  const roundsSpent = createJobBudget({ ...limits, maxRounds: 1 });
  roundsSpent.usage.buildRounds = 1;
  assert.match(canRouteLightRework(light({ budget: roundsSpent })).reason, /轮次预算/);
  assert.match(canRouteLightRework(light({ now: 'invalid' })).reason, /预算记录无效/);
  const before = JSON.stringify(light().budget);
  const input = light();
  const snapshot = JSON.stringify(input.budget);
  assert.equal(canRouteLightRework(input).allowed, true);
  assert.equal(JSON.stringify(input.budget), snapshot, '纯守卫不得增加或预留预算');
  assert.ok(before.length > 0);
});
