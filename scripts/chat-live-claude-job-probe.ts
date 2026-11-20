/** Explicit normal/cancellation qualification of the compiled Claude Job transport. */
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DriverInput } from '../src/chat/types.js';

const MODEL = 'claude-opus-5-5'; const EFFORT = 'max'; const VERSION = '2.1.292';
const WORK = path.resolve(process.env.DMW_WORK_ROOT ?? 'work');
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const at = () => new Date().toISOString();
function parse(argv: string[]): { appRoot: string; jobProbe: string; executeLive: boolean } {
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write('Usage: tsx scripts/chat-live-claude-job-probe.ts --app-root ABS --job-probe-evidence ABS [--execute-live]\n\nDefault performs no inference. Live mode allows at most two fixed Claude segments: one host read and one forced cancellation while its MCP helper is waiting.\n'); process.exit(0);
  }
  const values = new Map<string, string>(); let executeLive = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--execute-live' && !executeLive) { executeLive = true; continue; }
    assert.ok(['--app-root', '--job-probe-evidence'].includes(flag) && !values.has(flag), 'unsupported or duplicate argument');
    const value = argv[++i]; assert.ok(value && path.isAbsolute(value), `${flag} must be absolute`); values.set(flag, path.resolve(value));
  }
  assert.equal(values.size, 2, 'both --app-root and --job-probe-evidence are required');
  return { appRoot: values.get('--app-root')!, jobProbe: values.get('--job-probe-evidence')!, executeLive };
}
const args = parse(process.argv.slice(2));
const root = path.join(WORK, `chat-live-claude-job-${at().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`);
const reportFile = path.join(root, 'evidence.json');
const report: Record<string, any> = { schema: 'dual-model-workbench/claude-job-live/v1', appRoot: args.appRoot, startedAt: at(),
  model: MODEL, effort: EFFORT, version: VERSION, executeLive: args.executeLive, maxInferenceSegments: 2, paidSegmentsAttempted: 0, passed: false };
function persist(): void { mkdirSync(root, { recursive: true }); const temp = `${reportFile}.${process.pid}.tmp`; writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); renameSync(temp, reportFile); }
function regular(file: string): void { const s = lstatSync(file); assert.ok(s.isFile() && !s.isSymbolicLink(), `expected regular file: ${file}`); }
function verifyJob(processResult: any, cancelled: boolean): void {
  assert.ok(processResult, 'missing process evidence'); assert.equal(processResult.terminationWarning, undefined); assert.equal(processResult.spawnError, null); assert.equal(processResult.timedOut, false);
  const job = processResult.windowsJob; assert.equal(job?.protocol, 1); assert.equal(job?.ready, true); assert.equal(job?.final, true);
  assert.equal(job?.confirmed, true); assert.equal(job?.jobActiveProcesses, 0); assert.equal(job?.rootExited, true); assert.equal(job?.resumed, true);
  assert.equal(processResult.cancelled, cancelled);
  if (cancelled) { assert.equal(job.cancelReceived, true); assert.ok(job.activeBeforeStop >= 2, 'cancel did not observe the Claude and MCP helper processes'); }
}

async function main(): Promise<void> {
  mkdirSync(WORK, { recursive: true });
  const disk = statfsSync(WORK); assert.ok(disk.bavail * disk.bsize >= 256 * 1024 * 1024);
  for (const file of ['src/config.js', 'src/chat/drivers.js', 'src/chat/windows-job-process.js', 'src/chat/mcp-bridge.mjs', 'src/adapters/process.js']) regular(path.join(args.appRoot, file));
  regular(args.jobProbe);
  const load = (file: string) => import(pathToFileURL(path.join(args.appRoot, file)).href);
  const [configModule, drivers, jobs, processModule] = await Promise.all([load('src/config.js'), load('src/chat/drivers.js'), load('src/chat/windows-job-process.js'), load('src/adapters/process.js')]);
  const config = configModule.loadConfig(path.join(args.appRoot, 'config/workbench.config.json'), args.appRoot);
  assert.equal(config.models.claude.model, MODEL); assert.equal(config.models.claude.effort, EFFORT);
  const command = processModule.resolveCommand('claude', { override: config.adapters.claude.command }); assert.ok(command);
  const supervisor = jobs.loadChatWindowsJobSupervisorAssets();
  mkdirSync(root, { mode: 0o700 }); chmodSync(root, 0o700);
  const requestedReceiptRoot = path.join(root, 'job-receipts'); mkdirSync(requestedReceiptRoot, { mode: 0o700 }); chmodSync(requestedReceiptRoot, 0o700);
  const receiptRoot = jobs.validateChatWindowsJobReceiptRoot(requestedReceiptRoot);
  assert.equal(path.resolve(receiptRoot), path.resolve(requestedReceiptRoot), 'compiled Job receipt-root validator changed the probe root');
  const noModel = JSON.parse(readFileSync(args.jobProbe, 'utf8'));
  assert.equal(noModel.schema, 'dual-model-workbench/windows-job-probe/v1'); assert.equal(noModel.passed, true); assert.equal(noModel.realModelCalls, 0);
  assert.equal(path.resolve(noModel.appRoot), args.appRoot); assert.deepEqual(noModel.supervisor, supervisor);
  report.preflight = { passed: true, receiptRoot: { path: receiptRoot, mode: '0700', compiledFactoryValidated: true }, command: { file: command.file, prefixArgs: command.prefixArgs }, cliSha256: sha256(readFileSync(command.file)),
    supervisor, noModelProbe: { path: args.jobProbe, sha256: sha256(readFileSync(args.jobProbe)) }, fingerprint: drivers.commandFingerprint(command, 'claude', MODEL, EFFORT) };
  persist(); if (!args.executeLive) { report.prepared = true; return; }
  const publicFile = path.join(root, 'public.txt'); writeFileSync(publicFile, 'CLAUDE_JOB_PUBLIC_READ_OK', { flag: 'wx' });
  const secret = randomBytes(32).toString('hex'); const chatId = randomUUID();
  let phase: { name: 'normal' | 'cancellation'; invocationId: string; calls: unknown[]; abort: AbortController } | null = null;
  const pending = new Set<ServerResponse>(); const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer((req, res) => {
    const current = phase;
    if (!current || req.url !== `/internal/chat-tools/${chatId}/${current.invocationId}`) { res.writeHead(404); res.end(); return; }
    const token = createHmac('sha256', secret).update(`${chatId}\n${current.invocationId}`).digest('hex');
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end(); return; }
    let text = ''; req.setEncoding('utf8'); req.on('data', chunk => { text += chunk; if (Buffer.byteLength(text) > 16_384) req.destroy(); });
    req.on('end', () => {
      try {
        const body = JSON.parse(text); const expected = current.name === 'normal' ? 'read' : 'wait';
        assert.equal(body.name, expected); assert.equal(current.calls.length, 0); assert.ok(body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments));
        if (expected === 'read') assert.deepEqual(body.arguments, { path: 'public.txt' }); else assert.deepEqual(body.arguments, {});
        current.calls.push({ name: body.name, args: body.arguments });
        if (expected === 'read') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ text: readFileSync(publicFile, 'utf8') })); }
        else {
          pending.add(res); res.on('close', () => pending.delete(res));
          const timer = setTimeout(() => { timers.delete(timer); current.abort.abort(); }, 5000); timers.add(timer);
        }
      } catch { res.writeHead(403); res.end(); }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const bridgeUrl = `http://127.0.0.1:${address.port}`;
  try {
    for (const name of ['normal', 'cancellation'] as const) {
      const invocationId = randomUUID(); const taskId = randomUUID(); const abort = new AbortController();
      const current = { name, invocationId, calls: [] as unknown[], abort }; phase = current;
      const input: DriverInput = { chatId, directory: root, signal: abort.signal,
        // Plain wording: v1 used phrases such as "authorized ... probe", and Opus 5.5 safeguards flagged 2 of its 13 live runs on 11-04/05.
        task: { id: taskId, turnId: 'probe', role: 'claude', goal: 'workbench tool round trip', status: 'running', createdAt: at(), updatedAt: at(), segment: 1, invocationIds: [invocationId], noProgressSegments: 0, mode: 'read' },
        invocation: { id: invocationId, taskId, segment: 1, status: 'running', startedAt: at(), toolCount: 0, promptVersion: 'claude-job-live-v2', inputEstimate: 100, contextWindow: null, contextUsed: null },
        systemPrompt: 'You are helping check that the workbench app can talk to you. Use only the workbench tool given in this session and do not call it more than once.',
        prompt: name === 'normal' ? 'Please read the file public.txt with the workbench read tool (path "public.txt") and reply with its text exactly.' : 'Please call the workbench wait tool once with no arguments and wait for it to finish. Do not call any other tool.',
        tools: name === 'normal' ? [{ name: 'read', description: 'Returns the text of a file in the current folder.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }]
          : [{ name: 'wait', description: 'Waits until the workbench app replies.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
        onText: () => undefined, callTool: async () => { throw new Error('MCP must use the actual HTTP bridge'); },
      };
      let processResult: any; report.paidSegmentsAttempted += 1; persist();
      const result = await drivers.runClaudeHostTools(command, config, { version: VERSION }, input, { bridgeUrl, bridgeToken: secret, receiptRoot, onClaudeProcessResult: (value: unknown) => { processResult = value; report[name] = { process: value, hostCalls: current.calls }; persist(); } });
      report[name] = { result, process: processResult, hostCalls: current.calls }; persist();
      assert.equal(result.exitConfirmed, true); assert.equal(result.finishReason, name === 'normal' ? 'completed' : 'cancelled');
      assert.equal(current.calls.length, 1); verifyJob(processResult, name === 'cancellation'); phase = null;
    }
    report.passed = true;
  } finally {
    phase = null; for (const timer of timers) clearTimeout(timer); for (const response of pending) response.destroy(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); report.completedAt = at(); persist();
  }
}
main().then(() => { persist(); process.stdout.write(`${JSON.stringify({ reportFile, prepared: report.prepared === true, passed: report.passed, paidSegmentsAttempted: report.paidSegmentsAttempted })}\n`); }).catch(error => {
  report.passed = false; report.failure = error instanceof Error ? error.stack ?? error.message : String(error); report.completedAt = at(); persist();
  process.stderr.write(`${JSON.stringify({ reportFile, passed: false, paidSegmentsAttempted: report.paidSegmentsAttempted, error: report.failure })}\n`); process.exitCode = 1;
});
