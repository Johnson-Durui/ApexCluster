import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { formatFinding, releaseByDefault, releaseExcluded, runPrepublishScan, scanPublishingTree } from '../scripts/prepublish-scan.js';
import { tempDir } from './helpers.js';

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Scanner Test', GIT_AUTHOR_EMAIL: 'scanner@local.invalid', GIT_COMMITTER_NAME: 'Scanner Test', GIT_COMMITTER_EMAIL: 'scanner@local.invalid' } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function repo(): string {
  const root = tempDir();
  git(root, 'init', '-q');
  mkdirSync(path.join(root, 'config'), { recursive: true });
  writeFileSync(path.join(root, 'config/prepublish-scan-whitelist.json'), '[]\n');
  writeFileSync(path.join(root, 'tracked.txt'), 'safe\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture');
  return root;
}

const secret = () => `sk-${'not-a-real-key'.repeat(3)}`;
const email = () => ['person', 'example.com'].join('@');

test('release scope is an explicit, shared path contract', () => {
  assert.equal(releaseExcluded('docs/TASKBOOK_V1_API_PIPELINE.md'), true);
  assert.equal(releaseExcluded('docs/history/old.md'), true);
  assert.equal(releaseExcluded('docs/plans/legacy.md'), true);
  assert.equal(releaseExcluded('docs/screenshots/evidence.png'), true);
  assert.equal(releaseExcluded('docs/verification/course-final-evidence.json'), true);
  assert.equal(releaseExcluded('docs/verification/v05-h6-report.ts'), false);
  assert.equal(releaseExcluded('src/config.ts'), false);
  assert.equal(releaseByDefault('main'), true);
  assert.equal(releaseByDefault('v1'), false);
});

test('staged content is scanned even when the worktree was overwritten afterward', () => {
  const root = repo();
  writeFileSync(path.join(root, 'tracked.txt'), `${secret()}\n`);
  git(root, 'add', 'tracked.txt');
  writeFileSync(path.join(root, 'tracked.txt'), 'safe again\n');
  const result = scanPublishingTree({ root });
  assert.deepEqual(result.findings, [{ rule: 'secret.api-key', path: 'tracked.txt', line: 1 }]);
  assert.equal(formatFinding(result.findings[0]!), 'secret.api-key\ttracked.txt:1');
  assert.equal(formatFinding(result.findings[0]!).includes(secret()), false);
});

test('CLI failure output identifies location without echoing the matched value', () => {
  const root = repo();
  const value = secret();
  writeFileSync(path.join(root, 'tracked.txt'), `${value}\n`);
  let stdout = '';
  let stderr = '';
  const status = runPrepublishScan([], { root, stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
  assert.equal(status, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /^secret\.api-key\ttracked\.txt:1\n/m);
  assert.equal(stderr.includes(value), false);
});

test('escaped source paths and binary metadata cannot bypass local-path rules', () => {
  const root = repo();
  const doubled = ['C:', '\\\\', 'Users', '\\\\', 'local-profile', '\\\\', 'file.txt'].join('');
  writeFileSync(path.join(root, 'tracked.txt'), `const local = '${doubled}';\n`);
  const embedded = ['E:', '\\', 'Codex', '\\', 'private', '\\', 'artifact'].join('');
  const metadata = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(embedded, 'latin1'), Buffer.from([0, 3])]);
  writeFileSync(path.join(root, 'asset.bin'), metadata);
  git(root, 'add', '.');
  assert.deepEqual(scanPublishingTree({ root }).findings, [
    { rule: 'local.codex-work-path', path: 'asset.bin', line: 1 },
    { rule: 'local.windows-user-path', path: 'tracked.txt', line: 1 },
  ].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.rule.localeCompare(b.rule)));
});

test('--tree reads immutable Git content and its committed allowlist', () => {
  const root = repo();
  writeFileSync(path.join(root, 'tracked.txt'), `${email()}\n`);
  git(root, 'add', 'tracked.txt');
  git(root, 'commit', '-qm', 'tree fixture');
  const tree = git(root, 'rev-parse', 'HEAD');
  writeFileSync(path.join(root, 'tracked.txt'), 'safe worktree\n');
  assert.deepEqual(scanPublishingTree({ root, tree }).findings, [{ rule: 'personal.email', path: 'tracked.txt', line: 1 }]);
});

test('allowlist is exact to path, rule, line hash, and requires a reason', () => {
  const root = repo();
  const line = email();
  writeFileSync(path.join(root, 'tracked.txt'), `${line}\n`);
  const lineSha256 = createHash('sha256').update(line).digest('hex');
  writeFileSync(path.join(root, 'config/prepublish-scan-whitelist.json'), `${JSON.stringify([
    { path: 'tracked.txt', rule: 'personal.email', lineSha256, reason: 'Reserved test-domain fixture.' },
  ], null, 2)}\n`);
  assert.deepEqual(scanPublishingTree({ root }).findings, []);
  writeFileSync(path.join(root, 'tracked.txt'), `prefix ${line}\n`);
  assert.deepEqual(scanPublishingTree({ root }).findings, [{ rule: 'personal.email', path: 'tracked.txt', line: 1 }]);
  const whitelist = readFileSync(path.join(root, 'config/prepublish-scan-whitelist.json'), 'utf8').replace('Reserved test-domain fixture.', 'short');
  writeFileSync(path.join(root, 'config/prepublish-scan-whitelist.json'), whitelist);
  assert.throws(() => scanPublishingTree({ root }), /exact, justified allowlist/);
});

test('release scan skips archived evidence but scans product files', () => {
  const root = repo();
  mkdirSync(path.join(root, 'docs/history'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'docs/history/old.txt'), `${secret()}\n`);
  writeFileSync(path.join(root, 'src/product.txt'), `${secret()}\n`);
  git(root, 'add', '.');
  const result = scanPublishingTree({ root, release: true });
  assert.deepEqual(result.findings, [{ rule: 'secret.api-key', path: 'src/product.txt', line: 1 }]);
});
