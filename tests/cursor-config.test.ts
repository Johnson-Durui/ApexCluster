import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createApp } from '../src/server/app.js';
import { makeHarness } from './helpers.js';
import { cursorAvailability } from '../src/core/cursor-capabilities.js';
import type { CursorCapabilities } from '../src/adapters/cursor.js';

test('只读能力状态要求精确型号、显示名、策略与有效版本证据；旧能力不会自动升级', () => {
  const complete: CursorCapabilities = {
    verifiedAt: '2026-10-23T10:00:00.000Z', cliVersion: 'test-cursor-version', model: 'grok-4.7-high-fast',
    reportedModel: 'Grok 4.7 256K High Fast', toolPolicy: 'deny_all',
    commandBinding: { file: process.execPath, prefixArgs: [] },
    stdinPromptVerified: true, readOnlyToolsVerified: true, commandExitEventsVerified: false, fileChangesVerified: false,
  };
  const check = (cap: CursorCapabilities | null) => cursorAvailability('grok-4.7-high-fast', cap, { command: process.execPath }).available;
  assert.equal(check(complete), true);
  assert.equal(check(null), false);
  for (const patch of [
    { reportedModel: undefined, toolPolicy: undefined }, { reportedModel: '  ' }, { toolPolicy: null },
    { verifiedAt: 'invalid-date' }, { cliVersion: null }, { stdinPromptVerified: false },
    { readOnlyToolsVerified: false }, { model: 'other-model' },
    { commandBinding: undefined }, { commandBinding: { file: 'unverified.exe', prefixArgs: [] } },
  ] as Partial<CursorCapabilities>[]) assert.equal(check({ ...complete, ...patch }), false);
  assert.equal(cursorAvailability('other-model', { ...complete, model: 'other-model' }).available, false);
  assert.equal(cursorAvailability('grok-4.7-high-fast', complete, { command: process.execPath, args: ['--force'] }).available, false);
});

test('GET /api/config 直接返回第四模型和只读能力状态，不需要启动 Cursor CLI', async () => {
  const h = makeHarness({}, config => {
    config.adapters.cursor.capabilities = null;
    config.adapters.cursor.command = { command: path.join(hypotheticalMissingRoot(), 'cursor-do-not-run.exe'), args: [] };
  });
  const token = 'c'.repeat(64);
  const handler = createApp({ config: h.config, orchestrator: h.orch, bus: h.bus, token, staticDir: path.join(h.dir, 'missing-web') });
  const request = Object.assign(Readable.from([]), {
    method: 'GET', url: '/api/config', headers: { host: `127.0.0.1:${h.config.port}` }, socket: { remoteAddress: '127.0.0.1' },
  });
  const headers = new Map<string, unknown>();
  let statusCode = 200;
  let text = '';
  const response = {
    get statusCode() { return statusCode; },
    set statusCode(value: number) { statusCode = value; },
    setHeader(name: string, value: unknown) { headers.set(name.toLowerCase(), value); },
    getHeader(name: string) { return headers.get(name.toLowerCase()); },
    writeHead(code: number, values?: Record<string, unknown>) {
      statusCode = code;
      for (const [name, value] of Object.entries(values ?? {})) headers.set(name.toLowerCase(), value);
      return this;
    },
    end(value?: string | Buffer) { if (value) text += value.toString(); },
  };
  await handler(request as never, response as never);
  const body = JSON.parse(text);
  assert.equal(statusCode, 200);
  assert.deepEqual(body.models.grok, {
    role: 'grok', adapter: 'cursor', model: 'grok-4.7-high-fast', effort: 'high',
  });
  assert.deepEqual(body.chores, { digest: false, qgroup: false });
  assert.equal(body.cursorCapabilities.available, false);
  assert.equal(body.cursorCapabilities.model, 'grok-4.7-high-fast');
  assert.equal(body.cursorCapabilities.capabilities, null);
});

function hypotheticalMissingRoot(): string {
  return path.join(process.cwd(), '.test-tmp', 'intentionally-missing');
}
