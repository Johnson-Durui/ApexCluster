/**
 * No-model, disposable capability probe. It never generates an enabling proof.
 * Run: npx tsx src/chat/capability-probe.ts
 * A supervisor must independently inspect results and run the remaining negative tests.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../config.js';
import { resolveCommand, runProcess, runSimple, scrubEnv, type ResolvedCommand } from '../adapters/process.js';
import { resolveCursorCommand } from '../adapters/cursor.js';

async function version(cmd: ResolvedCommand | null, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (!cmd || cmd.via === 'cmd-fallback') return null;
  const r = await runSimple(cmd, ['--version'], { env, timeoutMs: 10000 });
  return r.exitCode === 0 && !r.spawnError && !r.terminationWarning ? r.stdoutTail.trim() : null;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const codex = resolveCommand('codex', { override: config.adapters.codex.command });
  const claude = resolveCommand('claude', { override: config.adapters.claude.command });
  const cursor = resolveCursorCommand(config.adapters.cursor.command);
  const clean = scrubEnv(process.env, [...config.adapters.claude.scrubEnvKeys, ...config.adapters.codex.scrubEnvKeys, ...config.adapters.cursor.scrubEnvKeys]).env;
  const root = mkdtempSync(path.join(os.tmpdir(), 'workbench-capabilities-'));
  const workspace = path.join(root, 'allowed');
  const outside = path.join(root, 'outside');
  mkdirSync(workspace); mkdirSync(outside);
  const source = path.join(workspace, 'readable.txt');
  const marker = path.join(outside, 'private.txt');
  writeFileSync(source, 'ALLOWED'); writeFileSync(marker, 'PRIVATE');
  const versions = { claude: await version(claude, clean), codex: await version(codex, clean), cursor: await version(cursor, clean) };
  const schema = { dynamicTools: null as boolean | null, restrictedRead: null as boolean | null };
  const bounded = { namedProfileThread: null as boolean | null, namedProfileTurn: null as boolean | null, profileListSchema: null as boolean | null, mxcRead: { allowedRead: null as boolean | null, outsideReadDenied: null as boolean | null, status: 'not_run' }, extensionsDisabledVerified: null, nativeToolsVerified: null, childEscapeDenied: null, normalExitTreeVerified: null };
  const filesystem: { allowedRead: boolean | null; outsideReadDenied: boolean | null; allowedWrite: boolean | null; outsideWriteDenied: boolean | null; status: string; diagnostics: string[] } = { allowedRead: null, outsideReadDenied: null, allowedWrite: null, outsideWriteDenied: null, status: 'not_run', diagnostics: [] };
  try {
    if (codex && codex.via !== 'cmd-fallback') {
      const out = path.join(root, 'schema');
      const generated = await runProcess(codex, ['app-server', 'generate-ts', '--experimental', '--out', out], { cwd: workspace, env: clean, stdinText: null, timeoutMs: 30000 });
      if (generated.exitCode === 0 && !generated.terminationWarning) {
        const thread = readFileSync(path.join(out, 'v2', 'ThreadStartParams.ts'), 'utf8');
        const policy = readFileSync(path.join(out, 'v2', 'SandboxPolicy.ts'), 'utf8');
        const turn = readFileSync(path.join(out, 'v2', 'TurnStartParams.ts'), 'utf8');
        const requests = readFileSync(path.join(out, 'ClientRequest.ts'), 'utf8');
        schema.dynamicTools = /dynamicTools\?/.test(thread);
        schema.restrictedRead = /readOnlyAccess|readableRoots|access\??:/.test(policy);
        bounded.namedProfileThread = /permissions\?\s*:/.test(thread);
        bounded.namedProfileTurn = /permissions\?\s*:/.test(turn);
        bounded.profileListSchema = /permissionProfile\/list/.test(requests);
      }
      // Only throwaway files created above are tested; no real credentials are read.
      const spec = `{${Object.entries({ ':root': 'deny', ':minimal': 'read', ':workspace_roots': 'write', [process.execPath]: 'read' }).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(',')}}`;
      const script = `const fs=require('fs');const [inside,outside]=process.argv.slice(1);const result={};for(const [k,p] of [['allowedRead',inside],['outsideReadDenied',outside]]){try{fs.readFileSync(p);result[k]=k==='allowedRead'}catch{result[k]=k==='outsideReadDenied'}}for(const [k,p] of [['allowedWrite',inside+'.write'],['outsideWriteDenied',outside+'.write']]){try{fs.writeFileSync(p,'probe');result[k]=k==='allowedWrite'}catch{result[k]=k==='outsideWriteDenied'}}console.log('WORKBENCH_PROBE='+JSON.stringify(result))`;
      const args = ['sandbox', '-C', workspace, '-P', 'chat-probe', '-c', `permissions.chat-probe.filesystem=${spec}`, '-c', 'permissions.chat-probe.network.enabled=false', '--', process.execPath, '-e', script, source, marker];
      const result = await runProcess(codex, args, { cwd: workspace, env: clean, stdinText: null, timeoutMs: 30000 });
      for (const [label, pattern] of Object.entries({ config_error: /invalid|parse|unknown field|unknown variant|not found|unrecognized/i, access_denied: /access is denied|permission denied|os error 5|拒绝访问/i, missing_sandbox: /sandbox.*(?:missing|unavailable|not available|unsupported)|(?:missing|unavailable|not available|unsupported).*sandbox/i, elevation_required: /elevat/i })) {
        if (pattern.test(result.stderrTail)) filesystem.diagnostics.push(label);
      }
      if (result.exitCode === 0 && !result.terminationWarning) {
        const line = result.stdoutTail.split(/\r?\n/).find(s => s.startsWith('WORKBENCH_PROBE='));
        if (line) {
          const value = JSON.parse(line.slice('WORKBENCH_PROBE='.length));
          for (const key of ['allowedRead', 'outsideReadDenied', 'allowedWrite', 'outsideWriteDenied'] as const) if (typeof value[key] === 'boolean') filesystem[key] = value[key];
          filesystem.status = 'completed';
        } else filesystem.status = 'missing_probe_output';
      } else filesystem.status = result.terminationWarning ? 'exit_unknown' : result.timedOut ? 'timeout' : `sandbox_unavailable_or_policy_refused:${result.exitCode ?? 'unknown'}`;
      const readScript = `const fs=require('fs');const [a,b]=process.argv.slice(1);const out={};for(const [k,p] of [['allowedRead',a],['outsideReadDenied',b]]){try{fs.readFileSync(p);out[k]=k==='allowedRead'}catch(e){out[k]=k==='outsideReadDenied'&&(e.code==='EPERM'||e.code==='EACCES')}}console.log('MXC_READ='+JSON.stringify(out))`;
      const readArgs = ['sandbox', '--enable', 'prefer_mxc', '-C', workspace, '-P', 'chat-probe', '-c', 'permissions.chat-probe.filesystem={":root"="deny",":minimal"="read",":workspace_roots"="read"}', '-c', 'permissions.chat-probe.network.enabled=false', '--', process.execPath, '-e', readScript, source, marker];
      const readResult = await runProcess(codex, readArgs, { cwd: workspace, env: clean, stdinText: null, timeoutMs: 30000 });
      const line = readResult.stdoutTail.split(/\r?\n/).find(s => s.startsWith('MXC_READ='));
      if (readResult.exitCode === 0 && !readResult.terminationWarning && line) {
        const value = JSON.parse(line.slice('MXC_READ='.length));
        bounded.mxcRead.allowedRead = value.allowedRead === true;
        bounded.mxcRead.outsideReadDenied = value.outsideReadDenied === true;
        bounded.mxcRead.status = 'completed';
      } else bounded.mxcRead.status = readResult.terminationWarning ? 'exit_unknown' : `failed:${readResult.exitCode ?? 'unknown'}`;
    }
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), versions, codexSchema: schema, windowsSandbox: filesystem, bounded, unverified: ['credentialReadDenied', 'networkDenied', 'childEscapeDenied', 'cancellationConfirmed', 'normalExitTreeVerified', 'nativeToolsVerified', 'extensionsDisabledVerified', 'toolSurfaceVerified', 'invocationBinding', 'actualModelCalls'], enablingProofGenerated: false }, null, 2));
  } finally {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(root));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('拒绝删除临时目录之外的路径');
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(`能力探测失败: ${(error as Error).message}`); process.exitCode = 1; });
