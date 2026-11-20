// Deterministic fake for Cursor `agent --print --output-format stream-json ...`.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
if (process.env.CURSOR_CONFIG_DIR) {
  mkdirSync(path.join(process.env.CURSOR_CONFIG_DIR, 'cache'), { recursive: true });
  writeFileSync(path.join(process.env.CURSOR_CONFIG_DIR, 'account.json'), JSON.stringify({ email: 'fixture@example.invalid', token: 'fixture-secret' }));
  writeFileSync(path.join(process.env.CURSOR_CONFIG_DIR, 'cache', 'chat-store.json'), JSON.stringify({ chat: 'fixture-private' }));
}
const nativeGrokVersion = argv[0] === '--fake-grok-version';
if (nativeGrokVersion) argv.shift();
if (argv[0] === '--version') {
  if (process.env.FAKE_VERSION_HANG) await new Promise((resolve) => setTimeout(resolve, 60_000));
  if (process.env.FAKE_VERSION_FILE) {
    writeFileSync(process.env.FAKE_VERSION_FILE, JSON.stringify({
      CURSOR_API_KEY: process.env.CURSOR_API_KEY ?? null,
      CURSOR_API_ENDPOINT: process.env.CURSOR_API_ENDPOINT ?? null,
      CURSOR_CONFIG_DIR: process.env.CURSOR_CONFIG_DIR ?? null,
    }));
  }
  process.stdout.write(`${nativeGrokVersion ? 'grok 1.0.0 (fake)' : process.env.FAKE_CURSOR_VERSION ?? 'cursor-agent 2026.10.0'}\n`);
  process.exit(0);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
if (process.env.FAKE_ARGS_FILE) {
  writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify({
    argv,
    prompt,
    env: {
      CURSOR_API_KEY: process.env.CURSOR_API_KEY ?? null,
      CURSOR_API_ENDPOINT: process.env.CURSOR_API_ENDPOINT ?? null,
      CURSOR_CONFIG_DIR: process.env.CURSOR_CONFIG_DIR ?? null,
    },
    cwd: process.cwd(),
  }));
}

const arg = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
};
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const mode = process.env.FAKE_MODE ?? 'ok';
const model = mode === 'mismatch' ? 'Grok Wrong Display Name' : 'Grok 4.7 256K High Fast';
const initCwd = mode === 'cwd_mismatch' ? path.dirname(process.cwd()) : process.cwd();

if (mode === 'auth') {
  process.stderr.write('Authentication failed: 401 unauthorized\n');
  process.exit(1);
}

emit({ type: 'system', subtype: 'init', model: mode === 'missing_model' ? undefined : model, cwd: mode === 'missing_cwd' ? undefined : initCwd, ...(mode === 'missing_init_session' ? {} : { session_id: 'cursor-session-1' }) });
if (mode === 'unknown') emit({ type: 'future_event', opaque: { usage: 'must-not-be-guessed' } });
if (mode === 'read') {
  emit({ type: 'tool_call', subtype: 'started', call_id: 'read-1', tool_call: { readToolCall: { args: { path: '.cursor/cli.json' } } } });
  emit({ type: 'tool_call', subtype: 'completed', call_id: 'read-1', tool_call: { readToolCall: { args: { path: '.cursor/cli.json' } } } });
}
if (mode === 'tool_hang') {
  emit({ type: 'tool_call', subtype: 'started', call_id: 'read-hang', tool_call: { readToolCall: { args: { path: '.cursor/cli.json' } } } });
  await new Promise((resolve) => setTimeout(resolve, 60_000));
}
if (mode === 'unknown_tool') emit({ type: 'tool_call', subtype: 'completed', call_id: 'future-1', tool_call: { futureWriteToolCall: { args: { path: 'changed.txt' } } } });
if (mode === 'write') {
  emit({ type: 'tool_call', subtype: 'completed', call_id: 'write-1', tool_call: { writeToolCall: { args: { path: 'changed.txt' } } } });
}
if (mode === 'edit') emit({ type: 'tool_call', subtype: 'completed', call_id: 'edit-1', tool_call: { editToolCall: { args: { path: 'changed.txt' } } } });
if (mode !== 'no_terminal') {
  const usage = mode === 'invalid_usage'
    ? { inputTokens: 12, outputTokens: -1, cacheReadTokens: 3, cacheWriteTokens: 0 }
    : { inputTokens: 12, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 0 };
  const isError = mode === 'missing_is_error' ? {} : { is_error: mode === 'string_is_error' ? 'false' : mode === 'error_conflict' };
  emit({ type: 'result', subtype: 'success', ...isError, result: '{"digest":"ok"}', duration_ms: 12, usage, ...(mode === 'missing_result_session' ? {} : { session_id: mode === 'session_mismatch' ? 'cursor-session-2' : 'cursor-session-1' }) });
  if (mode === 'duplicate_result') emit({ type: 'result', subtype: 'success', result: '{"digest":"again"}', duration_ms: 13, session_id: 'cursor-session-1' });
}
process.exit(0);
