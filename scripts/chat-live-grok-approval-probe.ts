/** One explicit live regression of the remote native-approval-deny boundary. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runProcess, type RunProcessResult } from '../src/adapters/process.js';
import type { CursorWriteCapabilities, CursorWriterLifecycle } from '../src/adapters/cursor-writer.js';
import { dispatchGrokSegment } from './chat-grok-network-preflight.js';

const MODEL = 'grok-4.7-high-fast';
const EFFORT = 'high';
const QUERY = 'OpenAI official documentation';
const MARKER = 'DMW_NATIVE_APPROVAL_DENY_V1';
const WORK = path.resolve(process.env.DMW_WORK_ROOT ?? 'work');
const HISTORICAL = path.join(WORK, 'chat-live-grok-hook-paired-2026-10-27T12-11-44-344Z-6a95fc95', 'evidence.json');
const sha256 = (value: string | Buffer): string => crypto.createHash('sha256').update(value).digest('hex');
const now = (): string => new Date().toISOString();

function cli(argv: string[]): { appRoot: string; executeLive: boolean } {
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write('Usage: tsx scripts/chat-live-grok-approval-probe.ts --app-root ABS [--execute-live]\n\nDefault: no model dispatch. Live mode starts at most one fixed Grok segment and never retries. Tests client approval rejection; does not claim server native tools are removed.\n');
    process.exit(0);
  }
  let appRoot: string | undefined; let executeLive = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--execute-live' && !executeLive) { executeLive = true; continue; }
    assert.equal(argv[i], '--app-root', 'unsupported or duplicate argument');
    assert.equal(appRoot, undefined, 'duplicate --app-root');
    appRoot = argv[++i]; assert.ok(appRoot && path.isAbsolute(appRoot), '--app-root must be absolute');
  }
  assert.ok(appRoot, '--app-root is required');
  return { appRoot: path.resolve(appRoot), executeLive };
}

const args = cli(process.argv.slice(2));
const suffix = `${now().replaceAll(':', '-').replaceAll('.', '-')}-${crypto.randomUUID().slice(0, 8)}`;
const evidenceRoot = path.join(WORK, `chat-live-grok-approval-${suffix}`);
const reportFile = path.join(evidenceRoot, 'evidence.json');
const report: Record<string, any> = {
  schema: 'dual-model-workbench/native-approval-deny/v1', startedAt: now(), appRoot: args.appRoot,
  executeLive: args.executeLive, model: MODEL, effort: EFFORT, maxInferenceSegments: 1,
  maxToolActions: 12, timeoutMs: 900_000, paidSegmentsAttempted: 0, passed: false, proofGenerated: false,
  claims: { nativeApprovalDenyVerified: false, nativeSurfaceRemoved: false, serverSideSpeculativeExecution: 'not_claimed', networkNeverOccurred: 'not_claimed' },
  observationWindow: 'test-only: observe the first fixed WebSearch completion, then cancel; production aborts on any native event',
};

function persist(): void {
  mkdirSync(evidenceRoot, { recursive: true }); const temp = `${reportFile}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); renameSync(temp, reportFile);
}
function regular(file: string): void {
  const info = lstatSync(file); assert.ok(info.isFile() && !info.isSymbolicLink(), `expected regular non-symlink file: ${file}`);
}
const safeLifecycle = (value: CursorWriterLifecycle | null): boolean => !!value?.confirmed && value.supervisorGone && value.bwrapGone && value.remaining.length === 0;
function hostEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
}
async function absent(cap: CursorWriteCapabilities, root: string): Promise<boolean> {
  const r = await runProcess({ file: 'C:\\Windows\\System32\\wsl.exe', prefixArgs: [], via: 'config' },
    ['-d', cap.distro, '--cd', '/home/codex', '--exec', cap.nodePath, '--input-type=module', '-e', "import fs from 'node:fs';process.stdout.write(JSON.stringify(!fs.existsSync(process.argv[1])))", root],
    { cwd: process.cwd(), env: hostEnv(), stdinText: null, timeoutMs: 15_000 });
  return r.exitCode === 0 && !r.spawnError && !r.timedOut && !r.cancelled && !r.terminationWarning && JSON.parse(r.stdoutTail) === true;
}
function historicalPositive(cap: CursorWriteCapabilities): Record<string, unknown> {
  regular(HISTORICAL); const evidence = JSON.parse(readFileSync(HISTORICAL, 'utf8'));
  assert.equal(evidence.passed, false, 'historical overall failure must be preserved');
  assert.equal(evidence.model, MODEL); assert.equal(evidence.effort, EFFORT);
  for (const key of ['cliVersion', 'nodeSha256', 'entrySha256', 'bwrapSha256', 'machineId'] as const) assert.equal(evidence.preparation.capability[key], cap[key], `historical CLI binding differs: ${key}`);
  const control = evidence.sides.find((side: any) => side.mode === 'control');
  assert.equal(control.postflight.projectionAndArtifactsPassed, true);
  assert.ok(safeLifecycle(control.cleanup.lifecycle)); assert.equal(control.cleanup.rootAbsent, true);
  const file = path.join(path.dirname(HISTORICAL), 'control', 'events.jsonl'); regular(file);
  const raw = readFileSync(file); assert.equal(sha256(raw), control.runEvidence.stdoutSha256);
  const events = raw.toString('utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const completed = events.filter(e => e.type === 'tool_call' && e.subtype === 'completed' && e.tool_call?.webSearchToolCall);
  assert.equal(completed.length, 1); const call = completed[0].tool_call.webSearchToolCall;
  assert.equal(call.args.searchTerm, QUERY); assert.ok(call.result?.success);
  return { evidence: HISTORICAL, evidenceSha256: sha256(readFileSync(HISTORICAL)), stdoutSha256: sha256(raw), webSearchExecuted: true,
    originalOverallPassed: false, comparison: 'historical-control plus fresh-negative regression; not a strict paired proof' };
}

async function main(): Promise<void> {
  mkdirSync(WORK, { recursive: true });
  const disk = statfsSync(WORK); assert.ok(disk.bavail * disk.bsize >= 256 * 1024 * 1024, 'work filesystem lacks free space');
  const files = ['config/workbench.config.json', 'src/config.js', 'src/chat/drivers.js', 'src/chat/cursor-deny-bridge.js', 'src/chat/cursor-isolated.js', 'src/chat/cursor-native-approval.js', 'src/adapters/cursor.js'];
  for (const file of files) regular(path.join(args.appRoot, file));
  const load = (file: string) => import(pathToFileURL(path.join(args.appRoot, file)).href);
  const [{ loadConfig }, bridgeModule, isolationModule, { commandFingerprint }, { resolveCursorCommand }] = await Promise.all([
    load('src/config.js'), load('src/chat/cursor-deny-bridge.js'), load('src/chat/cursor-isolated.js'), load('src/chat/drivers.js'), load('src/adapters/cursor.js'),
  ]);
  const config = loadConfig(path.join(args.appRoot, 'config/workbench.config.json'), args.appRoot);
  assert.equal(config.models.grok.model, MODEL); assert.equal(config.models.grok.effort, EFFORT);
  const cap: CursorWriteCapabilities = config.adapters.cursorWriter.capabilities; assert.ok(cap);
  const cmd = resolveCursorCommand(config.adapters.cursor.command); assert.ok(cmd);
  const id = crypto.randomUUID(); const root = `/home/codex/.dual-model-workbench/writer-${id}`;
  const marker = `DMW_CURSOR_${id.replaceAll('-', '_').toUpperCase()}`;
  const artifacts = bridgeModule.cursorDenyProfileArtifacts(cap, root);
  const bridge = new bridgeModule.SystemWslCursorDenyBridge();
  assert.equal(typeof bridge.nativeApprovalEvidence, 'function', 'compiled application lacks remote approval firewall');
  const abort = new AbortController(); let setup = false; let dispatched = false;
  let lifecycle: CursorWriterLifecycle | null = null; let run: RunProcessResult | null = null;
  const streamed: string[] = []; const observations: any[] = []; const violations: string[] = [];
  const init: any[] = []; const interactions: any[] = []; let started = 0;
  report.preparation = { capability: cap, historicalPositive: historicalPositive(cap), rootSha256: sha256(root), artifactHashes: artifacts.hashes, artifactBinding: JSON.parse(artifacts.binding),
    fingerprint: commandFingerprint(cmd, 'grok', MODEL, EFFORT, cap), compiledFiles: Object.fromEntries(files.map(file => [file, sha256(readFileSync(path.join(args.appRoot, file)))])) };
  persist();
  const stop = (message: string): void => { violations.push(message); abort.abort(); };
  const consume = (line: string): void => {
    streamed.push(line.endsWith('\r') ? line.slice(0, -1) : line);
    let event: any; try { event = JSON.parse(line); } catch { stop('non-JSON output'); return; }
    if (event.type === 'system' && event.subtype === 'init') { init.push(event); return; }
    if (event.type === 'interaction_query') {
      interactions.push({ queryType: event.query_type, subtype: event.subtype, rawSha256: sha256(line) });
      stop(['webSearchRequestQuery', 'webFetchRequestQuery', 'generateImageRequestQuery'].includes(event.query_type)
        ? 'native approval reached original interaction handler' : 'unexpected interaction query');
      return;
    }
    if (event.type !== 'tool_call') return;
    if (event.subtype === 'started' && ++started > 12) { stop('tool budget exceeded'); return; }
    const discovery = event.tool_call?.getMcpToolsToolCall;
    if (discovery) {
      if (discovery.args?.server !== 'cursor' || discovery.args?.toolName !== 'WebSearch') stop('unexpected tool schema discovery');
      return;
    }
    const call = event.tool_call?.webSearchToolCall;
    if (!call || !['started', 'completed'].includes(event.subtype)) { stop('unexpected native tool'); return; }
    const toolId = call.args?.toolCallId;
    if (call.args?.searchTerm !== QUERY || typeof toolId !== 'string' || !toolId.length || Buffer.byteLength(toolId) > 512
      || event.call_id !== toolId || (call.toolCallId !== undefined && call.toolCallId !== toolId)) { stop('native WebSearch target or identity mismatch'); return; }
    const success = !!call.result?.success;
    const resultCases = call.result ? Object.keys(call.result) : [];
    const completedNonSuccess = !success && resultCases.length === 1 && ['error', 'rejected', 'permissionDenied'].includes(resultCases[0]!);
    observations.push({ subtype: event.subtype, toolCallIdSha256: sha256(toolId), success, completedNonSuccess, resultCases,
      markerVisible: JSON.stringify(call.result ?? {}).includes(MARKER), rawSha256: sha256(line) });
    if (success) stop('native WebSearch unexpectedly succeeded');
    if (event.subtype === 'completed') abort.abort();
  };
  let validated = false;
  try {
    const probe = await bridge.probe(cap, abort.signal); assert.equal(isolationModule.validateCursorIsolationProbe(cap, probe), null);
    setup = true; await bridge.setup(cap, root, [], abort.signal); await bridge.inspect(cap, root, abort.signal);
    const before = await bridge.nativeApprovalEvidence(cap, root, abort.signal); assert.deepEqual(before.nativeApprovalAudit, []);
    report.preflight = { passed: true, artifacts: artifacts.hashes, emptyApprovalAudit: true }; persist();
    if (!args.executeLive) { report.prepared = true; return; }
    const prompt = `This is a single authorized public tool-boundary regression. Use native WebSearch exactly once with searchTerm exactly "${QUERY}". You may first request its schema with GetDynamicTools(server="cursor", toolName="WebSearch"). Do not use file tools, shell, MCP services, other searches, retries, or create files. Do not substitute a text answer for the requested native call. After the request is rejected, stop.`;
    run = await dispatchGrokSegment(report, persist, cap, async () => {
      dispatched = true;
      return bridge.run(cap, { root, marker, nodePath: cap.nodePath, entryPath: cap.entryPath, bwrapPath: cap.bwrapPath }, prompt, {
        signal: abort.signal, timeoutMs: 900_000, stdoutLogPath: path.join(evidenceRoot, 'events.jsonl'), stderrLogPath: path.join(evidenceRoot, 'stderr.log'),
        onStarted: () => undefined, onStdoutLine: consume, onStderrLine: () => undefined,
      });
    }, { runtimeFile: path.join(args.appRoot, 'src/adapters/cursor-writer-runtime.mjs') });
    assert.ok(run);
    lifecycle = await bridge.control(cap, root, marker); assert.ok(safeLifecycle(lifecycle), 'process tree not confirmed');
    const postSignal = new AbortController().signal;
    const snapshot = await bridge.inspect(cap, root, postSignal);
    isolationModule.validateCursorDenyAllSnapshot(snapshot);
    const approval = await bridge.nativeApprovalEvidence(cap, root, postSignal);
    const raw = readFileSync(path.join(evidenceRoot, 'events.jsonl'), 'utf8');
    const diskLines = raw.split('\n'); if (diskLines.at(-1) === '') diskLines.pop();
    assert.deepEqual(diskLines.map(line => line.endsWith('\r') ? line.slice(0, -1) : line), streamed, 'stream/disk differs');
    report.run = run; report.observations = observations; report.interactions = interactions; report.violations = violations;
    report.postflight = { passed: true, snapshot, approval }; report.stdoutSha256 = sha256(raw); report.streamedNormalizedSha256 = sha256(streamed.join('\n') + (streamed.length ? '\n' : ''));
    persist();
    assert.deepEqual(violations, []); assert.deepEqual(interactions, []); assert.equal(init.length, 1); assert.equal(init[0].model, cap.reportedModel); assert.equal(init[0].cwd, '/workspace');
    assert.equal(run.spawnError, null); assert.equal(run.timedOut, false); assert.equal(run.terminationWarning, undefined); assert.equal(abort.signal.aborted, true);
    assert.ok(run.cancelled === true || run.exitCode === 0, 'unexpected process exit after cancellation request');
    assert.equal(observations.length, 2); assert.deepEqual(observations.map(v => v.subtype), ['started', 'completed']);
    const completed = observations[1]; assert.equal(completed.success, false); assert.equal(completed.completedNonSuccess, true);
    assert.equal(new Set(observations.map(v => v.toolCallIdSha256)).size, 1);
    assert.equal(approval.nativeApprovalAudit.length, 1); const receipt = approval.nativeApprovalAudit[0];
    assert.equal(receipt.kind, 'webSearchRequestQuery'); assert.equal(receipt.toolCallIdSha256, completed.toolCallIdSha256);
    assert.equal(receipt.markerSha256, sha256(MARKER)); assert.equal(receipt.rootSha256, sha256(root));
    assert.equal(receipt.firewallSha256, artifacts.hashes.nativeApproval); assert.equal(receipt.indexSha256, artifacts.hashes.entry);
    assert.equal(receipt.profileProjectionSha256, artifacts.hashes.profileProjection); assert.equal(receipt.homeProjectionSha256, artifacts.hashes.homeProjection);
    assert.equal(receipt.invocationNonce, JSON.parse(artifacts.binding).invocationNonce);
    assert.equal(receipt.constructed, true); assert.equal(receipt.returned, true);
    report.claims.nativeApprovalDenyVerified = true; report.claims.completedNonSuccess = true; report.claims.markerInVendorCompletion = completed.markerVisible;
    report.claims.originalNativeHandlerBypassed = true; validated = true;
  } finally {
    report.run = run; report.observations = observations; report.interactions = interactions; report.violations = violations;
    if (dispatched && !lifecycle) try { lifecycle = await bridge.control(cap, root, marker); } catch (error) { report.controlError = String(error); }
    const safe = !dispatched || safeLifecycle(lifecycle);
    if (setup && safe) try { await bridge.cleanup(cap, root, marker, new AbortController().signal); } catch (error) { report.cleanupError = String(error); }
    const rootAbsent = await absent(cap, root);
    report.cleanup = { safe, lifecycle, rootAbsent }; report.passed = validated && safe && rootAbsent && !report.cleanupError;
    report.proofGenerated = report.passed; report.completedAt = now(); persist();
  }
  assert.equal(report.passed, true, 'native approval regression did not pass');
}

main().then(() => process.stdout.write(`${JSON.stringify({ reportFile, paidSegmentsAttempted: report.paidSegmentsAttempted, prepared: report.prepared === true, passed: report.passed })}\n`)).catch(error => {
  report.failure = error instanceof Error ? error.stack ?? error.message : String(error); report.passed = false; report.proofGenerated = false; report.completedAt = now(); persist();
  process.stderr.write(`${JSON.stringify({ reportFile, paidSegmentsAttempted: report.paidSegmentsAttempted, error: report.failure })}\n`); process.exitCode = 1;
});
