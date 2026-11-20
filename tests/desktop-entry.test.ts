import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers.js';

test('desktop entry preserves the real asset identity when Windows launches a differently cased path', () => {
  const root = path.join(tempDir('dmw-entry-'), 'MixedCaseApp');
  mkdirSync(path.join(root, 'src', 'server'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  const entry = path.join(root, 'desktop.mjs');
  writeFileSync(entry, readFileSync(fileURLToPath(new URL('../scripts/desktop/desktop-entry.mjs', import.meta.url))));
  writeFileSync(path.join(root, 'src', 'server', 'desktop.js'), "import {fileURLToPath} from 'node:url'; export async function runDesktopHost(){console.log(JSON.stringify({asset:fileURLToPath(new URL('../chat/windows-job-supervisor.exe',import.meta.url))}));}\n");
  const expected = path.join(root, 'src', 'chat', 'windows-job-supervisor.exe');
  for (const invoked of [entry, process.platform === 'win32' ? entry.toLowerCase() : entry]) {
    const result = execFileSync(process.execPath, [invoked], { cwd: path.dirname(invoked), windowsHide: true, timeout: 5000, encoding: 'utf8' });
    assert.equal((JSON.parse(result) as { asset: string }).asset, expected);
  }
});
