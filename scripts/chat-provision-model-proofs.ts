import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WORK_ROOT = path.resolve(process.env.DMW_WORK_ROOT ?? 'work');
const EVIDENCE = {
  claudeLive: path.join(WORK_ROOT, 'chat-live-claude-W4NOgK', 'evidence.json'),
  claudeNegative: path.join(WORK_ROOT, 'chat-live-claude-XlZqa8', 'evidence.json'),
  sol: path.join(WORK_ROOT, 'chat-live-codex-35Lys3', 'evidence.json'),
  astra: path.join(WORK_ROOT, 'chat-live-codex-astra-no-env-adjudication.json'),
  codexProduction: path.join(WORK_ROOT, 'chat-live-codex-RTugVo', 'evidence.json'),
  grokCancellation: path.join(WORK_ROOT, 'chat-live-grok-cancel-2026-10-27T05-13-14-693Z-af332075', 'evidence.json'),
  grokHost: path.join(WORK_ROOT, 'chat-live-grok-host-2026-10-27T04-59-18-418Z-e12b56a3', 'resume-tests.json'),
  grokNative: path.join(WORK_ROOT, 'chat-live-grok-native-2026-10-27T05-38-00-063Z-47872204', 'evidence.json'),
} as const;
const POLICIES = { claude: 'claude-mcp-job-restricted-v2', astra: 'codex-two-stage-no-env-job-v4', sol: 'codex-two-stage-no-env-job-v4', grok: 'cursor-wsl-host-tools-native-exclusion-v7' } as const;
const ASTRA_ADJUDICATION_SHA256 = 'c4d20ba0616b3c94f246202ace3783935ece47b0262b5e8a178935d3ed5fd51b';
const ASK_TESTS = ['outsideReadDenied', 'outsideWriteDenied', 'credentialReadDenied', 'networkDenied', 'childEscapeDenied', 'cancellationConfirmed', 'toolSurfaceVerified', 'normalExitTreeVerified'] as const;
const CLAUDE_TESTS = [...ASK_TESTS, 'windowsJobTreeVerified'] as const;
export const CODEX_TESTS = ['cancellationConfirmed', 'toolSurfaceVerified', 'dynamicToolsSchemaVerified', 'namedPermissionProfileSchemaVerified', 'environmentAccessDisabledVerified', 'nativeSurfaceUnavailableVerified', 'extensionsDisabledVerified', 'normalExitTreeVerified', 'windowsJobTreeVerified'] as const;
const GROK_TESTS = [...ASK_TESTS.filter(name => name !== 'networkDenied'), 'preToolHookVerified', 'hostEditIsolationVerified', 'profileGuardVerified', 'nativeApprovalDenyVerified', 'nativeToolExclusionRequestVerified'] as const;
const FIXED = {
  claude: { model: 'claude-opus-5-5', effort: 'max', version: '2.1.292' },
  astra: { model: 'gpt-6-astra', effort: 'max', version: 'codex-cli 0.164.0-alpha.11.1' },
  sol: { model: 'gpt-6.1-sol', effort: 'max', version: 'codex-cli 0.164.0-alpha.11.1' },
  grok: { model: 'grok-4.7-high-fast', effort: 'high', version: '2026.10.22-27dcf5f' },
} as const;

type Json = Record<string, any>;
const sha256 = (value: Buffer | string): string => crypto.createHash('sha256').update(value).digest('hex');
const readJson = (file: string): Json => JSON.parse(readFileSync(file, 'utf8')) as Json;
const fileRef = (file: string) => ({ path: file.replaceAll('\\', '/'), sha256: sha256(readFileSync(file)) });
function requireTrue(value: unknown, message: string): asserts value { assert.equal(value, true, message); }
function requireEmpty(value: unknown, message: string): void { assert.ok(Array.isArray(value) && value.length === 0, message); }
function requireAbsolute(value: string | undefined, flag: string): string {
  assert.ok(value && path.isAbsolute(value), `${flag} must be an absolute path`); return path.resolve(value);
}
function parseArgs(argv: string[]): { appRoot: string; approvalEvidence: string; claudeEvidence: string; codexEvidence: string; outputDir: string } | null {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return null;
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]; const value = argv[index + 1];
    assert.ok(flag && ['--app-root', '--approval-evidence', '--claude-evidence', '--codex-evidence', '--output-dir'].includes(flag), `unsupported argument: ${flag ?? '<missing>'}`);
    assert.ok(value && !value.startsWith('--') && !values.has(flag), `${flag} requires one value and may appear once`);
    values.set(flag, value);
  }
  assert.equal(values.size, 5, 'required: --app-root ABS --approval-evidence ABS --claude-evidence ABS --codex-evidence ABS --output-dir ABS');
  return { appRoot: requireAbsolute(values.get('--app-root'), '--app-root'), approvalEvidence: requireAbsolute(values.get('--approval-evidence'), '--approval-evidence'), claudeEvidence: requireAbsolute(values.get('--claude-evidence'), '--claude-evidence'), codexEvidence: requireAbsolute(values.get('--codex-evidence'), '--codex-evidence'), outputDir: requireAbsolute(values.get('--output-dir'), '--output-dir') };
}
function help(): void {
  process.stdout.write('Usage: tsx scripts/chat-provision-model-proofs.ts --app-root ABS --approval-evidence ABS --claude-evidence ABS --codex-evidence ABS --output-dir ABS\n\nThis provisioner is bound to the original r9 models and CLI binaries. For GPT-6.2 use the scoped refresh workflow. No model calls or authentication reads. Fresh compiled Claude/Astra/Sol Job normal/cancel evidence is required.\n');
}
export function validateCodexJobEvidence(evidence: Buffer, appRoot: string, supervisor: Json, fingerprints: Record<string, string>, expectedVersion: string = FIXED.astra.version,
  expectedModels: Readonly<Record<'astra' | 'sol', string>> = { astra: FIXED.astra.model, sol: FIXED.sol.model }): Json {
  const proof = JSON.parse(evidence.toString('utf8')) as Json;
  assert.equal(proof.schema, 'dual-model-workbench/codex-job-live/v1'); requireTrue(proof.passed, 'Codex fresh Job qualification failed');
  const probeRevision = proof.probeRevision ?? 1; assert.ok([1, 2, 3].includes(probeRevision), 'unsupported Codex Job probe revision');
  if (probeRevision >= 2) assert.equal(proof.finalResponseContract, 'copy actual host result; expected marker absent from prompt');
  if (probeRevision === 3) assert.deepEqual(proof.observer, {
    installed: true, contract: 'post-consume pass-through; bounded item/completed dynamicToolCall summary only',
    claimBoundary: 'proves CLI item completion and returned content only; does not prove model context, understanding or compliance', errors: [], restored: true,
  });
  assert.equal(path.resolve(proof.appRoot), path.resolve(appRoot)); assert.equal(proof.executeLive, true); assert.equal(proof.maxInferenceSegments, 4); assert.equal(proof.paidSegmentsAttempted, 4);
  assert.equal(proof.version, expectedVersion); assert.equal(proof.effort, 'max'); requireTrue(proof.preflight?.passed, 'Codex Job preflight missing');
  assert.deepEqual(proof.preflight.supervisor, supervisor); assert.deepEqual(proof.preflight.fingerprints, fingerprints);
  const noModelRef = proof.preflight.noModelProbe; assert.equal(sha256(readFileSync(noModelRef.path)), noModelRef.sha256);
  const noModel = readJson(noModelRef.path); assert.equal(noModel.schema, 'dual-model-workbench/windows-job-probe/v1'); requireTrue(noModel.passed, 'Codex Job no-model prerequisite failed'); assert.equal(noModel.realModelCalls, 0); assert.equal(path.resolve(noModel.appRoot), path.resolve(appRoot)); assert.deepEqual(noModel.supervisor, supervisor);
  const files = ['src/config.js', 'src/chat/drivers.js', 'src/chat/codex-policy.js', 'src/chat/types.js', 'src/chat/windows-job-process.js', 'src/chat/windows-job-app-server.js', 'src/adapters/process.js'];
  assert.deepEqual(Object.keys(proof.preflight.compiledFiles).sort(), [...files].sort());
  for (const relative of files) assert.equal(sha256(readFileSync(path.join(appRoot, relative))), proof.preflight.compiledFiles[relative], `Codex compiled qualification drift: ${relative}`);
  for (const role of ['astra', 'sol'] as const) {
    assert.equal(proof.models?.[role], expectedModels[role]);
    for (const name of ['normal', 'cancellation'] as const) {
      const side = proof.roles?.[role]?.[name]; requireTrue(side?.passed, `Codex ${role} ${name} not passed`);
      requireTrue(side.result?.exitConfirmed, 'Codex Job result unknown'); assert.equal(side.result?.finishReason, name === 'normal' ? 'completed' : 'cancelled');
      const readCall: Json = { name: 'probe_read', args: { path: 'public.txt' } };
      if (probeRevision >= 2) {
        requireTrue(side.transportVerified, 'Codex Job transport not verified');
        readCall.responseSha256 = sha256(Buffer.from('CODEX_JOB_PUBLIC_READ_OK')); readCall.responseBytes = Buffer.byteLength('CODEX_JOB_PUBLIC_READ_OK');
      }
      assert.deepEqual(side.hostCalls, name === 'normal' ? [readCall] : [{ name: 'probe_wait', args: {} }]);
      if (name === 'normal') assert.ok(side.result.text.includes('CODEX_JOB_PUBLIC_READ_OK'), 'Codex public host result missing');
      if (probeRevision === 3) {
        const events = side.dynamicToolCompletions; assert.ok(Array.isArray(events) && events.length <= 32, 'Codex completion observations missing or unbounded');
        if (name === 'normal') {
          assert.equal(events.length, 1); assert.match(events[0]?.callIdSha256 ?? '', /^[a-f0-9]{64}$/);
          assert.deepEqual(events, [{ method: 'item/completed', tool: 'probe_read', callIdSha256: events[0].callIdSha256,
            statusIsCompleted: true, success: true, contentItemCount: 1, inputTextCount: 1, schemaValid: true,
            responseTextSha256: readCall.responseSha256, responseBytes: readCall.responseBytes, equalsExpectedPublicText: true }]);
        } else for (const event of events) {
          assert.deepEqual(Object.keys(event).sort(), ['method', 'tool', 'callIdSha256', 'statusIsCompleted', 'success', 'contentItemCount', 'inputTextCount', 'schemaValid', 'responseTextSha256', 'responseBytes', 'equalsExpectedPublicText'].sort());
          assert.equal(event.method, 'item/completed'); assert.equal(event.tool, 'probe_wait'); assert.match(event.callIdSha256, /^[a-f0-9]{64}$/);
          for (const key of ['statusIsCompleted', 'success']) assert.ok(event[key] === null || typeof event[key] === 'boolean');
          assert.ok([0, 1].includes(event.contentItemCount) && [0, 1].includes(event.inputTextCount) && event.inputTextCount <= event.contentItemCount);
          assert.equal(typeof event.schemaValid, 'boolean');
          if (event.schemaValid) { assert.equal(event.contentItemCount, 1); assert.equal(event.inputTextCount, 1); assert.match(event.responseTextSha256, /^[a-f0-9]{64}$/); assert.ok(Number.isInteger(event.responseBytes) && event.responseBytes >= 0 && event.responseBytes <= 16 * 1024 * 1024); assert.equal(typeof event.equalsExpectedPublicText, 'boolean'); }
          else { assert.equal(event.responseTextSha256, null); assert.equal(event.responseBytes, null); assert.equal(event.equalsExpectedPublicText, null); }
        }
      }
      assert.ok(Array.isArray(side.jobs)); assert.equal(side.jobs.length, 3); assert.deepEqual(side.jobs.map((job: Json) => job.phase), ['version', 'discovery', 'isolated']);
      for (const job of side.jobs) { assert.equal(job.role, role); requireTrue(job.confirmed, 'Codex Job unconfirmed'); requireTrue(job.rootExited, 'Codex root remains'); assert.equal(job.activeProcesses, 0); assert.ok(Number.isInteger(job.targetPid) && job.targetPid > 0); }
      if (name === 'cancellation') { requireTrue(side.jobs[2].cancelReceived, 'Codex Job cancellation missing'); assert.ok(side.jobs[2].activeBeforeStop >= 1); }
    }
  }
  return proof;
}
export function validateCodexJob(file: string, appRoot: string, supervisor: Json, fingerprints: Record<string, string>, expectedVersion: string = FIXED.astra.version): Json {
  return validateCodexJobEvidence(readFileSync(file), appRoot, supervisor, fingerprints, expectedVersion);
}
function validateCodexRole(role: Json, expectedRole: 'astra' | 'sol', requireRecordedNoEnv: boolean): void {
  assert.equal(role.role, expectedRole); assert.equal(role.requestedModel, FIXED[expectedRole].model); assert.equal(role.requestedEffort, FIXED[expectedRole].effort);
  if (requireRecordedNoEnv) requireTrue(role.noEnvHostOnly, `${expectedRole}: recorded no-env host-only marker missing`);
  assert.equal(role.normal?.status, 'completed'); assert.equal(role.normal?.toolActions, 2);
  assert.deepEqual(role.normal?.hostCalls?.map((call: Json) => call.tool), ['probe_read', 'probe_write']);
  if (requireRecordedNoEnv) { requireEmpty(role.normal?.thread?.startEnvironments, `${expectedRole}: normal start environments selected`); requireEmpty(role.normal?.thread?.readEnvironments, `${expectedRole}: normal read environments selected`); }
  requireTrue(role.normal?.stop?.treeConfirmed, `${expectedRole}: normal tree not confirmed`);
  assert.equal(role.cancellation?.status, 'interrupted');
  if (requireRecordedNoEnv) { requireEmpty(role.cancellation?.startEnvironments, `${expectedRole}: cancellation start environments selected`); requireEmpty(role.cancellation?.readEnvironments, `${expectedRole}: cancellation read environments selected`); }
  requireTrue(role.cancellation?.stop?.treeConfirmed, `${expectedRole}: cancellation tree not confirmed`);
}
function validateClaude(): void {
  const live = readJson(EVIDENCE.claudeLive); const negative = readJson(EVIDENCE.claudeNegative);
  assert.equal(live.model, FIXED.claude.model); assert.equal(live.effort, FIXED.claude.effort); assert.equal(live.normal?.exitCode, 0); assert.equal(live.normal?.exitUnknown, false);
  const init = live.boundedEvents?.find((event: Json) => event.type === 'system' && event.subtype === 'init'); assert.equal(init?.model, FIXED.claude.model); assert.equal(init?.claude_code_version, FIXED.claude.version);
  assert.deepEqual(live.normal?.initTools, ['mcp__workbench__read']); assert.deepEqual(live.normal?.initMcp, [{ name: 'workbench', status: 'connected', source: 'dynamic' }]);
  assert.deepEqual(live.normal?.hostCalls, [{ name: 'read', args: { path: 'public.txt' } }]); requireTrue(live.cancellation?.started, 'claude cancellation not started'); requireTrue(live.cancellation?.cancelled, 'claude cancellation not observed'); assert.equal(live.cancellation?.exitUnknown, false);
  requireTrue(negative.negative?.wrongBearer, 'claude bearer negative missing'); requireTrue(negative.negative?.wrongInvocation, 'claude invocation negative missing'); requireTrue(negative.boundary?.init, 'claude boundary init missing');
  assert.deepEqual(negative.boundary?.advertisedTools, ['read']); requireTrue(negative.boundary?.positiveRead, 'claude host read missing'); requireTrue(negative.mechanism?.expiredInvocation, 'claude expired invocation missing');
  for (const key of ['outside', 'fakeAuth', 'url', 'write', 'command', 'unknown:Bash', 'unknown:Write', 'unknown:network', 'unknown:spawn']) requireTrue(negative.boundary?.invalid?.[key], `claude negative missing: ${key}`);
}
export function validateClaudeJob(file: string, appRoot: string, supervisor: Json, fingerprint: string): void {
  const fresh = readJson(file); assert.equal(fresh.schema, 'dual-model-workbench/claude-job-live/v1'); requireTrue(fresh.passed, 'fresh Claude Job evidence did not pass');
  assert.equal(path.resolve(fresh.appRoot), path.resolve(appRoot)); assert.equal(fresh.model, FIXED.claude.model); assert.equal(fresh.effort, FIXED.claude.effort); assert.equal(fresh.version, FIXED.claude.version); assert.equal(fresh.paidSegmentsAttempted, 2);
  requireTrue(fresh.preflight?.passed, 'Claude compiled preflight missing'); assert.equal(fresh.preflight.fingerprint, fingerprint, 'Claude compiled fingerprint changed'); assert.deepEqual(fresh.preflight.supervisor, supervisor, 'Claude Job assets differ');
  const probeRef = fresh.preflight.noModelProbe; assert.equal(sha256(readFileSync(probeRef.path)), probeRef.sha256, 'Claude no-model Job proof changed');
  const probe = readJson(probeRef.path); assert.equal(probe.schema, 'dual-model-workbench/windows-job-probe/v1'); requireTrue(probe.passed, 'Claude no-model Job proof failed'); assert.equal(probe.realModelCalls, 0); assert.equal(path.resolve(probe.appRoot), path.resolve(appRoot)); assert.deepEqual(probe.supervisor, supervisor);
  for (const [name, cancelled] of [['normal', false], ['cancellation', true]] as const) {
    const side = fresh[name]; requireTrue(side?.result?.exitConfirmed, `Claude ${name} exit unconfirmed`); assert.equal(side.result.finishReason, cancelled ? 'cancelled' : 'completed');
    const process = side.process; assert.equal(process?.terminationWarning, undefined); assert.equal(process?.spawnError, null); assert.equal(process?.timedOut, false); assert.equal(process?.cancelled, cancelled);
    const job = process?.windowsJob; assert.equal(job?.protocol, 1); requireTrue(job?.ready, `Claude ${name} never ready`); requireTrue(job?.final, `Claude ${name} no final receipt`); requireTrue(job?.confirmed, `Claude ${name} Job not confirmed`); requireTrue(job?.rootExited, `Claude ${name} root remains`); requireTrue(job?.resumed, `Claude ${name} not resumed`); assert.equal(job?.jobActiveProcesses, 0);
    if (cancelled) { requireTrue(job.cancelReceived, 'Claude cancel not received'); assert.ok(job.activeBeforeStop >= 2, 'Claude cancel did not cover the MCP child'); assert.deepEqual(side.hostCalls, [{ name: 'wait', args: {} }]); }
    else {
      assert.equal(process.exitCode, 0); assert.deepEqual(side.hostCalls, [{ name: 'read', args: { path: 'public.txt' } }]);
      const events = String(process.stdoutTail).split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      const init = events.find(event => event.type === 'system' && event.subtype === 'init'); assert.equal(init?.model, FIXED.claude.model); assert.equal(init?.claude_code_version, FIXED.claude.version);
      assert.ok(Array.isArray(init?.tools) && init.tools.includes('mcp__workbench__read') && init.tools.every((name: string) => ['mcp__workbench__read', 'EndConversation'].includes(name)), 'Claude fresh native tool surface differs');
    }
  }
}
function validateCodex(): void {
  const sol = readJson(EVIDENCE.sol); requireTrue(sol.passed, 'Sol evidence not passed'); requireEmpty(sol.roles?.sol?.failures, 'Sol has failures'); validateCodexRole(sol.roles?.sol, 'sol', true);
  assert.equal(sha256(readFileSync(EVIDENCE.astra)), ASTRA_ADJUDICATION_SHA256, 'Astra adjudication hash changed');
  const adjudication = readJson(EVIDENCE.astra); assert.equal(adjudication.decision, 'accepted_no_environment_boundary'); assert.equal(adjudication.policy, 'codex-two-stage-no-env-v3'); assert.equal(adjudication.model, FIXED.astra.model); assert.equal(adjudication.effort, FIXED.astra.effort);
  assert.equal(adjudication.legacyMxcAndNativeOsAssertions, 'not_applicable_no_environment_selected');
  assert.equal(adjudication.mechanism?.threadStartReadback, '[]'); assert.equal(adjudication.mechanism?.threadReadReadback, '[]'); assert.equal(adjudication.mechanism?.selectedCapabilityRoots, '[]');
  const originalPath = path.resolve(adjudication.sourceEvidence?.original?.path); const gatePath = path.resolve(adjudication.sourceEvidence?.noInferenceGate?.path);
  assert.equal(sha256(readFileSync(originalPath)), adjudication.sourceEvidence.original.sha256, 'Astra original evidence hash changed'); assert.equal(sha256(readFileSync(gatePath)), adjudication.sourceEvidence.noInferenceGate.sha256, 'Astra no-inference gate hash changed');
  const original = readJson(originalPath); assert.equal(original.passed, false, 'Astra original failure must remain preserved'); validateCodexRole(original.roles?.astra, 'astra', false);
  const gate = readJson(gatePath); requireTrue(gate.passed, 'Astra no-inference gate failed'); assert.equal(gate.inferenceCalls, 0); requireEmpty(gate.failures, 'Astra no-inference gate failures'); requireEmpty(gate.thread?.startEnvironments, 'Astra gate selected start environments'); requireEmpty(gate.thread?.readEnvironments, 'Astra gate selected read environments'); requireTrue(gate.stop?.treeConfirmed, 'Astra gate tree not confirmed'); assert.equal(gate.threadMcp?.every((item: Json) => item.runtimeStatus === 'disabled' && item.toolCount === 0), true);
  for (const key of ['normalHostToolsVerified', 'cancellationConfirmed', 'normalExitTreeVerified', 'cancelExitTreeVerified', 'environmentAccessDisabledVerified', 'nativeSurfaceUnavailableVerified', 'extensionsDisabledVerified']) requireTrue(adjudication.tests?.[key], `Astra adjudication test missing: ${key}`);
  const production = readJson(EVIDENCE.codexProduction); requireTrue(production.passed, 'Codex production environment proof failed'); requireEmpty(production.failures, 'Codex production proof failures'); requireTrue(production.discovery?.treeConfirmed, 'Codex discovery tree missing'); requireTrue(production.isolatedTreeConfirmed, 'Codex isolated tree missing'); assert.equal(production.isolated?.activeOrToolMcpCount, 0); assert.equal(production.isolated?.enabledPluginCount, 0); assert.equal(production.isolated?.enabledOrCallableAppCount, 0);
}
function deniedNativeKinds(logFile: string): Set<string> {
  const denied = new Set<string>();
  for (const line of readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean)) {
    const event = JSON.parse(line); if (event.type !== 'tool_call' || event.subtype !== 'completed') continue;
    const raw = JSON.stringify(event); if (!/permission.?denied|denied|blocked|rejected|forbidden|not permitted/i.test(raw)) continue;
    const tool = event.tool_call ?? {}; if (tool.readToolCall) denied.add('read'); if (tool.editToolCall) denied.add('write'); if (tool.shellToolCall) denied.add('shell'); if (tool.mcpToolCall) denied.add('mcp');
  }
  return denied;
}
export function validateApproval(file: string, appRoot: string): void {
  const proof = readJson(file);
  assert.equal(proof.schema, 'dual-model-workbench/native-approval-deny/v1');
  requireTrue(proof.passed, 'Grok approval-deny regression did not pass'); requireTrue(proof.proofGenerated, 'Grok approval proof was not generated');
  assert.equal(path.resolve(proof.appRoot), path.resolve(appRoot), 'Grok live proof belongs to a different compiled application');
  assert.equal(proof.model, FIXED.grok.model); assert.equal(proof.effort, FIXED.grok.effort); assert.equal(proof.paidSegmentsAttempted, 1);
  requireTrue(proof.claims?.nativeApprovalDenyVerified, 'Grok client approval denial missing'); requireTrue(proof.claims?.originalNativeHandlerBypassed, 'Grok original approval handler was not bypassed');
  assert.equal(proof.claims?.nativeSurfaceRemoved, false); assert.equal(proof.claims?.serverSideSpeculativeExecution, 'not_claimed'); assert.equal(proof.claims?.networkNeverOccurred, 'not_claimed');
  requireTrue(proof.preflight?.passed, 'Grok preflight failed'); requireTrue(proof.postflight?.passed, 'Grok postflight failed'); requireEmpty(proof.violations, 'Grok native regression violations');
  requireTrue(proof.cleanup?.safe, 'Grok cleanup unsafe'); requireTrue(proof.cleanup?.rootAbsent, 'Grok guest root remains'); requireTrue(proof.cleanup?.lifecycle?.confirmed, 'Grok tree unconfirmed'); requireEmpty(proof.cleanup?.lifecycle?.remaining, 'Grok processes remain');
  assert.equal(proof.run?.timedOut, false); assert.equal(proof.run?.spawnError, null); assert.equal(proof.run?.terminationWarning, undefined);
  assert.ok(proof.run?.cancelled === true || proof.run?.exitCode === 0, 'Grok cancellation ended abnormally');
  const eventsFile = path.join(path.dirname(file), 'events.jsonl'); const raw = readFileSync(eventsFile);
  assert.equal(sha256(raw), proof.stdoutSha256, 'Grok raw event file changed');
  const lines = raw.toString('utf8').split(/\r?\n/).filter(Boolean); const events = lines.map(line => JSON.parse(line));
  assert.equal(sha256(lines.join('\n') + (lines.length ? '\n' : '')), proof.streamedNormalizedSha256, 'Grok stream/disk hash differs');
  const native = events.filter(event => event.type === 'tool_call' && event.tool_call?.webSearchToolCall);
  assert.equal(native.length, 2); assert.deepEqual(native.map(event => event.subtype), ['started', 'completed']);
  const completed = native.find(event => event.subtype === 'completed')!.tool_call.webSearchToolCall;
  assert.equal(completed.args?.searchTerm, 'OpenAI official documentation'); assert.equal(typeof completed.args?.toolCallId, 'string'); assert.equal(!!completed.result?.success, false);
  assert.ok(completed.args.toolCallId.length && Buffer.byteLength(completed.args.toolCallId) <= 512);
  assert.ok(completed.result && Object.keys(completed.result).length === 1 && ['error', 'rejected', 'permissionDenied'].includes(Object.keys(completed.result)[0]!));
  for (const event of native) {
    const call = event.tool_call.webSearchToolCall;
    assert.equal(call.args?.toolCallId, completed.args.toolCallId); assert.equal(event.call_id, completed.args.toolCallId);
    if (call.toolCallId !== undefined) assert.equal(call.toolCallId, completed.args.toolCallId);
  }
  assert.equal(events.filter(event => event.type === 'interaction_query').length, 0);
  const audit = proof.postflight.approval.nativeApprovalAudit; assert.equal(audit.length, 1); const receipt = audit[0];
  assert.equal(receipt.kind, 'webSearchRequestQuery'); assert.equal(receipt.toolCallIdSha256, sha256(completed.args.toolCallId));
  assert.equal(receipt.markerSha256, sha256('DMW_NATIVE_APPROVAL_DENY_V1')); assert.equal(receipt.rootSha256, proof.preparation.rootSha256);
  assert.equal(receipt.firewallSha256, proof.preparation.artifactHashes.nativeApproval); assert.equal(receipt.indexSha256, proof.preparation.artifactHashes.entry);
  assert.equal(receipt.indexSha256, proof.preparation.capability.entrySha256); assert.equal(receipt.invocationNonce, proof.preparation.artifactBinding.invocationNonce);
  assert.equal(receipt.profileProjectionSha256, proof.preparation.artifactHashes.profileProjection); assert.equal(receipt.homeProjectionSha256, proof.preparation.artifactHashes.homeProjection);
  requireTrue(receipt.constructed, 'typed rejection not constructed'); requireTrue(receipt.returned, 'typed rejection not returned');
  const positive = proof.preparation.historicalPositive; assert.equal(positive.originalOverallPassed, false); requireTrue(positive.webSearchExecuted, 'historical successful search missing');
  assert.equal(sha256(readFileSync(positive.evidence)), positive.evidenceSha256, 'historical positive evidence changed');
  const original = readJson(positive.evidence); assert.equal(original.passed, false); assert.equal(original.model, FIXED.grok.model);
  for (const key of ['cliVersion', 'nodeSha256', 'entrySha256', 'bwrapSha256', 'machineId']) assert.equal(original.preparation.capability[key], proof.preparation.capability[key], `historical Grok CLI differs: ${key}`);
  const control = original.sides.find((side: Json) => side.mode === 'control'); requireTrue(control.postflight.projectionAndArtifactsPassed, 'historical control postflight failed');
  const controlRaw = readFileSync(path.join(path.dirname(positive.evidence), 'control', 'events.jsonl')); assert.equal(sha256(controlRaw), positive.stdoutSha256);
  assert.equal(sha256(controlRaw), control.runEvidence.stdoutSha256); requireTrue(control.runEvidence.observations.find((item: Json) => item.kind === 'web_search' && item.subtype === 'completed')?.success, 'historical WebSearch success absent');
  for (const [relative, digest] of Object.entries(proof.preparation.compiledFiles)) assert.equal(sha256(readFileSync(path.join(appRoot, relative))), digest, `compiled Grok proof file changed: ${relative}`);
}
function validateGrok(approvalEvidence: string, appRoot: string): void {
  const cancellation = readJson(EVIDENCE.grokCancellation); requireTrue(cancellation.passed, 'Grok cancellation evidence failed'); requireTrue(cancellation.result?.cancelled, 'Grok cancellation absent'); requireTrue(cancellation.result?.exitConfirmed, 'Grok cancellation exit unknown'); requireTrue(cancellation.result?.lifecycle?.confirmed, 'Grok tree cleanup unconfirmed'); requireEmpty(cancellation.result?.lifecycle?.remaining, 'Grok child processes remain'); requireTrue(cancellation.guestRootRemoved, 'Grok cancellation guest root remains');
  const host = readJson(EVIDENCE.grokHost); requireTrue(host.passed, 'Grok host evidence failed'); assert.equal(host.results?.length, 2); assert.deepEqual(host.results.map((result: Json) => result.platform).sort(), ['linux', 'windows']); for (const result of host.results) { requireTrue(result.passed, `Grok ${result.platform} host execution failed`); assert.deepEqual(result.effectiveRequest?.env, {}); assert.equal(result.result?.exitCode, 0); }
  const native = readJson(EVIDENCE.grokNative); assert.equal(native.passed, false, 'historical Grok native proof must remain failed'); assert.equal(native.proofGenerated, false); assert.equal(native.model, FIXED.grok.model); assert.equal(native.effort, FIXED.grok.effort); requireTrue(native.cleanup?.lifecycle?.confirmed, 'Grok native cleanup unconfirmed'); requireTrue(native.cleanup?.guestRootAbsent, 'Grok native guest root remains'); assert.match(native.failure, /web_fetch missing\/duplicate started/);
  assert.deepEqual([...deniedNativeKinds(path.join(path.dirname(EVIDENCE.grokNative), 'logs', 'events.jsonl'))].sort(), ['mcp', 'read', 'shell', 'write']);
  validateApproval(approvalEvidence, appRoot);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2)); if (!args) { help(); return; }
  assert.ok(existsSync(args.appRoot), '--app-root does not exist'); assert.ok(existsSync(args.approvalEvidence), '--approval-evidence does not exist'); assert.ok(existsSync(args.claudeEvidence), '--claude-evidence does not exist'); assert.ok(existsSync(args.codexEvidence), '--codex-evidence does not exist'); assert.ok(!existsSync(args.outputDir), '--output-dir must be fresh');
  const relativeOutput = path.relative(WORK_ROOT, args.outputDir); assert.ok(relativeOutput && !relativeOutput.startsWith('..') && !path.isAbsolute(relativeOutput), '--output-dir must be a child of the configured work root');
  const outputParent = path.dirname(args.outputDir); assert.ok(existsSync(outputParent), '--output-dir parent must exist');
  const disk = statfsSync(outputParent); assert.ok(disk.bavail * disk.bsize >= 16 * 1024 * 1024, 'output filesystem lacks free space');
  const configPath = path.join(args.appRoot, 'config', 'workbench.config.json'); const driversPath = path.join(args.appRoot, 'src', 'chat', 'drivers.js'); const processPath = path.join(args.appRoot, 'src', 'adapters', 'process.js'); const cursorPath = path.join(args.appRoot, 'src', 'adapters', 'cursor.js'); const configModulePath = path.join(args.appRoot, 'src', 'config.js');
  for (const file of [configPath, driversPath, processPath, cursorPath, configModulePath]) assert.ok(existsSync(file), `compiled application file missing: ${file}`);
  validateClaude(); validateCodex(); validateGrok(args.approvalEvidence, args.appRoot);
  const [{ loadConfig }, { commandFingerprint, cursorNativeToolExclusionBinding }, { resolveCommand }, { resolveCursorCommand }] = await Promise.all([configModulePath, driversPath, processPath, cursorPath].map(file => import(pathToFileURL(file).href)));
  const { loadChatWindowsJobSupervisorAssets } = await import(pathToFileURL(path.join(args.appRoot, 'src/chat/windows-job-process.js')).href);
  const config = loadConfig(configPath, args.appRoot);
  for (const role of ['claude', 'astra', 'sol', 'grok'] as const) { assert.equal(config.models[role].model, FIXED[role].model, `${role} model is not fixed`); assert.equal(config.models[role].effort, FIXED[role].effort, `${role} effort is not fixed`); }
  const commands = { claude: resolveCommand('claude', { override: config.adapters.claude.command }), astra: resolveCommand('codex', { override: config.adapters.codex.command }), sol: resolveCommand('codex', { override: config.adapters.codex.command }), grok: resolveCursorCommand(config.adapters.cursor.command) };
  for (const role of ['claude', 'astra', 'sol', 'grok'] as const) assert.ok(commands[role], `${role} command cannot be resolved from compiled application config`);
  const supervisor = loadChatWindowsJobSupervisorAssets(); validateClaudeJob(args.claudeEvidence, args.appRoot, supervisor, commandFingerprint(commands.claude, 'claude', FIXED.claude.model, FIXED.claude.effort));
  validateCodexJob(args.codexEvidence, args.appRoot, supervisor, Object.fromEntries((['astra', 'sol'] as const).map(role => [role, commandFingerprint(commands[role], role, FIXED[role].model, FIXED[role].effort)])));
  const codexJob = readJson(args.codexEvidence); assert.equal(path.resolve(commands.astra.file), path.resolve(codexJob.preflight.command.file)); assert.deepEqual(commands.astra.prefixArgs, codexJob.preflight.command.prefixArgs); assert.equal(sha256(readFileSync(commands.astra.file)), codexJob.preflight.cliSha256);
  const claudeJob = readJson(args.claudeEvidence); assert.equal(path.resolve(commands.claude.file), path.resolve(claudeJob.preflight.command.file)); assert.equal(sha256(readFileSync(commands.claude.file)), claudeJob.preflight.cliSha256);
  const claudeEvidence = readJson(EVIDENCE.claudeLive); assert.equal(path.resolve(commands.claude.file), path.resolve(claudeEvidence.cli), 'Claude resolved command path differs from live evidence');
  for (const role of ['astra', 'sol'] as const) { const evidence = readJson(role === 'astra' ? path.resolve(readJson(EVIDENCE.astra).sourceEvidence.original.path) : EVIDENCE.sol); assert.equal(path.resolve(commands[role].file), path.resolve(evidence.cli), `${role} resolved command path differs from evidence`); assert.equal(sha256(readFileSync(commands[role].file)), evidence.cliSha256, `${role} command SHA-256 differs from evidence`); }
  const approval = readJson(args.approvalEvidence); const wslCapability = config.adapters.cursorWriter.capabilities; assert.ok(wslCapability, 'compiled config lacks Grok WSL capability');
  for (const key of ['cliVersion', 'model', 'reportedModel', 'machineId', 'nodeSha256', 'entrySha256', 'bwrapSha256'] as const) assert.equal(wslCapability[key], approval.preparation?.capability?.[key], `Grok WSL capability differs from approval evidence: ${key}`);
  assert.equal(commandFingerprint(commands.grok, 'grok', FIXED.grok.model, FIXED.grok.effort, wslCapability), approval.preparation.fingerprint, 'Grok compiled command fingerprint differs from live approval regression');
  const refs = { ...Object.fromEntries(Object.entries(EVIDENCE).map(([name, file]) => [name, fileRef(file)])), grokNativeApproval: fileRef(args.approvalEvidence), claudeJob: fileRef(args.claudeEvidence), codexJob: fileRef(args.codexEvidence) };
  const tests = (names: readonly string[]) => Object.fromEntries(names.map(name => [name, true]));
  const roles = Object.fromEntries((['claude', 'astra', 'sol', 'grok'] as const).map(role => [role, {
    version: FIXED[role].version,
    fingerprint: commandFingerprint(commands[role], role, FIXED[role].model, FIXED[role].effort, role === 'grok' ? config.adapters.cursorWriter.capabilities : null),
    policy: POLICIES[role], verified: true, isolationVerified: true,
    tests: tests(role === 'astra' || role === 'sol' ? CODEX_TESTS : role === 'grok' ? GROK_TESTS : CLAUDE_TESTS),
    ...(role !== 'grok' ? { runtime: { windowsJobSupervisor: supervisor } } : { nativeToolExclusion: cursorNativeToolExclusionBinding() }),
  }]));
  const output = { schema: 'dual-model-workbench/scoped-model-proofs/v1', generatedAt: new Date().toISOString(), scope: { appRoot: args.appRoot.replaceAll('\\', '/'), node: process.execPath.replaceAll('\\', '/'), globalCapabilitiesModified: false }, roles, evidence: refs, notes: { claudeBinaryBinding: 'fresh compiled transport normal/cancel evidence binds resolved CLI path/SHA, appRoot/fingerprint, supervisor assets and no-model Job probe; earlier taskkill-only evidence is historical', astraLegacyNativeOsAssertions: 'not_applicable_no_environment_selected', astraBasis: 'accepted_no_environment_boundary; adjudication hash plus zero-inference gate empty start/read environments and fail-closed native surface, not legacy OS assertions', grokNativeApprovalBasis: 'historical successful control plus fresh client typed approval rejection; not a strict paired proof, not server tool removal, no claim about server speculative execution; historical failures remain failed' } };
  mkdirSync(args.outputDir, { recursive: false }); const outputFile = path.join(args.outputDir, 'models.json'); const temporary = `${outputFile}.${process.pid}.tmp`; writeFileSync(temporary, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 }); renameSync(temporary, outputFile);
  process.stdout.write(`${JSON.stringify({ outputFile, roles: Object.keys(roles), evidenceCount: Object.keys(refs).length })}\n`);
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main().catch(error => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
