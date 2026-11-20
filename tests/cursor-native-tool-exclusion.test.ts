import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CURSOR_NATIVE_TOOL_EXCLUSION, CURSOR_NATIVE_TOOL_EXCLUSION_CSV, CURSOR_NATIVE_TOOL_EXCLUSION_LIST_SHA256,
  cursorNativeToolExclusionBinding, validateCursorNativeToolExclusionArtifact,
  type CursorNativeToolExclusionContract,
} from '../src/chat/cursor-native-tool-exclusion.js';
import { cursorReadonlyRuntimeSource } from '../src/chat/cursor-readonly-runtime.js';

const hash = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const snake = (value: string) => value.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);

function fixture() {
  const descriptor = CURSOR_NATIVE_TOOL_EXCLUSION.map((name, index) => `|${index + 1} ${snake(name)} #${index + 1} tool`).join('');
  const index = `"../proto/dist/generated/agent/v1/agent_pb.js"(x)static $(){return["ToolCall|${descriptor}"]}}class Hi --allowed-tools <tool> --exclude-tools <tool> x-cursor-agent-allowed-tools x-cursor-agent-exclude-tools`;
  const chunk = `"./src/utils/exclude-tools.ts"(x) "./src/utils/exclude-tools-headers.ts"(x) "./src/run-agent.tsx"(x)`;
  const root = '/fixed/cursor';
  const contract: CursorNativeToolExclusionContract = {
    cliVersion: 'cursor-agent fixture', root, indexSha256: hash(index), chunkSha256: hash(chunk), listSha256: CURSOR_NATIVE_TOOL_EXCLUSION_LIST_SHA256,
  };
  const file = (name: string, text: string) => ({ path: `${root}/${name}`, realpath: `${root}/${name}`, uid: 0, mode: 0o555, file: true, symlink: false, text });
  return { contract, artifact: { cliVersion: contract.cliVersion, index: file('index.js', index), chunk: file('7000.index.js', chunk) } };
}

test('fixed exclusion request is exactly one immutable ordered 72-tool CSV and chat argv has no allowed-tools', () => {
  assert.equal(CURSOR_NATIVE_TOOL_EXCLUSION.length, 72); assert.equal(new Set(CURSOR_NATIVE_TOOL_EXCLUSION).size, 72);
  assert.equal(CURSOR_NATIVE_TOOL_EXCLUSION.every(Boolean), true);
  assert.equal(hash(CURSOR_NATIVE_TOOL_EXCLUSION_CSV), CURSOR_NATIVE_TOOL_EXCLUSION_LIST_SHA256);
  const source = cursorReadonlyRuntimeSource('deny');
  assert.equal(source.split("'--exclude-tools'").length - 1, 1); assert.equal(source.split("'--allowed-tools'").length - 1, 0);
  assert.ok(source.includes(JSON.stringify(CURSOR_NATIVE_TOOL_EXCLUSION_CSV)));
  assert.equal(hash(readFileSync(fileURLToPath(new URL('../src/adapters/cursor-writer-runtime.mjs', import.meta.url)))), 'f19fdeb5e87956d9dfbd767b82dd0b57c5632dea94f8bf38a8443609d694f6f7');
});

test('fixed artifact verifier binds hashes, exact descriptor order/list digest, unique client header/run-agent anchors and nonempty expected value', () => {
  const { contract, artifact } = fixture();
  const result = validateCursorNativeToolExclusionArtifact(artifact, contract);
  assert.equal(result.nativeToolExclusionRequestVerified, true); assert.equal(result.toolCount, 72);
  assert.equal(result.entrySha256, contract.indexSha256); assert.equal(result.chunkSha256, contract.chunkSha256);
  assert.equal(result.listSha256, CURSOR_NATIVE_TOOL_EXCLUSION_LIST_SHA256);
  assert.equal(result.expectedExcludeHeaderValue, CURSOR_NATIVE_TOOL_EXCLUSION_CSV);
});

test('artifact verifier rejects entry/chunk/descriptor/anchor and fixed-list drift before dispatch', () => {
  const mutate = (kind: string, change: (value: ReturnType<typeof fixture>) => void) => {
    const value = fixture(); change(value); assert.throws(() => validateCursorNativeToolExclusionArtifact(value.artifact, value.contract), new RegExp(kind));
  };
  mutate('index SHA', value => { value.artifact.index.text += 'x'; });
  mutate('chunk SHA', value => { value.artifact.chunk.text += 'x'; });
  mutate('registration anchor', value => { value.artifact.index.text = value.artifact.index.text.replace('--exclude-tools <tool>', '--changed <tool>'); value.contract.indexSha256 = hash(value.artifact.index.text); });
  mutate('anchor drift', value => { value.artifact.index.text = value.artifact.index.text.replace('x-cursor-agent-exclude-tools', 'x-other'); value.contract.indexSha256 = hash(value.artifact.index.text); });
  mutate('run-agent anchor', value => { value.artifact.chunk.text = value.artifact.chunk.text.replace('./src/run-agent.tsx', './src/other.tsx'); value.contract.chunkSha256 = hash(value.artifact.chunk.text); });
  for (const replacement of ['', '|999 added_tool_call #999 tool', '|1 shell_tool_call #1 tool|1 shell_tool_call #1 tool']) mutate('descriptor', value => {
    value.artifact.index.text = value.artifact.index.text.replace('|1 shell_tool_call #1 tool', replacement); value.contract.indexSha256 = hash(value.artifact.index.text);
  });
  mutate('descriptor', value => { value.artifact.index.text = value.artifact.index.text.replace('|1 shell_tool_call #1 tool|2 delete_tool_call #2 tool', '|2 delete_tool_call #2 tool|1 shell_tool_call #1 tool'); value.contract.indexSha256 = hash(value.artifact.index.text); });
  mutate('list digest', value => { value.contract.listSha256 = '0'.repeat(64); });
  for (const field of ['uid', 'mode', 'file', 'symlink', 'realpath'] as const) mutate('artifact metadata', value => {
    Object.assign(value.artifact.chunk, field === 'uid' ? { uid: 1000 } : field === 'mode' ? { mode: 0o577 } : field === 'file' ? { file: false } : field === 'symlink' ? { symlink: true } : { realpath: '/other' });
  });
});

test('proof binding names only fixed client request semantics and binds implementation', () => {
  const binding = cursorNativeToolExclusionBinding();
  assert.deepEqual(Object.keys(binding).sort(), ['chunkSha256', 'entrySha256', 'implementationSha256', 'listSha256', 'nativeToolExclusionRequestVerified'].sort());
  assert.equal(binding.nativeToolExclusionRequestVerified, true);
  assert.equal('nativeSurfaceRemoved' in binding || 'toolsEmpty' in binding || 'networkDenied' in binding, false);
  assert.match(binding.implementationSha256, /^[a-f0-9]{64}$/);
});

test('fresh Grok qualification fingerprint and both proof registrars bind the v7 exclusion request', () => {
  const approval = readFileSync(fileURLToPath(new URL('../scripts/chat-live-grok-approval-probe.ts', import.meta.url)), 'utf8');
  const course = readFileSync(fileURLToPath(new URL('../scripts/chat-course-model-proofs.ts', import.meta.url)), 'utf8');
  const provision = readFileSync(fileURLToPath(new URL('../scripts/chat-provision-model-proofs.ts', import.meta.url)), 'utf8');
  assert.match(approval, /commandFingerprint\(cmd, 'grok', MODEL, EFFORT, cap\)/);
  for (const source of [course, provision]) {
    assert.match(source, /nativeToolExclusionRequestVerified/);
    assert.match(source, /nativeToolExclusion:\s*(?:drivers\.)?cursorNativeToolExclusionBinding\(\)/);
  }
});
