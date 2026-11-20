/** Refresh only Astra/Sol scoped proofs from one fresh revision-3 live Job qualification. No inference. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CODEX_TESTS, validateCodexJobEvidence } from './chat-provision-model-proofs.js';

const WORK_ROOT = path.resolve(process.env.DMW_WORK_ROOT ?? 'work');
const ACTIVE_PROOF = path.resolve(process.env.DMW_MODEL_PROOF ?? path.join('data', 'capabilities', 'models.json'));
const MODELS = { astra: 'gpt-6.2-astra', sol: 'gpt-6.2-sol' } as const;
const COMPILED_FILES = ['src/config.js', 'src/chat/drivers.js', 'src/chat/codex-policy.js', 'src/chat/types.js', 'src/chat/windows-job-process.js', 'src/chat/windows-job-app-server.js', 'src/adapters/process.js'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Json = Record<string, any>;
type Role = keyof typeof MODELS;
export type BindingExpectations = { appRoot: string; version: string; command: { file: string; prefixArgs: string[] }; cliSha256: string; supervisor: Json; fingerprints: Record<Role, string>; compiledFiles: Record<string, string> };
const validatedJobs = new WeakMap<Json, { expected: BindingExpectations; evidenceSha256: string }>();
const validatedBases = new WeakMap<Json, Json>();
const sha256 = (value: Buffer | string): string => crypto.createHash('sha256').update(value).digest('hex');
const tests = () => Object.fromEntries(CODEX_TESTS.map(name => [name, true]));
function requiredAbsolute(value: string | undefined, flag: string): string { assert.ok(value && path.isAbsolute(value), `${flag} must be an absolute path`); return path.resolve(value); }
function parseArgs(argv: string[]): { appRoot: string; baseProof: string; codexEvidence: string; codexVersion: string; qualificationId: string; outputDir: string } | null {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0]!)) return null;
  const values = new Map<string, string>(); const flags = ['--app-root', '--base-proof', '--codex-evidence', '--codex-version', '--qualification-id', '--output-dir'];
  for (let index = 0; index < argv.length; index += 2) { const flag = argv[index]; const value = argv[index + 1]; assert.ok(flag && flags.includes(flag), `unsupported argument: ${flag ?? '<missing>'}`); assert.ok(value && !value.startsWith('--') && !values.has(flag), `${flag} requires one value and may appear once`); values.set(flag, value); }
  assert.equal(values.size, flags.length, `required: ${flags.join(' ')}`);
  const version = values.get('--codex-version')!; assert.ok(version.trim() === version && version.length > 0, '--codex-version must be a non-empty trimmed string');
  const qualificationId = values.get('--qualification-id')!; assert.match(qualificationId, UUID_V4, '--qualification-id must be a UUID v4');
  return { appRoot: requiredAbsolute(values.get('--app-root'), '--app-root'), baseProof: requiredAbsolute(values.get('--base-proof'), '--base-proof'), codexEvidence: requiredAbsolute(values.get('--codex-evidence'), '--codex-evidence'), codexVersion: version, qualificationId, outputDir: requiredAbsolute(values.get('--output-dir'), '--output-dir') };
}
function time(value: unknown, label: string): number { if (typeof value !== 'string') throw new Error(`${label} missing`); const parsed = Date.parse(value); assert.ok(Number.isFinite(parsed), `${label} invalid`); return parsed; }
function workChild(target: string, label: string): string { const resolved = path.resolve(target); const relative = path.relative(WORK_ROOT, resolved); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `${label} must stay below the configured work root`); return resolved; }
export function validateFreshOutputDirectory(outputDir: string, workRoot = WORK_ROOT): void {
  const root = path.resolve(workRoot); const leaf = path.resolve(outputDir); assert.ok(existsSync(root) && !lstatSync(root).isSymbolicLink(), 'work root must exist and may not be a link');
  assert.ok(!existsSync(leaf), '--output-dir must be fresh'); const parent = path.dirname(leaf); assert.ok(existsSync(parent), '--output-dir parent must already exist');
  const realRoot = realpathSync.native(root); const realParent = realpathSync.native(parent); const relativeReal = path.relative(realRoot, realParent); assert.ok(!relativeReal.startsWith('..') && !path.isAbsolute(relativeReal), '--output-dir parent resolves outside the real work root');
  const relativeParent = path.relative(root, parent); assert.ok(!relativeParent.startsWith('..') && !path.isAbsolute(relativeParent), '--output-dir parent must be below the work root');
  let cursor = root; for (const part of relativeParent.split(path.sep).filter(Boolean)) { cursor = path.join(cursor, part); assert.ok(!lstatSync(cursor).isSymbolicLink(), `output parent contains a link or junction: ${cursor}`); }
}

export function validateCodexRefreshEvidence(evidence: Buffer, expected: BindingExpectations, qualificationId: string, now = Date.now()): Json {
  assert.match(qualificationId, UUID_V4, 'expected qualification id must be UUID v4');
  const proof = validateCodexJobEvidence(evidence, expected.appRoot, expected.supervisor, expected.fingerprints, expected.version, MODELS);
  assert.equal(proof.probeRevision, 3, 'Codex refresh requires revision-3 live evidence'); assert.equal(proof.qualificationId, qualificationId, 'Codex qualification nonce differs');
  assert.deepEqual(proof.models, MODELS); assert.equal(path.resolve(proof.preflight.command?.file), path.resolve(expected.command.file)); assert.deepEqual(proof.preflight.command?.prefixArgs, expected.command.prefixArgs);
  assert.equal(proof.preflight.cliSha256, expected.cliSha256, 'Codex CLI hash differs from fresh evidence'); assert.deepEqual(proof.preflight.compiledFiles, expected.compiledFiles, 'compiled module hashes drifted');
  const started = time(proof.startedAt, 'qualification startedAt'); const completed = time(proof.completedAt, 'qualification completedAt');
  assert.ok(started <= completed && completed <= now, 'qualification time window is invalid or in the future'); assert.ok(completed - started <= DAY_MS, 'qualification ran longer than 24 hours'); assert.ok(now - completed <= DAY_MS, 'qualification is older than 24 hours');
  assert.deepEqual(Object.keys(proof.roles ?? {}).sort(), ['astra', 'sol']);
  const invocationIds = new Set<string>(); const taskIds = new Set<string>(); const normalCallIds = new Set<string>();
  for (const role of ['astra', 'sol'] as const) for (const name of ['normal', 'cancellation'] as const) {
    const side = proof.roles[role][name]; assert.match(side.invocationId ?? '', UUID_V4, `${role} ${name} invocation id invalid`); assert.match(side.taskId ?? '', UUID_V4, `${role} ${name} task id invalid`);
    invocationIds.add(side.invocationId); taskIds.add(side.taskId);
    const sideStarted = time(side.startedAt, `${role} ${name} startedAt`); const sideEnded = time(side.endedAt, `${role} ${name} endedAt`); assert.ok(started <= sideStarted && sideStarted <= sideEnded && sideEnded <= completed, `${role} ${name} lies outside qualification window`);
    for (const job of side.jobs) assert.ok(Number.isInteger(job.targetPid) && job.targetPid > 0, `${role} ${name} Job target PID invalid`);
    if (name === 'normal') normalCallIds.add(side.dynamicToolCompletions[0].callIdSha256);
  }
  assert.equal(invocationIds.size, 4, 'qualification reused an invocation id'); assert.equal(taskIds.size, 4, 'qualification reused a task id'); assert.equal(normalCallIds.size, 2, 'normal segments reused a dynamic tool call id');
  validatedJobs.set(proof, { expected: structuredClone(expected), evidenceSha256: sha256(evidence) }); return proof;
}

export function validateBaseProofEvidence(baseBytes: Buffer, activeBytes: Buffer, appRoot: string, currentNode: string): Json {
  assert.equal(sha256(baseBytes), sha256(activeBytes), 'base proof is not byte-identical to the current active proof');
  const base = JSON.parse(baseBytes.toString('utf8')) as Json; assert.equal(base.schema, 'dual-model-workbench/scoped-model-proofs/v1');
  assert.equal(path.resolve(base.scope?.appRoot), path.resolve(appRoot), 'base proof app scope differs');
  assert.equal(typeof base.scope?.node, 'string'); assert.ok(existsSync(base.scope.node), 'base proof Node executable is missing'); assert.equal(sha256(readFileSync(base.scope.node)), sha256(readFileSync(currentNode)), 'base proof Node bytes differ from the current Node');
  for (const [name, reference] of Object.entries(base.evidence ?? {})) { assert.equal(typeof (reference as Json).path, 'string', `${name} evidence path missing`); assert.match((reference as Json).sha256 ?? '', /^[a-f0-9]{64}$/, `${name} evidence hash invalid`); assert.equal(sha256(readFileSync((reference as Json).path)), (reference as Json).sha256, `${name} evidence bytes changed`); }
  for (const role of ['claude', 'astra', 'sol', 'grok']) assert.ok(base.roles?.[role], `base proof role missing: ${role}`);
  validatedBases.set(base, structuredClone(base)); return base;
}

export function buildCodexRefreshCandidate(base: Json, proof: Json, evidencePath: string): Json {
  const baseSnapshot = validatedBases.get(base); assert.ok(baseSnapshot, 'base proof did not pass the complete base validator'); const validation = validatedJobs.get(proof); assert.ok(validation, 'Codex evidence did not pass the complete live validator'); const { expected, evidenceSha256 } = validation;
  assert.ok(path.isAbsolute(evidencePath)); assert.equal(sha256(readFileSync(evidencePath)), evidenceSha256, 'Codex evidence path no longer matches the validated snapshot'); const privateBase = structuredClone(baseSnapshot); const roles = { ...privateBase.roles };
  for (const role of ['astra', 'sol'] as const) roles[role] = { ...privateBase.roles[role], version: expected.version, fingerprint: expected.fingerprints[role], tests: tests() };
  return { ...privateBase, generatedAt: new Date().toISOString(), roles, evidence: { ...privateBase.evidence, codexJobRefresh: { path: evidencePath.replaceAll('\\', '/'), sha256: evidenceSha256 } }, notes: { ...(privateBase.notes ?? {}), codexRefresh: 'Astra/Sol only; revision-3 compiled live normal/cancel qualification; Claude/Grok role proofs preserved byte-for-byte.' } };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2)); if (!args) { process.stdout.write('Usage: tsx scripts/chat-refresh-codex-proofs.ts --app-root ABS --base-proof ABS --codex-evidence ABS --codex-version STRING --qualification-id UUID --output-dir ABS\n'); return; }
  for (const file of [args.appRoot, args.baseProof, args.codexEvidence, ACTIVE_PROOF]) assert.ok(existsSync(file), `required path does not exist: ${file}`); workChild(args.outputDir, '--output-dir'); validateFreshOutputDirectory(args.outputDir);
  const disk = statfsSync(path.dirname(args.outputDir)); assert.ok(disk.bavail * disk.bsize >= 16 * 1024 * 1024, 'output filesystem lacks free space');
  const paths = { config: path.join(args.appRoot, 'config/workbench.config.json'), configModule: path.join(args.appRoot, 'src/config.js'), drivers: path.join(args.appRoot, 'src/chat/drivers.js'), process: path.join(args.appRoot, 'src/adapters/process.js'), cursor: path.join(args.appRoot, 'src/adapters/cursor.js'), jobs: path.join(args.appRoot, 'src/chat/windows-job-process.js'), packageNode: path.resolve(args.appRoot, '..', 'runtime', 'node.exe') };
  for (const file of [...Object.values(paths), ...COMPILED_FILES.map(relative => path.join(args.appRoot, relative))]) assert.ok(existsSync(file), `compiled application file missing: ${file}`);
  const [{ loadConfig }, drivers, { resolveCommand }, { resolveCursorCommand }, { loadChatWindowsJobSupervisorAssets }] = await Promise.all([paths.configModule, paths.drivers, paths.process, paths.cursor, paths.jobs].map(file => import(pathToFileURL(file).href)));
  const config = loadConfig(paths.config, args.appRoot); const supervisor = loadChatWindowsJobSupervisorAssets(); for (const role of ['astra', 'sol'] as const) { assert.equal(config.models[role].model, MODELS[role]); assert.equal(config.models[role].effort, 'max'); }
  const commands = { claude: resolveCommand('claude', { override: config.adapters.claude.command }), astra: resolveCommand('codex', { override: config.adapters.codex.command }), sol: resolveCommand('codex', { override: config.adapters.codex.command }), grok: resolveCursorCommand(config.adapters.cursor.command) }; for (const [role, command] of Object.entries(commands)) assert.ok(command, `${role} command cannot be resolved`);
  const fingerprints = Object.fromEntries((['astra', 'sol'] as const).map(role => [role, drivers.commandFingerprint(commands[role], role, MODELS[role], 'max', null, supervisor)])) as Record<Role, string>;
  const expected: BindingExpectations = { appRoot: args.appRoot, version: args.codexVersion, command: { file: commands.astra.file, prefixArgs: commands.astra.prefixArgs }, cliSha256: sha256(readFileSync(commands.astra.file)), supervisor, fingerprints, compiledFiles: Object.fromEntries(COMPILED_FILES.map(relative => [relative, sha256(readFileSync(path.join(args.appRoot, relative)))])) };
  const evidenceBytes = readFileSync(args.codexEvidence); const proof = validateCodexRefreshEvidence(evidenceBytes, expected, args.qualificationId); const evidenceSha256 = sha256(evidenceBytes);
  const base = validateBaseProofEvidence(readFileSync(args.baseProof), readFileSync(ACTIVE_PROOF), args.appRoot, paths.packageNode);
  assert.equal(drivers.commandFingerprint(commands.claude, 'claude', config.models.claude.model, config.models.claude.effort), base.roles.claude.fingerprint, 'Claude current fingerprint differs from base proof'); assert.equal(drivers.commandFingerprint(commands.grok, 'grok', config.models.grok.model, config.models.grok.effort, config.adapters.cursorWriter.capabilities), base.roles.grok.fingerprint, 'Grok current fingerprint differs from base proof');
  const candidate = buildCodexRefreshCandidate(base, proof, args.codexEvidence); assert.deepEqual(candidate.roles.claude, base.roles.claude); assert.deepEqual(candidate.roles.grok, base.roles.grok);
  const checkRoot = mkdtempSync(path.join(WORK_ROOT, 'codex-proof-refresh-check-')); workChild(checkRoot, 'capability check directory');
  try { const checkFile = path.join(checkRoot, 'models.json'); writeFileSync(checkFile, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600 }); const capabilities = drivers.createChatDrivers(config, { capabilitiesFile: checkFile, bridgeUrl: 'http://127.0.0.1:1', bridgeToken: 'capability-read-only', codexJobAssets: supervisor }); for (const role of ['claude', 'astra', 'sol', 'grok']) assert.equal(capabilities[role].capability.available, true, `${role} is unavailable: ${capabilities[role].capability.reason ?? 'unknown'}`); }
  finally { const owned = workChild(checkRoot, 'capability check directory'); assert.ok(path.basename(owned).startsWith('codex-proof-refresh-check-')); rmSync(owned, { recursive: true, force: true }); }
  let outputCreated = false; const outputFile = path.join(args.outputDir, 'models.json'); const temporary = `${outputFile}.${process.pid}.tmp`;
  try { mkdirSync(args.outputDir, { recursive: false }); outputCreated = true; writeFileSync(temporary, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600 }); renameSync(temporary, outputFile); }
  finally { if (existsSync(temporary)) { const ownedTemporary = workChild(temporary, 'temporary proof'); assert.equal(ownedTemporary, path.resolve(`${outputFile}.${process.pid}.tmp`)); assert.equal(path.dirname(ownedTemporary), path.resolve(args.outputDir)); unlinkSync(ownedTemporary); } if (outputCreated && !existsSync(outputFile) && readdirSync(args.outputDir).length === 0) { workChild(args.outputDir, '--output-dir'); rmSync(args.outputDir); } }
  process.stdout.write(`${JSON.stringify({ outputFile, codexVersion: args.codexVersion, qualificationId: args.qualificationId, evidenceSha256, roles: ['astra', 'sol'] })}\n`);
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main().catch(error => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
