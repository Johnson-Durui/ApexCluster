import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createGitCheckpoint } from '../src/pipeline/git-checkpoint.js';

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function temporary(t: test.TestContext): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dmw-git-checkpoint-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function manifest(root: string, files: string[]): Record<string, string> {
  return Object.fromEntries(files.map(file => [file, sha(readFileSync(path.join(root, ...file.split('/'))))]));
}

function objectFiles(root: string): string[] {
  const objects = path.join(root, '.git', 'objects');
  const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(absolute) : [path.relative(objects, absolute)];
  });
  return walk(objects).sort();
}

test('creates an exact-root managed repository and retries the same tree without another commit', t => {
  const root = temporary(t);
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', 'value.txt'), 'verified\n');
  writeFileSync(path.join(root, 'README.md'), 'product\n');
  const files = manifest(root, ['README.md', 'src/value.txt']);
  const first = createGitCheckpoint({ workspaceRoot: root, files, reviewedPaths: ['README.md', 'src'], message: 'M1 verified' });
  assert.equal(first.created, true);
  assert.equal(git(root, ['rev-parse', 'HEAD']), first.commit);
  assert.equal(git(root, ['show', `${first.commit}:src/value.txt`]), 'verified');
  const repeated = createGitCheckpoint({ workspaceRoot: root, files, reviewedPaths: ['README.md', 'src'], message: 'M1 verified' });
  assert.deepEqual(repeated, { ...first, created: false, parent: first.commit });
  const semantic = createGitCheckpoint({ workspaceRoot: root, files, reviewedPaths: ['README.md', 'src'], message: 'M1 verification passed' });
  assert.equal(semantic.created, true);
  assert.equal(semantic.parent, first.commit);
  assert.equal(semantic.tree, first.tree);
  assert.equal(createGitCheckpoint({ workspaceRoot: root, files, reviewedPaths: ['README.md', 'src'], message: 'M1 verification passed' }).commit, semantic.commit);
  assert.equal(git(root, ['rev-list', '--count', first.ref]), '2');
});

test('existing repository keeps HEAD and staged work while hostile hooks and filters never run', t => {
  const root = temporary(t);
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', 'value.txt'), 'base\n');
  writeFileSync(path.join(root, '.gitattributes'), '*.txt filter=hostile\n');
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.name', 'Fixture']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['add', '.']);
  git(root, ['commit', '--quiet', '-m', 'base']);
  const head = git(root, ['rev-parse', 'HEAD']);
  const seeded = createGitCheckpoint({
    workspaceRoot: root,
    files: manifest(root, ['.gitattributes', 'src/value.txt']),
    reviewedPaths: [],
    message: 'bind exact existing baseline',
  });
  assert.equal(seeded.created, true);
  assert.equal(seeded.parent, head);
  assert.notEqual(seeded.commit, head);
  const hook = path.join(root, '.git', 'hooks', 'reference-transaction');
  writeFileSync(hook, '#!/bin/sh\nexit 97\n');
  chmodSync(hook, 0o755);
  writeFileSync(path.join(root, 'src', 'value.txt'), 'reviewed change\n');
  git(root, ['add', 'src/value.txt']);
  git(root, ['config', 'filter.hostile.clean', 'hostile-filter-command-must-not-run']);
  const indexBefore = readFileSync(path.join(root, '.git', 'index'));
  const stagedBefore = git(root, ['diff', '--cached', '--binary']);
  const files = manifest(root, ['.gitattributes', 'src/value.txt']);
  const first = createGitCheckpoint({ workspaceRoot: root, files, reviewedPaths: ['src/value.txt'], message: 'M2 verified' });
  assert.equal(first.parent, seeded.commit);
  assert.equal(git(root, ['rev-parse', 'HEAD']), head, 'checkpoint must not move the user branch');
  assert.deepEqual(readFileSync(path.join(root, '.git', 'index')), indexBefore, 'checkpoint must not touch the user index');
  assert.equal(git(root, ['diff', '--cached', '--binary']), stagedBefore);
  assert.equal(git(root, ['show', `${first.commit}:src/value.txt`]), 'reviewed change');
  const repeated = createGitCheckpoint({ workspaceRoot: root, files, reviewedPaths: ['src/value.txt'], message: 'M2 verified' });
  assert.equal(repeated.created, false);
  assert.equal(repeated.commit, first.commit);
  assert.throws(() => createGitCheckpoint({
    workspaceRoot: root,
    files,
    reviewedPaths: ['src/value.txt'],
    message: 'escape ref',
    ref: 'refs/dmw/checkpoints/../../heads/main',
  }), /专用命名空间/);
  assert.equal(git(root, ['rev-parse', 'HEAD']), head);
  assert.deepEqual(readFileSync(path.join(root, '.git', 'index')), indexBefore);
});

test('unreviewed tree drift fails before writing Git objects or moving the checkpoint ref', t => {
  const root = temporary(t);
  mkdirSync(path.join(root, 'src'));
  mkdirSync(path.join(root, 'docs'));
  writeFileSync(path.join(root, 'src', 'value.txt'), 'one\n');
  writeFileSync(path.join(root, 'docs', 'guide.md'), 'base\n');
  const baseFiles = manifest(root, ['docs/guide.md', 'src/value.txt']);
  const base = createGitCheckpoint({ workspaceRoot: root, files: baseFiles, reviewedPaths: ['docs', 'src'], message: 'base' });
  writeFileSync(path.join(root, 'src', 'value.txt'), 'two\n');
  writeFileSync(path.join(root, 'docs', 'guide.md'), 'unreviewed\n');
  const objectsBefore = objectFiles(root);
  assert.throws(() => createGitCheckpoint({
    workspaceRoot: root,
    files: manifest(root, ['docs/guide.md', 'src/value.txt']),
    reviewedPaths: ['src/value.txt'],
    message: 'must fail',
  }), /未评审.*docs\/guide\.md/);
  assert.deepEqual(objectFiles(root), objectsBefore);
  assert.equal(git(root, ['show-ref', '--hash', base.ref]), base.commit);
});

test('nested workspace creates its own repository and refuses external .git pointers', t => {
  const parent = temporary(t);
  git(parent, ['init', '--quiet']);
  git(parent, ['config', 'user.name', 'Fixture']);
  git(parent, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(path.join(parent, 'parent.txt'), 'parent\n');
  git(parent, ['add', 'parent.txt']);
  git(parent, ['commit', '--quiet', '-m', 'parent']);
  const nested = path.join(parent, 'product');
  mkdirSync(nested);
  writeFileSync(path.join(nested, 'value.txt'), 'nested\n');
  const parentHeadBefore = git(parent, ['rev-parse', '--verify', 'HEAD']);
  const checkpoint = createGitCheckpoint({
    workspaceRoot: nested,
    files: manifest(nested, ['value.txt']),
    reviewedPaths: ['value.txt'],
    message: 'nested root',
  });
  assert.equal(git(nested, ['rev-parse', 'HEAD']), checkpoint.commit);
  assert.equal(git(parent, ['rev-parse', '--verify', 'HEAD']), parentHeadBefore);

  const linked = path.join(parent, 'linked');
  mkdirSync(linked);
  writeFileSync(path.join(linked, 'value.txt'), 'linked\n');
  writeFileSync(path.join(linked, '.git'), 'gitdir: ../.git\n');
  assert.throws(() => createGitCheckpoint({
    workspaceRoot: linked,
    files: manifest(linked, ['value.txt']),
    reviewedPaths: ['value.txt'],
    message: 'reject pointer',
  }), /普通 \.git 目录/);
});
