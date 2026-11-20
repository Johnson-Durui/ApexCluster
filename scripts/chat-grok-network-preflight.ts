/** Zero-inference TLS preflight for the fixed Cursor/Grok upstream. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runProcess, type RunProcessResult } from '../src/adapters/process.js';
import type { CursorWriteCapabilities } from '../src/adapters/cursor-writer.js';

const WSL = 'C:\\Windows\\System32\\wsl.exe';
const HOST = 'api2.cursor.sh';
const PORT = 443;
const NETWORK_TIMEOUT_MS = 6_000;
const PROCESS_TIMEOUT_MS = 10_000;
const TLS_SOURCE = [
  "import tls from 'node:tls';",
  "import fs from 'node:fs';",
  `const host=${JSON.stringify(HOST)},port=${PORT},deadline=${NETWORK_TIMEOUT_MS};`,
  "let done=false,socket,timer;const finish=(value,code)=>{if(done)return;done=true;clearTimeout(timer);process.stdout.write(JSON.stringify(value));process.exitCode=code;socket?.destroy();};",
  "const safe=info=>info.isFile()&&!info.isSymbolicLink()&&info.uid===0&&(info.mode&0o022)===0;let resolvLayout=null;",
  "try{const info=fs.lstatSync('/etc/resolv.conf');if(info.isSymbolicLink()){const target=fs.realpathSync('/etc/resolv.conf');if(target!=='/mnt/wsl/resolv.conf'||!safe(fs.lstatSync(target)))throw 0;resolvLayout='wsl-symlink-v1';}else if(safe(info))resolvLayout='root-regular-v2';else throw 0;}catch{finish({ok:false,error:'unsafe_resolv_layout'},2);}",
  "if(resolvLayout){timer=setTimeout(()=>finish({ok:false,error:'network_timeout',resolvLayout},2),deadline);",
  "socket=tls.connect({host,port,servername:host,rejectUnauthorized:true});",
  "socket.once('secureConnect',()=>finish({ok:socket.authorized===true,authorized:socket.authorized===true,protocol:socket.getProtocol(),resolvLayout},socket.authorized===true?0:2));",
  "socket.once('error',error=>finish({ok:false,error:String(error.code||'tls_error'),resolvLayout},2));}",
].join('');

export interface GrokNetworkPreflight {
  passed: boolean;
  zeroInference: true;
  host: typeof HOST;
  port: typeof PORT;
  distro: string;
  durationMs: number;
  protocol: string | null;
  resolvLayout: 'wsl-symlink-v1' | 'root-regular-v2' | null;
  failure: string | null;
}

type Run = typeof runProcess;

function hostEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP']
    .flatMap(key => env[key] === undefined ? [] : [[key, env[key]!] as const]));
}

export async function runGrokNetworkPreflight(
  capabilities: CursorWriteCapabilities,
  deps: { run?: Run; env?: NodeJS.ProcessEnv; cwd?: string; runtimeFile?: string } = {},
): Promise<GrokNetworkPreflight> {
  assert.ok(capabilities.distro, 'Grok network preflight requires a bound WSL distro');
  assert.ok(path.posix.isAbsolute(capabilities.nodePath), 'Grok network preflight requires a bound WSL Node path');
  const result: RunProcessResult = await (deps.run ?? runProcess)(
    { file: WSL, prefixArgs: [], via: 'config' },
    ['-d', capabilities.distro, '--cd', '/home/codex', '--exec', capabilities.nodePath, '--input-type=module', '-e', TLS_SOURCE],
    { cwd: deps.cwd ?? process.cwd(), env: hostEnv(deps.env ?? process.env), stdinText: null, timeoutMs: PROCESS_TIMEOUT_MS },
  );
  let payload: { ok?: unknown; authorized?: unknown; protocol?: unknown; resolvLayout?: unknown; error?: unknown } | null = null;
  try { payload = JSON.parse(result.stdoutTail); } catch { /* fail closed below */ }
  const resolvLayout = payload?.resolvLayout === 'wsl-symlink-v1' || payload?.resolvLayout === 'root-regular-v2' ? payload.resolvLayout : null;
  let runtimeCompatible = resolvLayout !== 'root-regular-v2';
  if (!runtimeCompatible) {
    try {
      const runtime = readFileSync(deps.runtimeFile ?? path.resolve('src/adapters/cursor-writer-runtime.mjs'), 'utf8');
      runtimeCompatible = runtime.includes("mountOption: '--ro-bind-data'") && runtime.includes("layout: 'root-regular-v2'");
    } catch { runtimeCompatible = false; }
  }
  const processSafe = result.exitCode === 0 && !result.spawnError && !result.timedOut && !result.cancelled && !result.terminationWarning;
  const passed = processSafe && payload?.ok === true && payload.authorized === true && typeof payload.protocol === 'string' && resolvLayout !== null && runtimeCompatible;
  const failure = passed ? null
    : result.terminationWarning ?? result.spawnError ?? (result.timedOut ? 'process_timeout' : null)
      ?? (result.cancelled ? 'cancelled' : null) ?? (!runtimeCompatible ? 'candidate_resolv_layout_unsupported' : null)
      ?? (typeof payload?.error === 'string' ? payload.error : 'invalid_preflight_result');
  return { passed, zeroInference: true, host: HOST, port: PORT, distro: capabilities.distro,
    durationMs: result.durationMs, protocol: typeof payload?.protocol === 'string' ? payload.protocol : null, resolvLayout, failure };
}

export async function dispatchGrokSegment<T>(
  target: Record<string, any>,
  persist: () => void,
  capabilities: CursorWriteCapabilities,
  dispatch: () => Promise<T>,
  deps: { run?: Run; env?: NodeJS.ProcessEnv; cwd?: string; runtimeFile?: string } = {},
): Promise<T> {
  assert.ok(Number.isInteger(target.paidSegmentsAttempted) && target.paidSegmentsAttempted >= 0, 'invalid paid segment counter');
  const result = await runGrokNetworkPreflight(capabilities, deps);
  target.networkPreflight = result;
  target.networkPreflights = [...(Array.isArray(target.networkPreflights) ? target.networkPreflights : []),
    { segment: target.paidSegmentsAttempted + 1, ...result }];
  persist();
  assert.equal(result.passed, true, `Grok network preflight failed: ${result.failure}`);
  target.paidSegmentsAttempted += 1;
  persist();
  return dispatch();
}

function cli(argv: string[]): string {
  assert.deepEqual(argv.slice(0, 1), ['--app-root'], 'Usage: tsx scripts/chat-grok-network-preflight.ts --app-root ABS');
  assert.equal(argv.length, 2, 'Usage: tsx scripts/chat-grok-network-preflight.ts --app-root ABS');
  assert.ok(path.isAbsolute(argv[1]!), '--app-root must be absolute');
  return path.resolve(argv[1]!);
}

async function main(): Promise<void> {
  const appRoot = cli(process.argv.slice(2));
  const { loadConfig } = await import(pathToFileURL(path.join(appRoot, 'src/config.js')).href);
  const config = loadConfig(path.join(appRoot, 'config/workbench.config.json'), appRoot);
  const capabilities: CursorWriteCapabilities | null = config.adapters.cursorWriter.capabilities;
  assert.ok(capabilities, 'verified Cursor WSL capabilities missing');
  const result = await runGrokNetworkPreflight(capabilities, { runtimeFile: path.join(appRoot, 'src/adapters/cursor-writer-runtime.mjs') });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.passed) process.exitCode = 1;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
