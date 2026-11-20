/** Explicit qualification of the compiled Astra/Sol Job transport; public fixture only. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DriverInput } from '../src/chat/types.js';
import { appendBoundedCodexObservation, installCodexToolCompletionObserver, type CodexToolCompletionObservation } from './chat-codex-job-observer.js';

const WORK = path.resolve(process.env.DMW_WORK_ROOT ?? 'work');
const DEFAULT_VERSION = 'codex-cli 0.164.0-alpha.11.1';
const MODELS = { astra: 'gpt-6.2-astra', sol: 'gpt-6.2-sol' } as const;
const PUBLIC = 'CODEX_JOB_PUBLIC_READ_OK';
const at = () => new Date().toISOString();
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
function parse(argv: string[]): { appRoot: string; jobProbe: string; codexVersion: string; qualificationId: string; executeLive: boolean } {
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write('Usage: tsx scripts/chat-live-codex-job-probe.ts --app-root ABS --job-probe-evidence ABS --qualification-id UUID [--codex-version STRING] [--execute-live]\nDefault performs no inference. The default version remains codex-cli 0.164.0-alpha.11.1. Live mode allows four fixed segments: public read and pending-tool cancellation for Astra and Sol.\n'); process.exit(0);
  }
  const values = new Map<string, string>(); let executeLive = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--execute-live' && !executeLive) { executeLive = true; continue; }
    assert.ok(['--app-root', '--job-probe-evidence', '--codex-version', '--qualification-id'].includes(flag) && !values.has(flag), 'unsupported or duplicate argument');
    const value = argv[++i]; assert.ok(value, `${flag} requires a value`);
    if (flag === '--codex-version') assert.ok(value.trim() === value && value.length > 0, '--codex-version must be a non-empty trimmed string');
    else if (flag === '--qualification-id') assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, '--qualification-id must be a UUID v4');
    else assert.ok(path.isAbsolute(value), `${flag} must be absolute`);
    values.set(flag, flag === '--app-root' || flag === '--job-probe-evidence' ? path.resolve(value) : value);
  }
  assert.ok(values.has('--app-root') && values.has('--job-probe-evidence') && values.has('--qualification-id'), 'both absolute paths and --qualification-id UUID are required');
  return { appRoot: values.get('--app-root')!, jobProbe: values.get('--job-probe-evidence')!, codexVersion: values.get('--codex-version') ?? DEFAULT_VERSION, qualificationId: values.get('--qualification-id')!, executeLive };
}
const args = parse(process.argv.slice(2));
const root = path.join(WORK, `chat-live-codex-job-${at().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`);
const reportFile = path.join(root, 'evidence.json');
const report: Record<string, any> = { schema: 'dual-model-workbench/codex-job-live/v1', appRoot: args.appRoot, startedAt: at(),
  probeRevision: 3, finalResponseContract: 'copy actual host result; expected marker absent from prompt',
  qualificationId: args.qualificationId, models: MODELS, effort: 'max', version: args.codexVersion, executeLive: args.executeLive, maxInferenceSegments: 4, paidSegmentsAttempted: 0, roles: {}, passed: false };
function persist(): void { mkdirSync(root, { recursive: true }); const tmp = `${reportFile}.${process.pid}.tmp`; writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); renameSync(tmp, reportFile); }
function regular(file: string): void { const s = lstatSync(file); assert.ok(s.isFile() && !s.isSymbolicLink(), `expected regular file: ${file}`); }
function verifyJobs(evidence: any[], cancelled: boolean): void {
  assert.equal(evidence.length, 3, 'version, discovery and isolated process evidence required');
  assert.deepEqual(evidence.map(e => e.phase), ['version', 'discovery', 'isolated']);
  for (const job of evidence) {
    assert.equal(job.confirmed, true); assert.equal(job.rootExited, true); assert.equal(job.activeProcesses, 0); assert.ok(Number.isInteger(job.targetPid) && job.targetPid > 0);
  }
  if (cancelled) { const job = evidence[2]; assert.equal(job.cancelReceived, true); assert.ok(job.activeBeforeStop >= 1, 'no active app-server observed at cancellation'); }
}
async function main(): Promise<void> {
  mkdirSync(WORK, { recursive: true });
  const disk = statfsSync(WORK); assert.ok(disk.bavail * disk.bsize >= 256 * 1024 * 1024);
  const files = ['src/config.js', 'src/chat/drivers.js', 'src/chat/codex-policy.js', 'src/chat/types.js', 'src/chat/windows-job-process.js', 'src/chat/windows-job-app-server.js', 'src/adapters/process.js'];
  for (const file of files) regular(path.join(args.appRoot, file)); regular(args.jobProbe);
  const load = (file: string) => import(pathToFileURL(path.join(args.appRoot, file)).href);
  const [configModule, drivers, jobs, processModule] = await Promise.all([load('src/config.js'), load('src/chat/drivers.js'), load('src/chat/windows-job-process.js'), load('src/adapters/process.js')]);
  const config = configModule.loadConfig(path.join(args.appRoot, 'config/workbench.config.json'), args.appRoot);
  const command = processModule.resolveCommand('codex', { override: config.adapters.codex.command }); assert.ok(command);
  const supervisor = jobs.loadChatWindowsJobSupervisorAssets();
  mkdirSync(root, { mode: 0o700 }); chmodSync(root, 0o700);
  const requestedReceiptRoot = path.join(root, 'job-receipts'); mkdirSync(requestedReceiptRoot, { mode: 0o700 }); chmodSync(requestedReceiptRoot, 0o700);
  const receiptRoot = jobs.validateChatWindowsJobReceiptRoot(requestedReceiptRoot);
  assert.equal(path.resolve(receiptRoot), path.resolve(requestedReceiptRoot), 'compiled Job receipt-root validator changed the probe root');
  const noModel = JSON.parse(readFileSync(args.jobProbe, 'utf8'));
  assert.equal(noModel.schema, 'dual-model-workbench/windows-job-probe/v1'); assert.equal(noModel.passed, true); assert.equal(noModel.realModelCalls, 0);
  assert.equal(path.resolve(noModel.appRoot), args.appRoot); assert.deepEqual(noModel.supervisor, supervisor);
  const fingerprints = Object.fromEntries((['astra', 'sol'] as const).map(role => {
    assert.equal(config.models[role].model, MODELS[role]); assert.equal(config.models[role].effort, 'max');
    return [role, drivers.commandFingerprint(command, role, MODELS[role], 'max')];
  }));
  assert.equal(typeof drivers.runCodexHostTools, 'function');
  assert.equal(typeof drivers.CodexAppServer, 'function');
  let activeObservations: CodexToolCompletionObservation[] | null = null;
  const observerErrors: string[] = [];
  const observerError = (code: string) => { if (!observerErrors.includes(code)) observerErrors.push(code); };
  const restoreObserver = installCodexToolCompletionObserver(drivers.CodexAppServer, PUBLIC, observation => {
    if (activeObservations) appendBoundedCodexObservation(activeObservations, observation, observerError);
  }, observerError);
  report.observer = { installed: true, contract: 'post-consume pass-through; bounded item/completed dynamicToolCall summary only', claimBoundary: 'proves CLI item completion and returned content only; does not prove model context, understanding or compliance', errors: observerErrors };
  try {
    report.preflight = { passed: true, receiptRoot: { path: receiptRoot, mode: '0700', compiledFactoryValidated: true }, command: { file: command.file, prefixArgs: command.prefixArgs }, cliSha256: sha256(readFileSync(command.file)), supervisor,
      noModelProbe: { path: args.jobProbe, sha256: sha256(readFileSync(args.jobProbe)) }, fingerprints,
      compiledFiles: Object.fromEntries(files.map(file => [file, sha256(readFileSync(path.join(args.appRoot, file)))])) };
    persist(); if (!args.executeLive) { report.prepared = true; return; }
    for (const role of ['astra', 'sol'] as const) {
      const roleReport: Record<string, any> = {}; report.roles[role] = roleReport;
      for (const name of ['normal', 'cancellation'] as const) {
        const directory = path.join(root, `${role}-${name}`); mkdirSync(directory); writeFileSync(path.join(directory, 'public.txt'), PUBLIC, { flag: 'wx' });
        const invocationId = randomUUID(), taskId = randomUUID(), abort = new AbortController();
        const side: Record<string, any> = { invocationId, taskId, startedAt: at(), hostCalls: [], jobs: [], dynamicToolCompletions: [] }; roleReport[name] = side; activeObservations = side.dynamicToolCompletions;
        let timer: ReturnType<typeof setTimeout> | undefined; let releaseWait: (() => void) | undefined;
        const input: DriverInput = { chatId: randomUUID(), directory, signal: abort.signal,
        task: { id: taskId, turnId: 'probe', role, goal: 'authorized public transport qualification', status: 'running', createdAt: at(), updatedAt: at(), segment: 1, invocationIds: [invocationId], noProgressSegments: 0, mode: 'read' },
        invocation: { id: invocationId, taskId, segment: 1, status: 'running', startedAt: at(), toolCount: 0, promptVersion: 'codex-job-live-v2-exact-result', inputEstimate: 100, contextWindow: null, contextUsed: null },
        systemPrompt: 'Use only the supplied host tool for this public qualification. No other tools, filesystem access or retries.',
        prompt: name === 'normal' ? 'Call the supplied dynamic host tool probe_read exactly once with path public.txt and wait for its result. Your final assistant message must copy the actual returned text exactly, with no summary, preface or markdown. Do not guess or invent the result. If the tool returns an error, report that actual error. Then stop.' : 'Call the supplied dynamic host tool probe_wait exactly once with empty arguments and wait for its response. Use no other tool.',
        tools: name === 'normal' ? [{ name: 'probe_read', description: 'Read public probe text.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }]
          : [{ name: 'probe_wait', description: 'Wait for the host response during an authorized cancellation qualification.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
        onText: () => undefined,
        callTool: async (tool, value) => {
          assert.equal(side.hostCalls.length, 0); assert.equal(tool, name === 'normal' ? 'probe_read' : 'probe_wait');
          assert.deepEqual(value, name === 'normal' ? { path: 'public.txt' } : {}); side.hostCalls.push({ name: tool, args: value }); persist();
          if (name === 'normal') {
            const text = readFileSync(path.join(directory, 'public.txt'), 'utf8'); assert.equal(text, PUBLIC);
            side.hostCalls[0].responseSha256 = sha256(Buffer.from(text)); side.hostCalls[0].responseBytes = Buffer.byteLength(text); persist();
            return { text };
          }
          return new Promise(resolve => {
            releaseWait = () => resolve({ text: 'cancelled' });
            timer = setTimeout(() => abort.abort(), 5000);
          });
        },
      };
        report.paidSegmentsAttempted++; persist();
        try {
          side.result = await drivers.runCodexHostTools(command, config, { version: args.codexVersion }, input, role, { receiptRoot, onCodexJobEvidence: (evidence: unknown) => { side.jobs.push(evidence); persist(); } });
          assert.equal(side.result.exitConfirmed, true); assert.equal(side.result.finishReason, name === 'normal' ? 'completed' : 'cancelled');
          if (name === 'normal') {
            assert.deepEqual(observerErrors, [], 'Codex completion observer failed'); assert.equal(side.dynamicToolCompletions.length, 1, 'exactly one CLI dynamic-tool completion required');
            const observed = side.dynamicToolCompletions[0]; assert.equal(observed.tool, 'probe_read'); assert.equal(observed.statusIsCompleted, true); assert.equal(observed.success, true); assert.equal(observed.schemaValid, true);
            assert.equal(observed.equalsExpectedPublicText, true); assert.equal(observed.responseTextSha256, sha256(PUBLIC)); assert.equal(observed.responseBytes, 24); assert.match(observed.callIdSha256, /^[0-9a-f]{64}$/);
            side.cliToolCompletionVerified = true;
          }
          verifyJobs(side.jobs, name === 'cancellation'); side.transportVerified = true;
          assert.equal(side.hostCalls.length, 1); if (name === 'normal') assert.ok(side.result.text.includes(PUBLIC), 'public host result missing from model output');
          side.passed = true;
        } finally { activeObservations = null; if (timer) clearTimeout(timer); releaseWait?.(); side.endedAt = at(); persist(); }
      }
    }
    assert.deepEqual(observerErrors, [], 'Codex completion observer failed'); report.passed = true;
  } finally {
    activeObservations = null;
    try { restoreObserver(); report.observer.restored = true; }
    catch (error) { report.observer.restored = false; observerError('DMW_CODEX_TOOL_OBSERVER_RESTORE'); persist(); throw error; }
    persist();
  }
}
main().then(() => { report.completedAt = at(); persist(); process.stdout.write(`${JSON.stringify({ reportFile, prepared: report.prepared === true, passed: report.passed, paidSegmentsAttempted: report.paidSegmentsAttempted })}\n`); }).catch(error => {
  report.passed = false; report.failure = error instanceof Error ? error.stack ?? error.message : String(error); report.completedAt = at(); persist();
  process.stderr.write(`${JSON.stringify({ reportFile, passed: false, paidSegmentsAttempted: report.paidSegmentsAttempted, error: report.failure })}\n`); process.exitCode = 1;
});
