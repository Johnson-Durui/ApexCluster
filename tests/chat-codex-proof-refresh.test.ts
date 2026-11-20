import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildCodexRefreshCandidate, validateBaseProofEvidence, validateCodexRefreshEvidence, validateFreshOutputDirectory, type BindingExpectations } from '../scripts/chat-refresh-codex-proofs.js';

const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const qualificationId = '10000000-0000-4000-8000-000000000001';
const now = Date.parse('2026-10-28T10:30:00.000Z');
const files = ['src/config.js', 'src/chat/drivers.js', 'src/chat/codex-policy.js', 'src/chat/types.js', 'src/chat/windows-job-process.js', 'src/chat/windows-job-app-server.js', 'src/adapters/process.js'];
type Fixture = ReturnType<typeof fixture>;

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-refresh-validator-')); const appRoot = path.join(root, 'app'); mkdirSync(appRoot);
  const compiledFiles: Record<string, string> = {};
  for (const [index, relative] of files.entries()) { const target = path.join(appRoot, relative); mkdirSync(path.dirname(target), { recursive: true }); const bytes = `compiled-${index}`; writeFileSync(target, bytes); compiledFiles[relative] = digest(bytes); }
  const commandFile = path.join(root, 'codex.exe'); writeFileSync(commandFile, 'fixed-codex');
  const supervisor = { binaryPath: path.join(appRoot, 'src/chat/windows-job-supervisor.exe'), binarySha256: 'c'.repeat(64), protocol: 1 };
  const noModelFile = path.join(root, 'no-model.json'); const noModel = { schema: 'dual-model-workbench/windows-job-probe/v1', passed: true, realModelCalls: 0, appRoot, supervisor }; writeFileSync(noModelFile, JSON.stringify(noModel));
  const fingerprints = { astra: 'd'.repeat(64), sol: 'e'.repeat(64) };
  const expected: BindingExpectations = { appRoot, version: 'codex-cli 0.165.0-alpha.1.2', command: { file: commandFile, prefixArgs: [] }, cliSha256: digest(readFileSync(commandFile)), supervisor, fingerprints, compiledFiles };
  const ids = ['20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000004'];
  const tasks = ['30000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000004'];
  const job = (role: 'astra' | 'sol', phase: string, cancel = false, pid = 100) => ({ role, phase, confirmed: true, rootExited: true, activeProcesses: 0, targetPid: pid, ...(cancel ? { cancelReceived: true, activeBeforeStop: 2 } : {}) });
  const side = (role: 'astra' | 'sol', name: 'normal' | 'cancellation', index: number) => name === 'normal' ? {
    invocationId: ids[index], taskId: tasks[index], startedAt: `2026-10-28T10:0${index}:00.000Z`, endedAt: `2026-10-28T10:0${index}:30.000Z`, passed: true, transportVerified: true,
    result: { exitConfirmed: true, finishReason: 'completed', text: 'CODEX_JOB_PUBLIC_READ_OK' }, hostCalls: [{ name: 'probe_read', args: { path: 'public.txt' }, responseSha256: digest('CODEX_JOB_PUBLIC_READ_OK'), responseBytes: 24 }],
    dynamicToolCompletions: [{ method: 'item/completed', tool: 'probe_read', callIdSha256: index === 0 ? 'a'.repeat(64) : 'b'.repeat(64), statusIsCompleted: true, success: true, contentItemCount: 1, inputTextCount: 1, schemaValid: true, responseTextSha256: digest('CODEX_JOB_PUBLIC_READ_OK'), responseBytes: 24, equalsExpectedPublicText: true }],
    jobs: [job(role, 'version', false, 101 + index), job(role, 'discovery', false, 201 + index), job(role, 'isolated', false, 301 + index)],
  } : {
    invocationId: ids[index], taskId: tasks[index], startedAt: `2026-10-28T10:0${index}:00.000Z`, endedAt: `2026-10-28T10:0${index}:30.000Z`, passed: true, transportVerified: true,
    result: { exitConfirmed: true, finishReason: 'cancelled', text: '' }, hostCalls: [{ name: 'probe_wait', args: {} }], dynamicToolCompletions: [],
    jobs: [job(role, 'version', false, 101 + index), job(role, 'discovery', false, 201 + index), job(role, 'isolated', true, 301 + index)],
  };
  const proof = { schema: 'dual-model-workbench/codex-job-live/v1', probeRevision: 3, qualificationId, startedAt: '2026-10-28T10:00:00.000Z', completedAt: '2026-10-28T10:10:00.000Z', passed: true, executeLive: true, maxInferenceSegments: 4, paidSegmentsAttempted: 4,
    finalResponseContract: 'copy actual host result; expected marker absent from prompt', observer: { installed: true, contract: 'post-consume pass-through; bounded item/completed dynamicToolCall summary only', claimBoundary: 'proves CLI item completion and returned content only; does not prove model context, understanding or compliance', errors: [], restored: true },
    appRoot, version: expected.version, effort: 'max', models: { astra: 'gpt-6.2-astra', sol: 'gpt-6.2-sol' }, preflight: { passed: true, command: expected.command, cliSha256: expected.cliSha256, supervisor, fingerprints, compiledFiles, noModelProbe: { path: noModelFile, sha256: digest(readFileSync(noModelFile)) } },
    roles: { astra: { normal: side('astra', 'normal', 0), cancellation: side('astra', 'cancellation', 1) }, sol: { normal: side('sol', 'normal', 2), cancellation: side('sol', 'cancellation', 3) } } };
  const evidenceFile = path.join(root, 'evidence.json'); const evidenceBytes = () => Buffer.from(JSON.stringify(proof));
  const cited = path.join(root, 'historical.json'); writeFileSync(cited, 'historical');
  const base = { schema: 'dual-model-workbench/scoped-model-proofs/v1', scope: { appRoot, node: process.execPath, globalCapabilitiesModified: false }, roles: { claude: { marker: 'preserve-claude' }, grok: { marker: 'preserve-grok' }, astra: { version: 'old', fingerprint: 'old-a' }, sol: { version: 'old', fingerprint: 'old-s' } }, evidence: { historical: { path: cited, sha256: digest(readFileSync(cited)) } } };
  return { root, appRoot, expected, proof, evidenceFile, evidenceBytes, base };
}
const dispose = (f: Fixture) => rmSync(f.root, { recursive: true, force: true });

test('complete validators gate candidate creation and preserve Claude/Grok', () => {
  const f = fixture(); try {
    const evidenceBytes = f.evidenceBytes(); writeFileSync(f.evidenceFile, evidenceBytes); const proof = validateCodexRefreshEvidence(evidenceBytes, f.expected, qualificationId, now); const baseBytes = Buffer.from(JSON.stringify(f.base)); const base = validateBaseProofEvidence(baseBytes, baseBytes, f.appRoot, process.execPath);
    const candidate = buildCodexRefreshCandidate(base, proof, f.evidenceFile);
    assert.deepEqual(candidate.roles.claude, f.base.roles.claude); assert.deepEqual(candidate.roles.grok, f.base.roles.grok); assert.equal(candidate.roles.astra.version, f.expected.version); assert.equal(Object.keys(candidate.roles.astra.tests).length, 9); assert.deepEqual(candidate.evidence.codexJobRefresh, { path: f.evidenceFile.replaceAll('\\', '/'), sha256: digest(evidenceBytes) });
  } finally { dispose(f); }
});

test('post-validation mutations cannot alter the private base or binding snapshot and a wrong evidence path is rejected', () => {
  const f = fixture(); try {
    const evidenceBytes = f.evidenceBytes(); writeFileSync(f.evidenceFile, evidenceBytes); const proof = validateCodexRefreshEvidence(evidenceBytes, f.expected, qualificationId, now); const baseBytes = Buffer.from(JSON.stringify(f.base)); const base = validateBaseProofEvidence(baseBytes, baseBytes, f.appRoot, process.execPath);
    base.scope.appRoot = 'C:\\mutated'; base.evidence.historical.sha256 = '0'.repeat(64); f.expected.version = 'mutated-version'; f.expected.fingerprints.astra = '0'.repeat(64);
    const candidate = buildCodexRefreshCandidate(base, proof, f.evidenceFile); assert.equal(candidate.scope.appRoot, f.appRoot); assert.notEqual(candidate.evidence.historical.sha256, '0'.repeat(64)); assert.equal(candidate.roles.astra.version, 'codex-cli 0.165.0-alpha.1.2'); assert.equal(candidate.roles.astra.fingerprint, 'd'.repeat(64));
    const wrong = path.join(f.root, 'wrong-evidence.json'); writeFileSync(wrong, 'different bytes'); assert.throws(() => buildCodexRefreshCandidate(base, proof, wrong), /validated snapshot/);
  } finally { dispose(f); }
});

test('complete live validator rejects observer, no-model, duplicate segment, nonce, age, tool, exit, CLI and module failures', () => {
  const cases: Array<[string, (f: Fixture) => void, string?]> = [
    ['observer', f => { delete (f.proof as any).observer; }],
    ['no-model', f => { f.proof.preflight.noModelProbe.path = path.join(f.root, 'missing.json'); }],
    ['version', f => { f.proof.version = 'codex-cli tampered'; }],
    ['legacy model IDs', f => { f.proof.models = { astra: 'gpt-6-astra', sol: 'gpt-6.1-sol' }; }],
    ['missing normal', f => { delete (f.proof.roles.astra as any).normal; }],
    ['missing cancellation', f => { delete (f.proof.roles.sol as any).cancellation; }],
    ['duplicate segment', f => { f.proof.roles.sol.normal.invocationId = f.proof.roles.astra.normal.invocationId; }],
    ['nonce', f => { f.proof.qualificationId = '10000000-0000-4000-8000-000000000099'; }],
    ['expired', f => { f.proof.completedAt = '2026-10-26T10:00:00.000Z'; f.proof.startedAt = '2026-10-26T09:00:00.000Z'; }],
    ['tool', f => { (f.proof.roles.astra.normal.hostCalls[0]! as { responseSha256: string }).responseSha256 = '9'.repeat(64); }],
    ['unknown exit', f => { f.proof.roles.sol.normal.result.exitConfirmed = false; }],
    ['CLI hash', f => { f.proof.preflight.cliSha256 = '0'.repeat(64); }],
    ['module drift', f => { f.proof.preflight.compiledFiles['src/chat/drivers.js'] = '8'.repeat(64); }],
  ];
  for (const [name, mutate] of cases) { const f = fixture(); try { mutate(f); assert.throws(() => validateCodexRefreshEvidence(f.evidenceBytes(), f.expected, qualificationId, now), name); assert.throws(() => buildCodexRefreshCandidate(f.base, f.proof, f.evidenceFile), `${name}: weak signing path`); } finally { dispose(f); } }
});

test('base validator rejects non-active bytes, wrong app scope and changed evidence', () => {
  for (const kind of ['active hash', 'scope', 'evidence hash'] as const) { const f = fixture(); try { const base = structuredClone(f.base); if (kind === 'scope') base.scope.appRoot = path.join(f.root, 'other'); if (kind === 'evidence hash') base.evidence.historical.sha256 = '0'.repeat(64); const bytes = Buffer.from(JSON.stringify(base)); const active = kind === 'active hash' ? Buffer.from(`${JSON.stringify(base)} `) : bytes; assert.throws(() => validateBaseProofEvidence(bytes, active, f.appRoot, process.execPath), kind); } finally { dispose(f); } }
});

test('fresh output directory requires an existing real parent below the work root', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-refresh-output-')); try { const parent = path.join(root, 'parent'); mkdirSync(parent); validateFreshOutputDirectory(path.join(parent, 'new-leaf'), root); mkdirSync(path.join(parent, 'existing')); assert.throws(() => validateFreshOutputDirectory(path.join(parent, 'existing'), root), /fresh/); assert.throws(() => validateFreshOutputDirectory(path.join(root, 'missing-parent', 'leaf'), root), /parent/); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
