import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const script = 'scripts/chat-live-workflow-probe.ts';

test('workflow evidence binds the compiled native-tool exclusion module hash', () => {
  const source = readFileSync(script, 'utf8');
  const declaration = source.match(/const compiledFiles = \[([^\n]+)\] as const;/)?.[1] ?? '';
  assert.equal(declaration.split("'src/chat/cursor-native-tool-exclusion.js'").length - 1, 1);
  assert.match(source, /compiledAppHashes: Object\.fromEntries\(compiledFiles\.map/);
});

function run(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', script, ...args], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 15_000, windowsHide: true,
  });
}

test('workflow probe keeps 24 as the default Runtime invocation limit', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--max-runtime-invocations 1-48/);
  assert.match(help.stdout, /defaults to 24/);

  const child = run(['--proof-dir', 'E:\\missing-proof', '--app-root', 'E:\\missing-app']);
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /--app-root must be a real directory/);
  assert.doesNotMatch(child.stderr, /--max-runtime-invocations/);
});

test('workflow probe accepts an explicit Runtime invocation limit of 32', () => {
  const child = run(['--proof-dir', 'E:\\missing-proof', '--app-root', 'E:\\missing-app', '--max-runtime-invocations', '32']);
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /--app-root must be a real directory/);
  assert.doesNotMatch(child.stderr, /--max-runtime-invocations/);
});

test('workflow probe rejects malformed, out-of-range and duplicate Runtime invocation limits before preflight', () => {
  for (const [value, expected] of [['0', /1-48/], ['49', /1-48/], ['1.5', /整数/], ['NaN', /整数/]] as const) {
    const child = run(['--proof-dir', 'E:\\missing-proof', '--app-root', 'E:\\missing-app', '--max-runtime-invocations', value]);
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, expected);
    assert.doesNotMatch(child.stderr, /--app-root must be a real directory|proof missing/);
  }
  const duplicate = run(['--proof-dir', 'E:\\missing-proof', '--app-root', 'E:\\missing-app',
    '--max-runtime-invocations', '32', '--max-runtime-invocations', '32']);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /--max-runtime-invocations 重复/);
});
