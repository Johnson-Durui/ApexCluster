import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runProcess, type RunProcessResult } from '../adapters/process.js';
import type { CursorWriteCapabilities } from '../adapters/cursor-writer.js';

export const CURSOR_NATIVE_TOOL_EXCLUSION = Object.freeze([
  'shellToolCall', 'deleteToolCall', 'globToolCall', 'grepToolCall', 'readToolCall', 'updateTodosToolCall', 'readTodosToolCall', 'editToolCall',
  'lsToolCall', 'readLintsToolCall', 'mcpToolCall', 'semSearchToolCall', 'createPlanToolCall', 'webSearchToolCall', 'taskToolCall',
  'listMcpResourcesToolCall', 'readMcpResourceToolCall', 'applyAgentDiffToolCall', 'askQuestionToolCall', 'fetchToolCall', 'switchModeToolCall',
  'generateImageToolCall', 'recordScreenToolCall', 'computerUseToolCall', 'writeShellStdinToolCall', 'reflectToolCall', 'setupVmEnvironmentToolCall',
  'truncatedToolCall', 'startGrindExecutionToolCall', 'startGrindPlanningToolCall', 'webFetchToolCall', 'reportBugfixResultsToolCall',
  'aiAttributionToolCall', 'prManagementToolCall', 'mcpAuthToolCall', 'awaitToolCall', 'blameByFilePathToolCall', 'getMcpToolsToolCall',
  'reportBugToolCall', 'setActiveBranchToolCall', 'communicateUpdateToolCall', 'sendFinalSummaryToolCall', 'replaceEnvToolCall', 'editPrLabelsToolCall',
  'recordCiInvestigationFindingsToolCall', 'sendMessageToolCall', 'fetchCloudAgentDataToolCall', 'sendToUserToolCall', 'connectScmToolCall',
  'searchConversationsToolCall', 'createGoalToolCall', 'updateGoalToolCall', 'getAgentStatusToolCall', 'sendToAgentToolCall', 'readAgentTranscriptToolCall',
  'createAgentToolCall', 'stopAgentToolCall', 'writeCanvasToolCall', 'readCanvasToolCall', 'generateVideoToolCall', 'xSearchToolCall',
  'getOriginPrCodeTourToolCall', 'updateOriginPrCodeTourToolCall', 'listTrackedTasksToolCall', 'createTrackedTasksToolCall', 'updateTrackedTasksToolCall',
  'deleteTrackedTasksToolCall', 'updateTrackedTaskStatusesToolCall', 'createProjectToolCall', 'updateTrackedTaskTagsToolCall', 'stopProjectUpdatesToolCall',
  'startProjectUpdatesToolCall',
] as const);

export const CURSOR_NATIVE_TOOL_EXCLUSION_CSV = CURSOR_NATIVE_TOOL_EXCLUSION.join(',');
export const CURSOR_NATIVE_TOOL_EXCLUSION_LIST_SHA256 = 'f9dc2e134022c722b822f26669f59f9de925b5b392339ee8e4b2e5f2f753bca1';
export const CURSOR_NATIVE_TOOL_EXCLUSION_POLICY = 'cursor-wsl-host-tools-native-exclusion-v7';

export interface CursorNativeToolExclusionContract {
  cliVersion: string;
  root: string;
  indexSha256: string;
  chunkSha256: string;
  listSha256: string;
}

export const CURSOR_NATIVE_TOOL_EXCLUSION_CONTRACT: Readonly<CursorNativeToolExclusionContract> = Object.freeze({
  cliVersion: '2026.10.22-27dcf5f',
  root: '/opt/cursor-agent/versions/2026.10.22-27dcf5f',
  indexSha256: '7b4bb3badb36cff7b6cee7996d61bd3c32866cf354214374b77f5a5d33a0b3f2',
  chunkSha256: '32b06d3b612bc1e9baee4b9f87e7336f60188431058220e4d1d50cf999e947e6',
  listSha256: CURSOR_NATIVE_TOOL_EXCLUSION_LIST_SHA256,
});

export interface CursorNativeToolArtifactFile {
  path: string;
  realpath: string;
  uid: number;
  mode: number;
  file: boolean;
  symlink: boolean;
  text: string;
}

export interface CursorNativeToolExclusionArtifact {
  cliVersion: string;
  index: CursorNativeToolArtifactFile;
  chunk: CursorNativeToolArtifactFile;
}

export interface CursorNativeToolExclusionBinding {
  nativeToolExclusionRequestVerified: true;
  entrySha256: string;
  chunkSha256: string;
  listSha256: string;
  implementationSha256: string;
}

const digest = (value: string | Buffer): string => crypto.createHash('sha256').update(value).digest('hex');
const count = (text: string, anchor: string): number => text.split(anchor).length - 1;
const camel = (snake: string): string => snake.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());

function validateFile(file: CursorNativeToolArtifactFile, expectedPath: string, label: string): void {
  if (file.path !== expectedPath || file.realpath !== expectedPath || file.uid !== 0 || !file.file || file.symlink || (file.mode & 0o022) !== 0) {
    throw new Error(`${label} artifact metadata drift`);
  }
}

/** Pure fixed-artifact verifier used by the production WSL pre-dispatch probe and offline mutation tests. */
export function validateCursorNativeToolExclusionArtifact(
  artifact: CursorNativeToolExclusionArtifact,
  contract: CursorNativeToolExclusionContract = CURSOR_NATIVE_TOOL_EXCLUSION_CONTRACT,
): CursorNativeToolExclusionBinding & { toolCount: number; expectedExcludeHeaderValue: string } {
  if (artifact.cliVersion !== contract.cliVersion) throw new Error('Cursor exclusion CLI version drift');
  if (contract.listSha256 !== CURSOR_NATIVE_TOOL_EXCLUSION_LIST_SHA256 || digest(CURSOR_NATIVE_TOOL_EXCLUSION_CSV) !== contract.listSha256) throw new Error('Cursor exclusion list digest drift');
  validateFile(artifact.index, `${contract.root}/index.js`, 'index'); validateFile(artifact.chunk, `${contract.root}/7000.index.js`, 'chunk');
  if (digest(artifact.index.text) !== contract.indexSha256) throw new Error('Cursor exclusion index SHA drift');
  if (digest(artifact.chunk.text) !== contract.chunkSha256) throw new Error('Cursor exclusion chunk SHA drift');
  for (const anchor of ['"../proto/dist/generated/agent/v1/agent_pb.js"(', '--allowed-tools <tool>', '--exclude-tools <tool>', 'x-cursor-agent-allowed-tools', 'x-cursor-agent-exclude-tools']) {
    if (count(artifact.index.text, anchor) !== 1) throw new Error(`Cursor exclusion registration anchor drift: ${anchor}`);
  }
  for (const anchor of ['"./src/utils/exclude-tools.ts"(', '"./src/utils/exclude-tools-headers.ts"(', '"./src/run-agent.tsx"(']) {
    if (count(artifact.chunk.text, anchor) !== 1) throw new Error(`Cursor exclusion run-agent anchor drift: ${anchor}`);
  }
  const protoStart = artifact.index.text.indexOf('"../proto/dist/generated/agent/v1/agent_pb.js"(');
  const descriptorStart = artifact.index.text.indexOf('static $(){return["ToolCall|', protoStart);
  const descriptorEnd = artifact.index.text.indexOf('"]}}class Hi', descriptorStart);
  if (protoStart < 0 || descriptorStart < 0 || descriptorEnd < 0) throw new Error('Cursor exclusion descriptor anchor drift');
  const descriptor = artifact.index.text.slice(descriptorStart, descriptorEnd + 2);
  const tools = [...descriptor.matchAll(/\|\d+ ([a-z0-9_]+) #\d+ tool/g)].map(match => camel(match[1]!));
  if (tools.length !== 72 || new Set(tools).size !== tools.length || tools.join(',') !== CURSOR_NATIVE_TOOL_EXCLUSION_CSV) throw new Error('Cursor exclusion descriptor drift');
  if (!CURSOR_NATIVE_TOOL_EXCLUSION_CSV) throw new Error('Cursor exclusion nonempty header value drift');
  return { ...cursorNativeToolExclusionBinding(), entrySha256: contract.indexSha256, chunkSha256: contract.chunkSha256, listSha256: contract.listSha256,
    toolCount: tools.length, expectedExcludeHeaderValue: CURSOR_NATIVE_TOOL_EXCLUSION_CSV };
}

export function cursorNativeToolExclusionBinding(): CursorNativeToolExclusionBinding {
  const implementationSha256 = digest(readFileSync(fileURLToPath(import.meta.url)));
  return { nativeToolExclusionRequestVerified: true, entrySha256: CURSOR_NATIVE_TOOL_EXCLUSION_CONTRACT.indexSha256,
    chunkSha256: CURSOR_NATIVE_TOOL_EXCLUSION_CONTRACT.chunkSha256, listSha256: CURSOR_NATIVE_TOOL_EXCLUSION_LIST_SHA256, implementationSha256 };
}

function verifierProgram(): string {
  const contract = JSON.stringify(CURSOR_NATIVE_TOOL_EXCLUSION_CONTRACT);
  const tools = JSON.stringify(CURSOR_NATIVE_TOOL_EXCLUSION);
  return String.raw`import fs from 'node:fs';import crypto from 'node:crypto';
const contract=${contract},expected=${tools},camel=value=>value.replace(/_([a-z0-9])/g,(_,letter)=>letter.toUpperCase()),digest=value=>crypto.createHash('sha256').update(value).digest('hex'),count=(text,anchor)=>text.split(anchor).length-1;
const inspect=(file,label,expectedHash)=>{const info=fs.lstatSync(file),realpath=fs.realpathSync(file);if(!info.isFile()||info.isSymbolicLink()||info.uid!==0||(info.mode&0o022)!==0||realpath!==file)throw Error(label+' artifact metadata drift');const text=fs.readFileSync(file,'utf8');if(digest(text)!==expectedHash)throw Error(label+' SHA drift');return text};
const index=inspect(contract.root+'/index.js','index',contract.indexSha256),chunk=inspect(contract.root+'/7000.index.js','chunk',contract.chunkSha256),csv=expected.join(',');if(expected.length!==72||new Set(expected).size!==72||expected.some(value=>!value)||digest(csv)!==contract.listSha256)throw Error('list digest drift');
for(const anchor of ['"../proto/dist/generated/agent/v1/agent_pb.js"(','--allowed-tools <tool>','--exclude-tools <tool>','x-cursor-agent-allowed-tools','x-cursor-agent-exclude-tools'])if(count(index,anchor)!==1)throw Error('index anchor drift '+anchor);
for(const anchor of ['"./src/utils/exclude-tools.ts"(','"./src/utils/exclude-tools-headers.ts"(','"./src/run-agent.tsx"('])if(count(chunk,anchor)!==1)throw Error('chunk anchor drift '+anchor);
const proto=index.indexOf('"../proto/dist/generated/agent/v1/agent_pb.js"('),start=index.indexOf('static $(){return["ToolCall|',proto),end=index.indexOf('"]}}class Hi',start);if(proto<0||start<0||end<0)throw Error('descriptor anchor drift');const descriptor=index.slice(start,end+2),actual=[...descriptor.matchAll(/\|\d+ ([a-z0-9_]+) #\d+ tool/g)].map(match=>camel(match[1]));if(actual.length!==72||new Set(actual).size!==72||actual.join(',')!==csv||!csv)throw Error('descriptor/header value drift');process.stdout.write(JSON.stringify({nativeToolExclusionRequestVerified:true,toolCount:actual.length,listSha256:digest(csv)}));`;
}

function hostEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
}

/** No-model fixed Cursor artifact/ABI check. It runs before every isolated chat dispatch. */
export async function verifyCursorNativeToolExclusion(
  capabilities: CursorWriteCapabilities,
  signal: AbortSignal,
): Promise<void> {
  const contract = CURSOR_NATIVE_TOOL_EXCLUSION_CONTRACT;
  if (capabilities.cliVersion !== contract.cliVersion || capabilities.entryPath !== `${contract.root}/index.js`) throw new Error('Cursor exclusion capability version/path drift');
  const result: RunProcessResult = await runProcess({ file: 'C:\\Windows\\System32\\wsl.exe', prefixArgs: [], via: 'config' }, [
    '-d', capabilities.distro, '--cd', '/home/codex', '--exec', capabilities.nodePath, '--input-type=module', '-e', verifierProgram(),
  ], { cwd: process.cwd(), env: hostEnv(), stdinText: null, timeoutMs: 30_000, signal });
  if (result.spawnError && result.pid === null) throw new Error('Cursor exclusion verifier did not start');
  if (result.terminationWarning || (result.spawnError && result.pid !== null)) throw Object.assign(new Error('Cursor exclusion verifier exit unknown'), { exitConfirmed: false });
  if (result.cancelled || result.timedOut || result.spawnError || result.exitCode !== 0) throw new Error(`Cursor exclusion verifier failed: ${result.stderrTail.slice(0, 500)}`);
  const output = JSON.parse(result.stdoutTail) as Record<string, unknown>;
  if (output.nativeToolExclusionRequestVerified !== true || output.toolCount !== 72 || output.listSha256 !== CURSOR_NATIVE_TOOL_EXCLUSION_LIST_SHA256) throw new Error('Cursor exclusion verifier output drift');
}
