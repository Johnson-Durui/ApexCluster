import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { nativeMediaFingerprintPath } from '../src/chat/codex-native-media.js';

test('native media fingerprints use the same physical Windows path for alternate casing', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'media-path-case-'));
  const commandFile = path.join(root, 'Codex-Fixture.exe');
  writeFileSync(commandFile, 'fingerprint fixture, never executed');
  try {
    const expected = nativeMediaFingerprintPath(commandFile);
    assert.equal(nativeMediaFingerprintPath(commandFile.toLowerCase()), expected);
    assert.equal(nativeMediaFingerprintPath(process.execPath.toLowerCase()), nativeMediaFingerprintPath(process.execPath));
    assert.throws(() => nativeMediaFingerprintPath(root), /文件不安全/);
    assert.throws(() => nativeMediaFingerprintPath(path.join(root, 'missing.exe')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
