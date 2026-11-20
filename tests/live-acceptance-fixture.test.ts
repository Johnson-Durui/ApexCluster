import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { CHECKS, CHECKS_HASH, FIXTURE, experimentConfig, experimentInput, fixtureEvidence, fixtureFilesIntact, prepareIndependentAudit } from '../docs/verification/v05-live-acceptance.js';

test('H5/H6 三组冻结配置仅改变评审开关，设计任务获得完整规格时间预算', () => {
  const comparable = (config: ReturnType<typeof experimentConfig>) => ({
    ...config,
    evaluator: { ...config.evaluator, enabled: false },
    finalReview: { ...config.finalReview, enabled: false },
  });
  const baseline = comparable(experimentConfig('off'));
  for (const arm of ['off', 'evaluate', 'both'] as const) {
    const config = experimentConfig(arm);
    assert.deepEqual(comparable(config), baseline);
    assert.equal(config.timeoutsMinutes.propose, FIXTURE.timeboxMinutes);
    assert.equal(config.timeoutsMinutes.review, FIXTURE.timeboxMinutes);
  }
});

test('H5/H6 使用相同需求，只改变两个被测开关，且不自动开启文档与整理', () => {
  const values = ['off', 'evaluate', 'both'].map(arm => experimentInput(arm as 'off' | 'evaluate' | 'both'));
  for (const value of values) {
    assert.equal(value.mode, 'real');
    assert.equal(value.clarifyWith, 'skip');
    assert.equal(value.writeDocs, false);
    assert.equal(value.writePrd, false);
    const { evaluator, finalReview, ...rest } = value;
    const { evaluator: _e, finalReview: _f, ...baseline } = values[0]!;
    assert.deepEqual(rest, baseline);
  }
});

test('独立审计从程序常量复制 checks，不复用写者改弱的检查且不自动标通过', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'h5-audit-'));
  const workspace = path.join(root, 'writer');
  mkdirSync(workspace);
  try {
    writeFileSync(path.join(workspace, 'sum.mjs'), 'export const sumIntegers=(a,b)=>a+b;');
    writeFileSync(path.join(workspace, 'check-invalid.mjs'), "console.log('INVALID_OK');");
    assert.throws(() => prepareIndependentAudit(workspace, 'r-test', path.join(workspace, 'audit')), /之外/);
    const audit = prepareIndependentAudit(workspace, 'r-test', path.join(root, 'audit'));
    assert.equal(audit.independentVerification, null);
    assert.equal(audit.checksHash, CHECKS_HASH);
    assert.equal(readFileSync(path.join(audit.auditDir, 'check-invalid.mjs'), 'utf8'), CHECKS['check-invalid.mjs']);
    assert.notEqual(spawnSync(process.execPath, ['check-invalid.mjs'], { cwd: audit.auditDir }).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('固定验收能发现溢出与非法输入错误，并检测被改动的检查文件', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'h5-fixture-'));
  try {
    for (const [file, source] of Object.entries(CHECKS)) writeFileSync(path.join(root, file), source);
    writeFileSync(path.join(root, 'sum.mjs'), 'export const sumIntegers = (a,b) => a+b;');
    assert.equal(fixtureFilesIntact(root), true);
    assert.equal(fixtureEvidence(root, 'r-test').observedChecksHash, CHECKS_HASH);
    assert.equal(spawnSync(process.execPath, ['check-normal.mjs'], { cwd: root }).status, 0);
    assert.notEqual(spawnSync(process.execPath, ['check-invalid.mjs'], { cwd: root }).status, 0);
    writeFileSync(path.join(root, 'sum.mjs'), 'export function sumIntegers(a,b) { if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||!Number.isSafeInteger(a+b)) throw new RangeError(); return a+b; }');
    for (const file of Object.keys(CHECKS)) assert.equal(spawnSync(process.execPath, [file], { cwd: root }).status, 0);
    writeFileSync(path.join(root, 'check-invalid.mjs'), "console.log('INVALID_OK');");
    assert.equal(fixtureFilesIntact(root), false);
    assert.notEqual(fixtureEvidence(root, 'r-test').observedChecksHash, CHECKS_HASH);
    writeFileSync(path.join(root, 'server.mjs'), '');
    assert.deepEqual(fixtureEvidence(root, 'r-test').unexpectedEntries, ['server.mjs']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
