import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type JobResult = {
  exitCode: number | null;
  cancelled: boolean;
  terminationWarning?: string;
  windowsJob?: {
    confirmed: boolean;
    jobActiveProcesses: number | null;
    targetPid: number | null;
    activeBeforeStop: number | null;
    rootExited: boolean;
    cancelReceived: boolean;
    resumed: boolean;
  };
};

function option(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${name}`);
  return path.resolve(process.argv[index + 1]!);
}

function processAbsent(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch { return true; }
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    process.stdout.write('Usage: tsx scripts/chat-windows-job-probe.ts --app-root ABS --evidence ABS\n');
    return;
  }
  const appRoot = option('--app-root');
  const evidenceFile = option('--evidence');
  const wrapper = path.join(appRoot, 'src/chat/windows-job-process.js');
  const targetNode = path.resolve(appRoot, '../runtime/node.exe');
  if (!existsSync(wrapper) || !existsSync(targetNode)) throw new Error('compiled app or packaged Node runtime missing');
  const module = await import(pathToFileURL(wrapper).href) as {
    loadChatWindowsJobSupervisorAssets(): Record<string, unknown> & { binaryPath: string };
    runChatWindowsJobProcess(command: { file: string; prefixArgs: string[]; via: 'direct' }, args: string[], options: Record<string, unknown>): Promise<JobResult>;
  };
  const supervisor = module.loadChatWindowsJobSupervisorAssets();
  const work = path.join(path.dirname(evidenceFile), `windows-job-probe-${process.pid}`);
  mkdirSync(work, { recursive: false });
  const tests: Array<Record<string, unknown>> = [];
  let passed = false;
  let cleanupPassed = false;
  try {
    const base = { supervisorPath: supervisor.binaryPath, receiptDirectory: work, cwd: work, env: process.env, stdinText: null, timeoutMs: 15_000, platform: 'win32' };
    const natural = await module.runChatWindowsJobProcess({ file: targetNode, prefixArgs: [], via: 'direct' }, ['-e', 'process.stdout.write("JOB_OK")'], base);
    assert.equal(natural.exitCode, 0); assert.equal(natural.terminationWarning, undefined); assert.equal(natural.windowsJob?.confirmed, true);
    tests.push({ name: 'natural-exit', passed: true, confirmed: true, activeProcesses: natural.windowsJob?.jobActiveProcesses, rootExited: natural.windowsJob?.rootExited });

    const controller = new AbortController(); let cancelChild = 0;
    const longParent = "const{spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)";
    const cancelTimer = setTimeout(() => controller.abort(), 5_000);
    const cancelled = await module.runChatWindowsJobProcess({ file: targetNode, prefixArgs: [], via: 'direct' }, ['-e', longParent], { ...base, signal: controller.signal, onStdoutLine: (line: string) => { cancelChild = Number(line); } });
    clearTimeout(cancelTimer);
    assert.equal(cancelled.cancelled, true); assert.equal(cancelled.terminationWarning, undefined); assert.equal(cancelled.windowsJob?.confirmed, true); assert.equal(cancelled.windowsJob?.cancelReceived, true); assert.ok((cancelled.windowsJob?.activeBeforeStop ?? 0) >= 2); assert.ok(cancelChild > 0 && processAbsent(cancelChild));
    tests.push({ name: 'five-second-cancel', passed: true, confirmed: true, activeBeforeStop: cancelled.windowsJob?.activeBeforeStop, activeProcesses: cancelled.windowsJob?.jobActiveProcesses, childAbsent: true });

    let orphan = 0;
    const parentExits = "const{spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid)";
    const rootExit = await module.runChatWindowsJobProcess({ file: targetNode, prefixArgs: [], via: 'direct' }, ['-e', parentExits], { ...base, onStdoutLine: (line: string) => { orphan = Number(line); } });
    assert.equal(rootExit.terminationWarning, undefined); assert.equal(rootExit.windowsJob?.confirmed, true); assert.ok((rootExit.windowsJob?.activeBeforeStop ?? 0) >= 1); assert.ok(orphan > 0 && processAbsent(orphan));
    tests.push({ name: 'root-exit-child-survives', passed: true, confirmed: true, activeBeforeStop: rootExit.windowsJob?.activeBeforeStop, activeProcesses: rootExit.windowsJob?.jobActiveProcesses, childAbsent: true });

    const invalid = await module.runChatWindowsJobProcess({ file: targetNode, prefixArgs: [], via: 'direct' }, ['-e', 'process.exit(0)'], { ...base, supervisorPath: targetNode, timeoutMs: 500 });
    assert.ok(invalid.terminationWarning); assert.notEqual(invalid.windowsJob?.confirmed, true);
    tests.push({ name: 'invalid-receipt-fail-closed', passed: true, confirmed: false });
    passed = true;
  } finally {
    const receiptFiles = existsSync(work) ? readdirSync(work) : [];
    let cleanupError: string | null = null;
    try { rmSync(work, { recursive: true, force: true }); } catch (error) { cleanupError = error instanceof Error ? error.name : 'cleanup-error'; }
    cleanupPassed = receiptFiles.length === 0 && !existsSync(work) && cleanupError === null;
    mkdirSync(path.dirname(evidenceFile), { recursive: true });
    writeFileSync(evidenceFile, `${JSON.stringify({
      schema: 'dual-model-workbench/windows-job-probe/v1', passed: passed && cleanupPassed, realModelCalls: 0,
      appRoot, supervisor, tests, cleanup: { receiptFiles, workRootAbsent: !existsSync(work), error: cleanupError },
    }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  }
  if (!cleanupPassed) throw new Error('Windows Job probe cleanup was not confirmed');
}

await main();
