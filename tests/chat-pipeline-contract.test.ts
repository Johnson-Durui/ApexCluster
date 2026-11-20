import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  canonicalContractJson,
  extractPrdContractIds,
  validateContractSubmission,
  type ContractValidationInput,
} from '../src/pipeline/contract.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const prd = `# Todo CLI

## 需求
- **R-001**：可以新增待办。
- **R-002**：可以列出待办。

## 验收
- **AC-001**：运行新增命令，覆盖 R-001。
- **AC-002**：运行列表命令，覆盖 R-002。
`;

function fixture(): ContractValidationInput {
  return {
    prdMarkdown: prd,
    sources: [
      { id: 'message:user:1', sha256: hash('用户要求做 todo cli') },
      { id: 'clarification:user:2', sha256: hash('列表按创建顺序') },
    ],
    artifacts: [
      { name: 'PRD.md', ref: 'agent-outputs/PRD.md', sha256: hash(prd) },
      { name: 'ARCHITECTURE.md', ref: 'agent-outputs/ARCHITECTURE.md', sha256: hash('architecture') },
    ],
    submission: {
      requirements: [
        { id: 'R-001', text: '可以新增待办', sourceIds: ['message:user:1'] },
        { id: 'R-002', text: '可以列出待办', assumptionIds: ['AS-001'] },
      ],
      acceptance: [
        { id: 'AC-001', requirementIds: ['R-001'], kind: 'command', description: '新增成功', command: 'node cli.mjs add test' },
        { id: 'AC-002', requirementIds: ['R-002'], kind: 'manual', description: '列表顺序清楚' },
      ],
      assumptions: [{ id: 'AS-001', text: '列表按创建顺序' }],
    },
  };
}

test('extracts only PRD entry definitions and reports duplicate definitions', () => {
  assert.deepEqual(extractPrdContractIds(`${prd}\n- AC-002：重复定义，仍引用 R-001。`), {
    requirements: ['R-001', 'R-002'],
    acceptance: ['AC-001', 'AC-002'],
    duplicateRequirements: [],
    duplicateAcceptance: ['AC-002'],
  });
});

test('validates, canonicalizes and deeply freezes exact sources and artifact pins', () => {
  const input = fixture();
  const result = validateContractSubmission(input);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.contract.sources, [{ id: 'message:user:1', sha256: hash('用户要求做 todo cli') }]);
  assert.deepEqual(result.contract.artifacts.map(item => item.name), ['ARCHITECTURE.md', 'PRD.md']);
  assert.equal(result.contract.sha256, hash(canonicalContractJson(result.contract)));
  assert.equal(Object.isFrozen(result.contract), true);
  assert.equal(Object.isFrozen(result.contract.requirements), true);
  assert.equal(Object.isFrozen(result.contract.requirements[0]), true);
  assert.throws(() => { (result.contract.requirements as unknown as { id: string }[])[0]!.id = 'R-999'; }, TypeError);

  const reordered = fixture();
  reordered.sources = [...reordered.sources].reverse();
  reordered.artifacts = [...reordered.artifacts].reverse();
  const submission = reordered.submission as { requirements: unknown[]; acceptance: unknown[]; assumptions: unknown[] };
  submission.requirements.reverse();
  submission.acceptance.reverse();
  const second = validateContractSubmission(reordered);
  assert.equal(second.ok, true);
  if (second.ok) assert.equal(second.contract.sha256, result.contract.sha256);
});

test('rejects omitted PRD AC and gives a repairable missing-ID message', () => {
  const input = fixture();
  (input.submission as { acceptance: unknown[] }).acceptance.pop();
  const result = validateContractSubmission(input);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.some(issue => issue.code === 'MISSING_PRD_ACCEPTANCE' && issue.message.includes('AC-002')));
  assert.ok(result.issues.some(issue => issue.code === 'UNMAPPED_REQUIREMENT' && issue.message.includes('R-002')));
});

test('rejects duplicate IDs, invalid relations, unknown provenance and uncovered requirements together', () => {
  const input = fixture();
  input.submission = {
    requirements: [
      { id: 'R-001', text: 'first', sourceIds: ['missing-source'] },
      { id: 'R-001', text: 'duplicate', sourceIds: ['message:user:1'] },
      { id: 'R-002', text: 'second', assumptionIds: ['AS-999'] },
    ],
    acceptance: [
      { id: 'AC-001', requirementIds: ['R-999'], kind: 'manual', description: 'bad relation' },
      { id: 'AC-001', requirementIds: ['R-001'], kind: 'manual', description: 'duplicate' },
      { id: 'AC-002', requirementIds: ['R-001'], kind: 'manual', description: 'does not cover R-002' },
    ],
    assumptions: [{ id: 'AS-001', text: 'known' }],
  };
  const result = validateContractSubmission(input);
  assert.equal(result.ok, false);
  if (result.ok) return;
  const codes = new Set(result.issues.map(issue => issue.code));
  for (const code of ['DUPLICATE_REQUIREMENT', 'DUPLICATE_ACCEPTANCE', 'UNKNOWN_SOURCE', 'UNKNOWN_ASSUMPTION', 'UNKNOWN_REQUIREMENT_RELATION', 'UNMAPPED_REQUIREMENT']) {
    assert.ok(codes.has(code), `missing ${code}: ${JSON.stringify(result.issues)}`);
  }
});

test('rejects strict shape errors, invalid hashes and incomplete artifact pins', () => {
  const invalidShape = fixture();
  invalidShape.submission = {
    ...(invalidShape.submission as object),
    extra: true,
  };
  let result = validateContractSubmission(invalidShape);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.issues.some(issue => issue.code === 'INVALID_SHAPE' && issue.path.startsWith('submission')));

  const invalidPin = fixture();
  invalidPin.sources = [{ id: 'message:user:1', sha256: 'ABC' }];
  invalidPin.artifacts = [invalidPin.artifacts[0]!];
  result = validateContractSubmission(invalidPin);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.issues.some(issue => issue.code === 'INVALID_SHAPE' && issue.path.includes('sources.0.sha256')));

  const missingPin = fixture();
  missingPin.artifacts = [missingPin.artifacts[0]!];
  result = validateContractSubmission(missingPin);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.issues.some(issue => issue.code === 'MISSING_ARTIFACT' && issue.message.includes('ARCHITECTURE.md')));
});

test('requires command only for command acceptance and provenance for every requirement', () => {
  const input = fixture();
  input.submission = {
    requirements: [{ id: 'R-001', text: 'missing provenance' }, { id: 'R-002', text: 'ok', sourceIds: ['message:user:1'] }],
    acceptance: [
      { id: 'AC-001', requirementIds: ['R-001'], kind: 'command', description: 'missing command' },
      { id: 'AC-002', requirementIds: ['R-002'], kind: 'ui', description: 'unexpected command', command: 'npm test' },
    ],
  };
  const result = validateContractSubmission(input);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some(issue => issue.message.includes('用户原文来源或已记录假设')));
    assert.ok(result.issues.some(issue => issue.message.includes('命令类验收必须提供')));
    assert.ok(result.issues.some(issue => issue.message.includes('只有命令类验收')));
  }
});
