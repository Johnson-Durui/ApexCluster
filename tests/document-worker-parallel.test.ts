import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');
// The shipped 启动文档服务.cmd runs this script with Windows PowerShell 5.1, which every Windows install has.
const powershell = process.env.DMW_TEST_POWERSHELL ?? 'powershell.exe';

test('document worker compose supports an isolated host port without changing container ports', () => {
  const compose = read('compose.yaml');
  assert.equal((compose.match(/dual-model-workbench\/document-worker:1\.1\.0/g) ?? []).length, 2);
  assert.match(compose, /127\.0\.0\.1:\$\{DOCUMENT_WORKER_PORT:-18781\}:18781/);
  assert.equal((compose.match(/127\.0\.0\.1:18781\/health/g) ?? []).length, 2);
});

test('document worker launcher derives a local root URL and isolates alternate compose projects', () => {
  const script = read('scripts/document-worker.ps1');
  assert.match(script, /\[int\]\$Port = 0/);
  assert.match(script, /chat\.config\.json/);
  assert.match(script, /chat-services\.json/);
  assert.match(script, /dual-model-workbench-docs-\$Port/);
  assert.match(script, /compose -p \$ComposeProject -f \$ComposeFile/);
  assert.match(script, /DOCUMENT_WORKER_PORT/);
  assert.match(script, /finally\s*\{/);
  assert.match(script, /UserInfo/);
  assert.match(script, /Query/);
  assert.match(script, /Fragment/);
});

test('document worker smoke endpoint can follow the selected launcher port', () => {
  const smoke = read('tests/document-worker_smoke.py');
  assert.match(smoke, /os\.environ\.get\("DOCUMENT_WORKER_URL", "http:\/\/127\.0\.0\.1:18781\/v1\/jobs"\)/);
});

test('document worker launcher passes isolated compose identity and restores its environment', { skip: process.platform !== 'win32' }, () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'document-worker-launcher-'));
  try {
    const app = path.join(fixture, 'app');
    const data = path.join(fixture, 'data');
    const bin = path.join(fixture, 'bin');
    for (const directory of [path.join(app, 'scripts'), path.join(app, 'tests'), path.join(app, 'config'), path.join(data, 'config'), bin]) mkdirSync(directory, { recursive: true });
    copyFileSync(path.join(root, 'scripts/document-worker.ps1'), path.join(app, 'scripts/document-worker.ps1'));
    copyFileSync(path.join(root, 'tests/document-worker_smoke.py'), path.join(app, 'tests/document-worker_smoke.py'));
    copyFileSync(path.join(root, 'compose.yaml'), path.join(app, 'compose.yaml'));
    writeFileSync(path.join(app, 'config/chat.config.json'), JSON.stringify({ dataRoot: data }));
    writeFileSync(path.join(data, 'config/chat-services.json'), JSON.stringify({ documentWorker: { url: 'http://127.0.0.1:28781' } }));
    const log = path.join(fixture, 'docker.log');
    writeFileSync(path.join(bin, 'docker.cmd'), '@echo args=%*>>"%DOCUMENT_WORKER_TEST_LOG%"\r\n@echo port=%DOCUMENT_WORKER_PORT%>>"%DOCUMENT_WORKER_TEST_LOG%"\r\n@echo url=%DOCUMENT_WORKER_URL%>>"%DOCUMENT_WORKER_TEST_LOG%"\r\n@exit /b 0\r\n');
    const script = path.join(app, 'scripts/document-worker.ps1').replaceAll("'", "''");
    const command = `$env:DOCUMENT_WORKER_PORT='sentinel-port'; $env:DOCUMENT_WORKER_URL='sentinel-url'; & '${script}' -Action build; & '${script}' -Action build -Port 18781; Write-Output "restored=$($env:DOCUMENT_WORKER_PORT),$($env:DOCUMENT_WORKER_URL)"`;
    const result = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8', env: { ...process.env, PATH: `${bin};${process.env.PATH}`, DOCUMENT_WORKER_TEST_LOG: log } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /restored=sentinel-port,sentinel-url/);
    const calls = readFileSync(log, 'utf8');
    assert.match(calls, /compose -p dual-model-workbench-docs-28781 .* build document-worker/);
    assert.match(calls, /port=28781/);
    assert.match(calls, /url=http:\/\/127\.0\.0\.1:28781\/v1\/jobs/);
    assert.match(calls, /compose -p dual-model-workbench .* build document-worker/);
    writeFileSync(path.join(data, 'config/chat-services.json'), JSON.stringify({ documentWorker: { url: 'http://user:pass@localhost:28781/path?query=1#fragment' } }));
    const rejected = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(app, 'scripts/document-worker.ps1'), '-Action', 'build'], { encoding: 'utf8', env: { ...process.env, PATH: `${bin};${process.env.PATH}`, DOCUMENT_WORKER_TEST_LOG: log } });
    assert.notEqual(rejected.status, 0);
    assert.match(`${rejected.stdout}\n${rejected.stderr}`, /local HTTP root URL without credentials, path, query, or fragment/);
    assert.equal(readFileSync(log, 'utf8'), calls, 'invalid URL reached Docker');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
