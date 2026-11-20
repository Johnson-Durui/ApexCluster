import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conservativeH8Conclusion, parseFeatureEvidence } from '../docs/verification/v05-h8-static-capabilities.js';

test('H8 特性证据保留 true/false、成熟度、行号和精确行', () => {
  const evidence = parseFeatureEvidence([
    'other stable true',
    'async_compaction under development false',
    'context_management experimental true',
  ].join('\n'));
  assert.deepEqual(evidence, [
    { name: 'async_compaction', found: true, maturity: 'under development', enabled: false, lineNumber: 2,
      evidenceLine: 'async_compaction under development false' },
    { name: 'context_management', found: true, maturity: 'experimental', enabled: true, lineNumber: 3,
      evidenceLine: 'context_management experimental true' },
  ]);
});

test('H8 特性证据对 malformed 和 missing 保持 null，不推测状态', () => {
  const evidence = parseFeatureEvidence('async_compaction under development maybe\nother stable false');
  assert.deepEqual(evidence, [
    { name: 'async_compaction', found: true, maturity: null, enabled: null, lineNumber: 1,
      evidenceLine: 'async_compaction under development maybe' },
    { name: 'context_management', found: false, maturity: null, enabled: null, lineNumber: null, evidenceLine: null },
  ]);
});

test('H8 目录窗口即使一致也不提升为运行时窗口或开放续接', () => {
  const conclusion = conservativeH8Conclusion({
    claudeHelp: '--autocompact <auto|tokens> Auto-compact window size (auto, or 100k–1M tokens)',
    codexFeatures: parseFeatureEvidence('async_compaction under development false\ncontext_management under development false'),
    bundledCatalog: [
      { slug: 'gpt-6-astra', displayName: null, contextWindow: 272_000, autoCompactTokenLimit: null, defaultReasoningLevel: 'low', supportedReasoningLevels: ['max'] },
      { slug: 'gpt-6.1-sol', displayName: null, contextWindow: 500_000, autoCompactTokenLimit: null, defaultReasoningLevel: 'low', supportedReasoningLevels: ['max'] },
    ],
    refreshedCatalog: [
      { slug: 'gpt-6-astra', displayName: null, contextWindow: 272_000, autoCompactTokenLimit: null, defaultReasoningLevel: 'low', supportedReasoningLevels: ['max'] },
      { slug: 'gpt-6.1-sol', displayName: null, contextWindow: 500_000, autoCompactTokenLimit: null, defaultReasoningLevel: 'low', supportedReasoningLevels: ['max'] },
    ],
  });
  assert.equal(conclusion.catalogWindowsObserved.every(item => item.consistent), true);
  assert.equal(conclusion.runtimeContextWindow, null);
  assert.equal(conclusion.usageSemantics, 'unknown');
  assert.equal(conclusion.compactions, null);
  assert.equal(conclusion.canEnableResume, false);
});

test('H8 显式记录刷新目录与内置目录漂移，不能挑选较大数字冒充事实', () => {
  const conclusion = conservativeH8Conclusion({
    claudeHelp: '--autocompact <auto|tokens> Auto-compact window size (auto, or 100k–1M tokens)',
    codexFeatures: parseFeatureEvidence('async_compaction under development false'),
    bundledCatalog: [
      { slug: 'gpt-6-astra', displayName: null, contextWindow: 272_000, autoCompactTokenLimit: null, defaultReasoningLevel: 'low', supportedReasoningLevels: ['max'] },
      { slug: 'gpt-6.1-sol', displayName: null, contextWindow: 272_000, autoCompactTokenLimit: null, defaultReasoningLevel: 'low', supportedReasoningLevels: ['max'] },
    ],
    refreshedCatalog: [
      { slug: 'gpt-6-astra', displayName: null, contextWindow: 272_000, autoCompactTokenLimit: null, defaultReasoningLevel: 'low', supportedReasoningLevels: ['max'] },
      { slug: 'gpt-6.1-sol', displayName: null, contextWindow: 500_000, autoCompactTokenLimit: null, defaultReasoningLevel: 'low', supportedReasoningLevels: ['max'] },
    ],
  });
  assert.equal(conclusion.catalogWindowsObserved.find(item => item.slug === 'gpt-6-astra')?.consistent, true);
  assert.equal(conclusion.catalogWindowsObserved.find(item => item.slug === 'gpt-6.1-sol')?.consistent, false);
  assert.equal(conclusion.runtimeContextWindow, null);
  assert.equal(conclusion.canEnableResume, false);
});
