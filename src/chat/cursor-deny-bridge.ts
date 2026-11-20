import crypto from 'node:crypto';
import { SystemWslCursorWriterBridge, type CursorWriterBridge, type CursorWriteCapabilities, type CursorWriterSnapshot } from '../adapters/cursor-writer.js';
import { runProcess } from '../adapters/process.js';
import { runCursorReadonlyRuntime } from './cursor-readonly-runtime.js';
import { CURSOR_MODEL_CACHE_KEYS, cursorFixedModelSelection } from './cursor-model-state.js';
import { CURSOR_ENTRY_SHA256, CURSOR_NATIVE_APPROVAL_CASES, CURSOR_NATIVE_APPROVAL_MARKER, cursorNativeApprovalSource, type CursorNativeApprovalAudit } from './cursor-native-approval.js';

export const CURSOR_DENY_ALL = Object.freeze(['Read(**)', 'Write(**)', 'Shell(*)', 'WebFetch(*)', 'WebSearch(*)', 'Mcp(*:*)']);
export const CURSOR_NATIVE_DENY_MARKER = 'DMW_NATIVE_DENY_V1';
export const CURSOR_PROFILE_CHUNK_SHA256 = '9eac42a5bb59f700cc8dec233756e3cdc1fd4aa775f44bcdd5a13dfc7cdc82d6';
const NATIVE_DENY_AGENT_MESSAGE = 'Native tools are disabled; use host JSON tools.';
const AUTH_INFO_KEYS = new Set(['email', 'displayName', 'teamId', 'teamName', 'userId', 'authId', 'organizationId', 'activeTeamId']);
const AUTH_INFO_STRING_KEYS = new Set(['email', 'displayName', 'teamName', 'authId', 'organizationId']);
const MUTABLE_METADATA_KEYS = new Set(['authInfo', 'privacyCache']);
const MODEL_SIGNATURE_KEY = '__dmwFixedModelSelection';
export const CURSOR_GROK_MODEL_STATE = Object.freeze({
  model: Object.freeze({ modelId: 'grok-4.7', displayModelId: 'grok-4.7', displayName: 'Grok 4.7 256K High Fast', displayNameShort: 'Grok 4.7 256K High Fast', aliases: Object.freeze([]), maxMode: false }),
  hasChangedDefaultModel: true,
  maxMode: false,
  modelParameters: Object.freeze({ 'grok-4.7': Object.freeze([
    Object.freeze({ id: 'context', value: '256k' }), Object.freeze({ id: 'reasoning_effort', value: 'high' }), Object.freeze({ id: 'fast', value: 'true' }),
  ]) }),
  selectedModel: Object.freeze({ modelId: 'grok-4.7', parameters: Object.freeze([
    Object.freeze({ id: 'context', value: '256k' }), Object.freeze({ id: 'reasoning_effort', value: 'high' }), Object.freeze({ id: 'fast', value: 'true' }),
  ]) }),
  modelSelectionHistory: Object.freeze(['grok-4.7']),
});

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const posixQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [key, stable((value as Record<string, unknown>)[key])])) : value;

function validateMutableMetadata(config: Record<string, unknown>): void {
  if ('authInfo' in config) {
    const value = config.authInfo;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('authInfo must be an object');
    for (const [key, field] of Object.entries(value)) if (!AUTH_INFO_KEYS.has(key)
      || (AUTH_INFO_STRING_KEYS.has(key) ? typeof field !== 'string' : !(typeof field === 'number' && Number.isFinite(field)))) throw new Error(`invalid authInfo field ${key}`);
  }
  if ('privacyCache' in config) {
    const value = config.privacyCache;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('privacyCache must be an object');
    const fields = value as Record<string, unknown>;
    if (Object.keys(fields).some(key => !['ghostMode', 'privacyMode', 'updatedAt'].includes(key)) || typeof fields.ghostMode !== 'boolean'
      || (fields.privacyMode !== undefined && !(typeof fields.privacyMode === 'number' && Number.isFinite(fields.privacyMode)))
      || !(typeof fields.updatedAt === 'number' && Number.isFinite(fields.updatedAt))) throw new Error('invalid privacyCache');
  }
}

/** Full config projection: only the two vendor-owned, strictly validated metadata objects are omitted. */
export function cursorMutableConfigProjection(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Cursor mutable config must be an object');
  const config = value as Record<string, unknown>; validateMutableMetadata(config);
  if (Object.hasOwn(config, MODEL_SIGNATURE_KEY)) throw new Error('Cursor mutable config contains reserved model signature key');
  const modelSelection = cursorFixedModelSelection(config); if (!modelSelection) throw new Error('Cursor mutable config is missing fixed model selection');
  return { ...Object.fromEntries(Object.entries(config).filter(([key]) => !MUTABLE_METADATA_KEYS.has(key) && !(CURSOR_MODEL_CACHE_KEYS as readonly string[]).includes(key))),
    [MODEL_SIGNATURE_KEY]: modelSelection };
}

export function cursorMutableConfigProjectionSha256(value: unknown): string {
  return sha256(JSON.stringify(stable(cursorMutableConfigProjection(value))));
}

function materializedProfileConfig(policy: Record<string, unknown>, autoAcceptWebSearch: boolean): string {
  return `${JSON.stringify({
    version: 1, channel: 'static', editor: { vimMode: false },
    display: { showLineNumbers: false, showThinkingBlocks: false, showStatusIndicators: false, showStatusLineRunningTime: false, mode: 'zen' },
    notifications: true, hints: true, modelSlashCommands: true, steering: true, rewind: true, ...CURSOR_GROK_MODEL_STATE,
    exploreSubagentModel: 'default', network: { useHttp1ForAgent: false }, approvalMode: 'allowlist', autoAcceptWebSearch,
    sandbox: { mode: 'enabled', networkAccess: 'user_config_with_defaults', readBoundary: 'workspace' }, runEverythingSettingsPromptStreak: 0,
    attribution: { attributeCommitsToAgent: true, attributePRsToAgent: true }, webFetchDomainAllowlist: [], permissions: policy.permissions,
  }, null, 2)}\n`;
}

function cursorProfileGuardSource(capabilities: CursorWriteCapabilities): string {
  if (!/^\/opt\/cursor-agent\/versions\/[^/]+\/index\.js$/.test(capabilities.entryPath)) throw new Error('profile guard entry path is outside fixed Cursor install');
  const target = capabilities.entryPath.replace(/\/index\.js$/, '/4060.index.js');
  const disabled = ['enableTeamHooks', 'enableWorkspaceOpenHook', 'enableManagedSkillsSync', 'enableMarketplacePlugins', 'enableUserLocalPlugins', 'enableFirstPartyPlugins', 'enableMcp'];
  const expected = { requiresCursorAuth: true, enableCursorBackendServices: true, enableTeamHooks: true, enableWorkspaceOpenHook: true,
    enableManagedSkillsSync: true, enableMarketplacePlugins: true, enableUserLocalPlugins: true, enableFirstPartyPlugins: true,
    enableLocalMarketplacePlugins: false, enableMcp: true, enableWebTools: true, enableGenerateImage: true, enableMaxMode: true,
    enableUsageCommand: true, enableCursorTelemetry: true };
  let source = `'use strict';\nconst fs=require('node:fs'),crypto=require('node:crypto'),Module=require('node:module');\nconst target=${JSON.stringify(target)},expectedHash=${JSON.stringify(CURSOR_PROFILE_CHUNK_SHA256)},moduleId='./src/local-agent-profile.ts',disabled=${JSON.stringify(disabled)},expected=${JSON.stringify(expected)};\nconst uidMap=fs.readFileSync('/proc/self/uid_map','utf8').trim().split(/\\n/).map(line=>line.trim().split(/\\s+/).map(Number));if(!uidMap.length||uidMap.some(row=>row.length!==3||row.some(value=>!Number.isSafeInteger(value)||value<0)||row[2]<1))throw Error('DMW_PROFILE_GUARD_UID_MAP');const overflowUid=Number(fs.readFileSync('/proc/sys/kernel/overflowuid','utf8').trim()),mappedRoot=uidMap.find(([,outside,length])=>outside===0||outside<0&&0<outside+length),mappedRootUid=mappedRoot?mappedRoot[0]-mappedRoot[1]:null,expectedUids=[overflowUid,...mappedRootUid===null?[]:[mappedRootUid]];if(!expectedUids.every(value=>Number.isSafeInteger(value)&&value>=0))throw Error('DMW_PROFILE_GUARD_UID_MAP');const info=fs.lstatSync(target),realpathMatches=fs.realpathSync(target)===target,targetDiagnostic={uid:info.uid,mode:info.mode&0o777,expectedUids,uidMap,file:info.isFile(),symlink:info.isSymbolicLink(),realpathMatches};if(!info.isFile()||info.isSymbolicLink()||!expectedUids.includes(info.uid)||(info.mode&0o022)!==0||!realpathMatches)throw Error('DMW_PROFILE_GUARD_TARGET '+JSON.stringify(targetDiagnostic));if(crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')!==expectedHash)throw Error('DMW_PROFILE_GUARD_HASH');\nconst patch=profile=>{if(!profile||Object.keys(profile).sort().join(',')!=='capabilities,kind,mode'||profile.kind!=='remote'||profile.mode!=='normal')throw Error('DMW_PROFILE_GUARD_PROFILE');const caps=profile.capabilities;if(!caps||Object.keys(caps).sort().join(',')!==Object.keys(expected).sort().join(','))throw Error('DMW_PROFILE_GUARD_CAP_KEYS');for(const [key,value] of Object.entries(expected))if(caps[key]!==value)throw Error('DMW_PROFILE_GUARD_CAP_DEFAULTS');const nextCaps={...caps};for(const key of disabled)nextCaps[key]=false;const next={...profile,capabilities:nextCaps};for(const key of Object.keys(profile))if(key!=='capabilities'&&next[key]!==profile[key])throw Error('DMW_PROFILE_GUARD_REFERENCE');return next};\nconst load=Module._load;let wrapped=false;Module._load=function(request,parent,isMain){const resolved=Module._resolveFilename(request,parent,isMain);if(resolved!==target)return load.apply(this,arguments);const value=load.apply(this,arguments);if(wrapped)throw Error('DMW_PROFILE_GUARD_DUPLICATE_LOAD');if(!value||value.id!==4060||!Array.isArray(value.ids)||value.ids.join(',')!=='1538,4060'||!value.modules||Object.keys(value).sort().join(',')!=='id,ids,modules')throw Error('DMW_PROFILE_GUARD_CHUNK_SHAPE');const factory=value.modules[moduleId];if(typeof factory!=='function')throw Error('DMW_PROFILE_GUARD_FACTORY');value.modules[moduleId]=function(module,exports,r){let definitions=false;const proxy=new Proxy(r,{get(targetObject,property,receiver){if(property!=='d')return Reflect.get(targetObject,property,receiver);return(out,defs)=>{if(definitions||out!==module.exports||!defs||Object.keys(defs).sort().join(',')!=='Rb,UV'||typeof defs.Rb!=='function'||typeof defs.UV!=='function')throw Error('DMW_PROFILE_GUARD_EXPORTS');definitions=true;const originalRemote=defs.Rb(),originalSelector=defs.UV();if(typeof originalSelector!=='function'||originalSelector({localAgent:false,requestedLocalAgentMode:undefined,localAgentProvider:undefined})!==originalRemote)throw Error('DMW_PROFILE_GUARD_SELECTOR');const patchedRemote=patch(originalRemote),wrappedSelector=(...args)=>{const selected=originalSelector(...args);if(selected!==originalRemote)throw Error('DMW_PROFILE_GUARD_LOCAL_FALLBACK');return patchedRemote};return targetObject.d(out,{Rb:()=>patchedRemote,UV:()=>wrappedSelector})}}});factory(module,exports,proxy);if(!definitions)throw Error('DMW_PROFILE_GUARD_EXPORTS_MISSING')};wrapped=true;Module._load=load;return value};\nrequire(target);if(!wrapped||Module._load!==load)throw Error('DMW_PROFILE_GUARD_NOT_INSTALLED');\n`;
  source = source.replace('const load=Module._load;', "const audit=require('node:path').join(__dirname,'profile-guard-audit.jsonl');let recorded=false;const record=()=>{if(recorded)return;const value=fs.lstatSync(audit);if(!value.isFile()||value.isSymbolicLink()||value.uid!==process.getuid()||value.size>65536)throw Error('DMW_PROFILE_GUARD_AUDIT');fs.appendFileSync(audit,JSON.stringify({version:1,chunkSha256:expectedHash,disabled})+'\\n');recorded=true};\nconst load=Module._load;");
  const eager = "const originalRemote=defs.Rb(),originalSelector=defs.UV();if(typeof originalSelector!=='function'||originalSelector({localAgent:false,requestedLocalAgentMode:undefined,localAgentProvider:undefined})!==originalRemote)throw Error('DMW_PROFILE_GUARD_SELECTOR');const patchedRemote=patch(originalRemote),wrappedSelector=(...args)=>{const selected=originalSelector(...args);if(selected!==originalRemote)throw Error('DMW_PROFILE_GUARD_LOCAL_FALLBACK');return patchedRemote};return targetObject.d(out,{Rb:()=>patchedRemote,UV:()=>wrappedSelector})";
  const lazy = "const rb=defs.Rb,uv=defs.UV;let initialized=false,patchedRemote,wrappedSelector;const initialize=()=>{if(initialized)return;const originalRemote=rb(),originalSelector=uv();if(typeof originalSelector!=='function'||originalSelector({localAgent:false,requestedLocalAgentMode:undefined,localAgentProvider:undefined})!==originalRemote)throw Error('DMW_PROFILE_GUARD_SELECTOR');patchedRemote=patch(originalRemote);record();wrappedSelector=(...args)=>{const selected=originalSelector(...args);if(selected!==originalRemote)throw Error('DMW_PROFILE_GUARD_LOCAL_FALLBACK');return patchedRemote};initialized=true};return targetObject.d(out,{Rb:()=>{initialize();return patchedRemote},UV:()=>{initialize();return wrappedSelector}})";
  source = source.replace(eager, lazy);
  if (!source.includes('profile-guard-audit.jsonl') || !source.includes('let initialized=false,patchedRemote,wrappedSelector')) throw new Error('profile guard lazy/audit anchors missing');
  return source;
}

export interface CursorDenyProfileArtifacts {
  projectPolicy: string; profileConfig: string; hooks: string; script: string; profileGuard: string; nativeApproval: string; binding: string; fixedStdout: string; command: string;
  hashes: { projectPolicy: string; profileConfig: string; profileProjection: string; homeProjection: string; hooks: string; script: string; profileGuard: string; profileChunk: string; nativeApproval: string; entry: string; binding: string; fixedStdout: string };
}

function canonicalDenyScript(fixedStdout: string): string {
  return `import fs from 'node:fs';\nimport crypto from 'node:crypto';\nimport { fileURLToPath } from 'node:url';\nconst chunks=[];let bytes=0;for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>1048576)break;chunks.push(chunk)}\nlet toolName='INVALID';try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(typeof value?.tool_name==='string'&&/^[A-Za-z0-9:_-]{1,200}$/.test(value.tool_name))toolName=value.tool_name}catch{}\nconst self=fileURLToPath(import.meta.url);const bindingFile=fileURLToPath(new URL('./receipt-binding.json',import.meta.url));const receiptFile=fileURLToPath(new URL('./native-deny-receipts.jsonl',import.meta.url));\nfor(const file of [self,bindingFile,receiptFile]){const info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid())throw new Error('unsafe native deny artifact')}\nconst binding=JSON.parse(fs.readFileSync(bindingFile,'utf8'));if(typeof binding.invocationNonce!=='string'||typeof binding.rootSha256!=='string'||!(binding.markerSha256===null||typeof binding.markerSha256==='string')||![binding.profileProjectionSha256,binding.homeProjectionSha256].every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)))throw new Error('invalid native deny binding');\nconst output=${JSON.stringify(fixedStdout)};let stdoutCompleted=false;process.stdout.once('error',()=>{process.exitCode=74});process.on('exit',(code)=>{fs.appendFileSync(receiptFile,JSON.stringify({invocationNonce:binding.invocationNonce,rootSha256:binding.rootSha256,markerSha256:binding.markerSha256,profileProjectionSha256:binding.profileProjectionSha256,homeProjectionSha256:binding.homeProjectionSha256,toolName,scriptSha256:crypto.createHash('sha256').update(fs.readFileSync(self)).digest('hex'),stdoutSha256:crypto.createHash('sha256').update(output).digest('hex'),stdoutCompleted,exitCode:code})+'\\n')});\nprocess.stdout.write(output,()=>{stdoutCompleted=true;process.exitCode=2});\n`;
}

function bindProfileGuardReceipt(source: string): string {
  const validation = 'binding.homeProjectionSha256]';
  const receipt = 'homeProjectionSha256:binding.homeProjectionSha256,toolName';
  if (source.split(validation).length !== 2 || source.split(receipt).length !== 2) throw new Error('profile guard receipt anchors mismatch');
  return source.replace(validation, 'binding.homeProjectionSha256,binding.profileGuardSha256,binding.profileChunkSha256]')
    .replace(receipt, 'homeProjectionSha256:binding.homeProjectionSha256,profileGuardSha256:binding.profileGuardSha256,profileChunkSha256:binding.profileChunkSha256,toolName');
}

/** Exact, model-independent global profile material installed for each isolated chat invocation. */
export function cursorDenyProfileArtifacts(capabilities: CursorWriteCapabilities, root: string): CursorDenyProfileArtifacts {
  if (!/^\/opt\/cursor-agent\/versions\/[^/]+\/node$/.test(capabilities.nodePath)) throw new Error('Grok hook Node path is outside the trusted fixed-version directory');
  const match = /^\/home\/codex\/\.dual-model-workbench\/writer-([a-f0-9-]{36})$/.exec(root); if (!match) throw new Error('invalid Grok hook root');
  const policy = { permissions: { allow: [], deny: CURSOR_DENY_ALL } };
  const projectPolicy = `${JSON.stringify(policy, null, 2)}\n`;
  const profileConfig = materializedProfileConfig(policy, false);
  const command = `${posixQuote(capabilities.nodePath)} '/cursor-profile/deny-native.mjs'`;
  const hooks = `${JSON.stringify({ version: 1, hooks: { preToolUse: [{ type: 'command', command, matcher: '.*', timeout: 5, failClosed: true }] } }, null, 2)}\n`;
  const fixedStdout = JSON.stringify({ permission: 'deny', user_message: CURSOR_NATIVE_DENY_MARKER, agent_message: NATIVE_DENY_AGENT_MESSAGE });
  const profileProjection = cursorMutableConfigProjectionSha256(JSON.parse(profileConfig));
  const script = bindProfileGuardReceipt(canonicalDenyScript(fixedStdout)); const profileGuard = cursorProfileGuardSource(capabilities); const profileGuardSha256 = sha256(profileGuard);
  const nativeApproval = cursorNativeApprovalSource(capabilities); const nativeApprovalSha256 = sha256(nativeApproval);
  const binding = `${JSON.stringify({ invocationNonce: match[1], rootSha256: sha256(root), markerSha256: null, profileProjectionSha256: profileProjection, homeProjectionSha256: profileProjection,
    profileGuardSha256, profileChunkSha256: CURSOR_PROFILE_CHUNK_SHA256, nativeApprovalSha256, entrySha256: CURSOR_ENTRY_SHA256 }, null, 2)}\n`;
  return { projectPolicy, profileConfig, hooks, script, profileGuard, nativeApproval, binding, fixedStdout, command, hashes: { projectPolicy: sha256(projectPolicy), profileConfig: sha256(profileConfig),
    profileProjection, homeProjection: profileProjection, hooks: sha256(hooks), script: sha256(script), profileGuard: profileGuardSha256,
    profileChunk: CURSOR_PROFILE_CHUNK_SHA256, nativeApproval: nativeApprovalSha256, entry: CURSOR_ENTRY_SHA256, binding: sha256(binding), fixedStdout: sha256(fixedStdout) } };
}

export interface CursorProfileGuardAudit { version: 1; chunkSha256: string; disabled: string[] }
export type CursorDenyPolicyResult = { ok: true; hashes: CursorDenyProfileArtifacts['hashes']; audit: string[]; profileGuardAudit: CursorProfileGuardAudit[]; nativeApprovalAudit: CursorNativeApprovalAudit[]; receipts?: CursorHookReceipt[] };

export function parseCursorPolicyHelperOutput(mode: string, stdout: string, expectedHashes: CursorDenyProfileArtifacts['hashes']): CursorDenyPolicyResult {
  let parsed: CursorDenyPolicyResult;
  try { parsed = JSON.parse(stdout) as CursorDenyPolicyResult; }
  catch { throw new Error(`helper_stdout_parse_failure mode=${mode} size=${Buffer.byteLength(stdout)} sha256=${sha256(stdout)}`); }
  if (parsed.ok !== true || JSON.stringify(parsed.hashes) !== JSON.stringify(expectedHashes) || !Array.isArray(parsed.audit) || !Array.isArray(parsed.profileGuardAudit) || !Array.isArray(parsed.nativeApprovalAudit)) {
    const fields = parsed && typeof parsed === 'object' ? Object.keys(parsed).sort().join(',') : typeof parsed;
    throw new Error(`helper_contract_failure mode=${mode} fields=${fields}`);
  }
  return parsed;
}

// This fixed host operation touches only explicit files below the invocation UUID root.
// Keeping it separate preserves the previously verified legacy writer runtime.
const policyOperationBase = String.raw`
import fs from 'node:fs';import crypto from 'node:crypto';
const chunks=[];for await(const c of process.stdin)chunks.push(c);
const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
if(!/^\/home\/codex\/\.dual-model-workbench\/writer-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.root))throw new Error('invalid chat root');
for(const dir of ['/home/codex','/home/codex/.dual-model-workbench',input.root]){const info=fs.lstatSync(dir);if(!info.isDirectory()||info.isSymbolicLink()||fs.realpathSync(dir)!==dir||info.uid!==process.getuid())throw new Error('unsafe chat root')}
const digest=(file)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const explicit={projectPolicy:input.root+'/workspace/.cursor/cli.json',profileConfig:input.root+'/profile/cli-config.json',hooks:input.root+'/profile/hooks.json',script:input.root+'/profile/deny-native.mjs',binding:input.root+'/profile/receipt-binding.json'};
const stable=(value)=>{if(Array.isArray(value))return value.map(stable);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])]));return value};
const semantic=(value)=>crypto.createHash('sha256').update(JSON.stringify(stable(JSON.parse(value)))).digest('hex');
const project=(file,label,expected)=>{let value;try{value=JSON.parse(fs.readFileSync(file,'utf8'))}catch{throw new Error('controlled-artifact-drift '+JSON.stringify({label,type:'file',size:fs.lstatSync(file).size,sha256:digest(file),expectedSha256:expected,driftKind:'json_parse_failure'}))}if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('mutable-config-invalid '+label+' root');if(Object.hasOwn(value,'authInfo')){const x=value.authInfo;if(!x||typeof x!=='object'||Array.isArray(x))throw new Error('mutable-config-invalid '+label+' authInfo');for(const [key,field] of Object.entries(x)){const stringKey=['email','displayName','teamName','authId','organizationId'].includes(key),numberKey=['teamId','userId','activeTeamId'].includes(key);if(stringKey?typeof field!=='string':numberKey?!(typeof field==='number'&&Number.isFinite(field)):true)throw new Error('mutable-config-invalid '+label+' authInfo/'+key)}}if(Object.hasOwn(value,'privacyCache')){const x=value.privacyCache;if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).some(key=>!['ghostMode','privacyMode','updatedAt'].includes(key))||typeof x.ghostMode!=='boolean'||(x.privacyMode!==undefined&&!(typeof x.privacyMode==='number'&&Number.isFinite(x.privacyMode)))||!(typeof x.updatedAt==='number'&&Number.isFinite(x.updatedAt)))throw new Error('mutable-config-invalid '+label+' privacyCache')}const projected=Object.fromEntries(Object.entries(value).filter(([key])=>!['authInfo','privacyCache'].includes(key)));const actual=crypto.createHash('sha256').update(JSON.stringify(stable(projected))).digest('hex');if(actual!==expected)throw new Error('mutable-config-projection-drift '+JSON.stringify({label,type:'file',size:fs.lstatSync(file).size,projectionSha256:actual,expectedProjectionSha256:expected,fields:Object.keys(value).sort()}))};
const specs=[
  {label:'projectPolicy',file:explicit.projectPolicy,expectedSha256:input.hashes.projectPolicy,expected:input.contents.projectPolicy,json:true},
  {label:'hooks',file:explicit.hooks,expectedSha256:input.hashes.hooks,expected:input.contents.hooks,json:true},
  {label:'script',file:explicit.script,expectedSha256:input.hashes.script,expected:input.contents.script,json:false},
  {label:'binding',file:explicit.binding,expectedSha256:input.hashes.binding,expected:input.contents.binding,json:true},
  {label:'homeHooks',file:input.root+'/project-state/hooks.json',expectedSha256:input.hashes.hooks,expected:input.contents.hooks,json:true},
];
const verifyTrees=()=>{const roots=[[input.root+'/profile',new Set(['cli-config.json','hooks.json','deny-native.mjs','receipt-binding.json','native-deny-receipts.jsonl'])],[input.root+'/project-state',new Set(['cli-config.json','hooks.json','.gitignore','sandbox-policies','projects','chats'])]];const bucket=crypto.createHash('md5').update('/workspace').digest('hex'),sessions=new Set,chatFiles=[];const chatAllowed=(rel,info)=>{if(rel==='chats'||rel==='chats/'+bucket)return info.isDirectory();const session=/^chats\/([a-f0-9]{32})\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(rel);if(session){if(session[1]!==bucket||!info.isDirectory())return false;sessions.add(session[2].toLowerCase());return sessions.size<=4}const file=/^chats\/([a-f0-9]{32})\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/(store\.db(?:-wal|-shm)?|meta\.json|prompt_history\.json|pasted_text\.json)$/i.exec(rel);if(!file||file[1]!==bucket||!sessions.has(file[2].toLowerCase())||!info.isFile()||info.size>16777216||(info.mode&0o111)!==0)return false;chatFiles.push(rel);return chatFiles.length<=32};for(const [root,top] of roots){const visit=(dir,relative='')=>{for(const name of fs.readdirSync(dir)){const rel=relative?relative+'/'+name:name,full=dir+'/'+name,info=fs.lstatSync(full);if(info.isSymbolicLink()||info.uid!==process.getuid())throw new Error('controlled-directory-drift '+JSON.stringify({root:root.endsWith('/profile')?'profile':'project-state',path:rel,type:info.isSymbolicLink()?'symlink':'owner'}));if(!relative&&!top.has(name))throw new Error('controlled-directory-drift '+JSON.stringify({root:root.endsWith('/profile')?'profile':'project-state',path:rel,type:'unexpected'}));if(root.endsWith('/project-state')&&relative){const allowed=rel==='sandbox-policies'||/^sandbox-policies\/sandbox-policy-[a-f0-9]+$/.test(rel)||rel==='projects'||rel==='projects/workspace'||/^projects\/workspace\/(agent-transcripts|terminals|agent-notes|agent-tools|subagents)(\/[A-Za-z0-9._-]{1,128}){0,4}$/.test(rel)||chatAllowed(rel,info);if(!allowed)throw new Error('controlled-directory-drift '+JSON.stringify({root:'project-state',path:rel,type:'unexpected'}))}if(info.isDirectory())visit(full,rel);else if(!info.isFile()||info.size>16777216)throw new Error('controlled-directory-drift '+JSON.stringify({root:root.endsWith('/profile')?'profile':'project-state',path:rel,type:info.isFile()?'oversize':'other',size:info.size}))}};visit(root)}};
const verify=()=>{for(const spec of specs){let info;try{info=fs.lstatSync(spec.file)}catch(error){if(error?.code==='ENOENT')throw new Error('controlled-artifact-drift '+JSON.stringify({label:spec.label,type:'missing',size:null,sha256:null,expectedSha256:spec.expectedSha256,driftKind:'missing'}));throw error}const type=info.isSymbolicLink()?'symlink':info.isFile()?'file':info.isDirectory()?'directory':'other';let actualSha256=null;let driftKind=type==='file'?'literal_bytes_drift':'type_drift';let semanticSha256=null;let expectedSemanticSha256=null;if(type==='file'&&!info.isSymbolicLink()){actualSha256=digest(spec.file);if(actualSha256===spec.expectedSha256&&info.uid===process.getuid())continue;if(spec.json){expectedSemanticSha256=semantic(spec.expected);try{semanticSha256=semantic(fs.readFileSync(spec.file,'utf8'));driftKind=semanticSha256===expectedSemanticSha256?'literal_bytes_drift':'json_field_drift'}catch{driftKind='json_parse_failure'}}}throw new Error('controlled-artifact-drift '+JSON.stringify({label:spec.label,type,size:info.size,sha256:actualSha256,expectedSha256:spec.expectedSha256,driftKind,semanticSha256,expectedSemanticSha256,ownerMatches:info.uid===process.getuid()}))}project(explicit.profileConfig,'profileConfig',input.hashes.profileProjection);project(input.root+'/project-state/cli-config.json','homeProfileConfig',input.hashes.homeProjection);verifyTrees()};
if(input.mode==='policy'){
  for(const relative of ['workspace','workspace/.cursor','profile','project-state']){const info=fs.lstatSync(input.root+'/'+relative);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('unsafe policy directory')}
  fs.writeFileSync(explicit.projectPolicy,input.contents.projectPolicy,{mode:0o600});fs.writeFileSync(explicit.profileConfig,input.contents.profileConfig,{mode:0o600});
  fs.writeFileSync(explicit.hooks,input.contents.hooks,{flag:'wx',mode:0o600});fs.writeFileSync(explicit.script,input.contents.script,{flag:'wx',mode:0o700});fs.writeFileSync(explicit.binding,input.contents.binding,{flag:'wx',mode:0o600});fs.writeFileSync(input.root+'/profile/native-deny-receipts.jsonl','',{flag:'wx',mode:0o600});
  fs.writeFileSync(input.root+'/project-state/hooks.json',input.contents.hooks,{flag:'wx',mode:0o600});fs.writeFileSync(input.root+'/project-state/cli-config.json',input.contents.profileConfig,{flag:'wx',mode:0o600});verify();
}else if(input.mode==='inspect'||input.mode==='audit')verify();
else if(input.mode==='remove')fs.rmSync(input.root,{recursive:true,force:false});
else throw new Error('invalid operation');
let receipts=[];if(input.mode!=='remove'){const file=input.root+'/profile/native-deny-receipts.jsonl';const info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()||info.size>65536)throw new Error('unsafe receipt file');receipts=fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));for(const value of receipts){if(typeof value.toolName!=='string'||!/^[A-Za-z0-9:_-]{1,200}$/.test(value.toolName)||value.invocationNonce!==input.expected.invocationNonce||value.rootSha256!==input.expected.rootSha256||value.markerSha256!==null||value.profileProjectionSha256!==input.hashes.profileProjection||value.homeProjectionSha256!==input.hashes.homeProjection||value.scriptSha256!==input.hashes.script||value.stdoutSha256!==input.hashes.fixedStdout||value.stdoutCompleted!==true||value.exitCode!==2)throw new Error('invalid native deny receipt')}}
process.stdout.write(JSON.stringify({ok:true,hashes:input.hashes,audit:receipts.map(value=>value.toolName),receipts}));
`;

function withProfileGuardArtifact(source: string): string {
  const variants: Array<[string, string]> = [
    ["binding:input.root+'/profile/receipt-binding.json'};", "binding:input.root+'/profile/receipt-binding.json',profileGuard:input.root+'/profile/profile-guard.cjs',nativeApproval:input.root+'/profile/native-approval.cjs'};"],
    ["binding:input.root+'/profile/receipt-binding.json',homeHooks", "binding:input.root+'/profile/receipt-binding.json',profileGuard:input.root+'/profile/profile-guard.cjs',nativeApproval:input.root+'/profile/native-approval.cjs',homeHooks"],
    ["{label:'binding',file:explicit.binding", "{label:'profileGuard',file:explicit.profileGuard,expectedSha256:input.hashes.profileGuard,expected:input.contents.profileGuard,json:false},\n  {label:'nativeApproval',file:explicit.nativeApproval,expectedSha256:input.hashes.nativeApproval,expected:input.contents.nativeApproval,json:false},\n  {label:'binding',file:explicit.binding"],
    ["verifyFile('binding',files.binding", "verifyFile('profileGuard',files.profileGuard,input.hashes.profileGuard);verifyFile('nativeApproval',files.nativeApproval,input.hashes.nativeApproval);verifyFile('binding',files.binding"],
    ["fs.writeFileSync(explicit.binding,input.contents.binding", "fs.writeFileSync(explicit.profileGuard,input.contents.profileGuard,{flag:'wx',mode:0o600});fs.writeFileSync(explicit.nativeApproval,input.contents.nativeApproval,{flag:'wx',mode:0o600});fs.writeFileSync(input.root+'/profile/profile-guard-audit.jsonl','',{flag:'wx',mode:0o600});fs.writeFileSync(input.root+'/profile/native-approval-audit.jsonl','',{flag:'wx',mode:0o600});fs.writeFileSync(explicit.binding,input.contents.binding"],
    ["fs.writeFileSync(files.binding,input.contents.binding", "fs.writeFileSync(files.profileGuard,input.contents.profileGuard,{flag:'wx',mode:0o600});fs.writeFileSync(files.nativeApproval,input.contents.nativeApproval,{flag:'wx',mode:0o600});fs.writeFileSync(input.root+'/profile/profile-guard-audit.jsonl','',{flag:'wx',mode:0o600});fs.writeFileSync(input.root+'/profile/native-approval-audit.jsonl','',{flag:'wx',mode:0o600});fs.writeFileSync(files.binding,input.contents.binding"],
    ["value.homeProjectionSha256!==input.hashes.homeProjection||value.scriptSha256", "value.homeProjectionSha256!==input.hashes.homeProjection||value.profileGuardSha256!==input.hashes.profileGuard||value.profileChunkSha256!==input.hashes.profileChunk||value.scriptSha256"],
    ["receipt.homeProjectionSha256!==input.hashes.homeProjection||receipt.scriptSha256", "receipt.homeProjectionSha256!==input.hashes.homeProjection||receipt.profileGuardSha256!==input.hashes.profileGuard||receipt.profileChunkSha256!==input.hashes.profileChunk||receipt.scriptSha256"],
  ];
  let changes = 0;
  for (const [needle, replacement] of variants) if (source.includes(needle)) { if (source.split(needle).length !== 2) throw new Error(`profile guard artifact anchor count mismatch: ${needle}`); source = source.replace(needle, replacement); changes += 1; }
  if (changes !== 4) throw new Error(`profile guard artifact expected 4 anchors, got ${changes}`);
  return source;
}

function withCursorCacheInventory(source: string): string {
  const replacements: Array<[string, string]> = [
    ["'native-deny-receipts.jsonl'])]", "'native-deny-receipts.jsonl','profile-guard.cjs','profile-guard-audit.jsonl','native-approval.cjs','native-approval-audit.jsonl','statsig-cache.json','chats'])]"],
    ["'sandbox-policies','projects','chats'])]", "'sandbox-policies','projects','agent-cli-state.json'])]"],
    ["if(root.endsWith('/project-state')&&relative){", "if(!relative&&['statsig-cache.json','agent-cli-state.json'].includes(rel)&&(!info.isFile()||info.size>16777216||(info.mode&0o111)!==0))throw Error('controlled cache invalid '+rel);if(root.endsWith('/profile')&&relative&&!chatAllowed(rel,info))throw Error('controlled cache unexpected '+rel);if(root.endsWith('/project-state')&&relative){"],
  ];
  for (const [needle, replacement] of replacements) {
    if (source.split(needle).length !== 2) throw new Error(`Cursor cache validator anchor count mismatch: ${needle}`);
    source = source.replace(needle, replacement);
  }
  if (source.split('||chatAllowed(rel,info)').length !== 2) throw new Error('Cursor chat cache root anchor mismatch');
  source = source.replace('||chatAllowed(rel,info)', '');
  const projectAllowed = "rel==='projects'||rel==='projects/workspace'||";
  if (source.split(projectAllowed).length !== 2) throw new Error('Cursor workspace trust anchor mismatch');
  source = source.replace(projectAllowed, "rel==='projects'||rel==='projects/workspace'||['.workspace-trusted','repo.json','worker.log','worker.sock'].includes(rel.slice('projects/workspace/'.length))&&rel.startsWith('projects/workspace/')||");
  const visitEnd = ';visit(root)}};'; const lastVisitEnd = source.lastIndexOf(visitEnd);
  if (lastVisitEnd < 0) throw new Error('Cursor cache validator traversal anchor missing');
  source = `${source.slice(0, lastVisitEnd)};visit(root)}for(const rel of chatFiles)if(/store\\.db-(wal|shm)$/.test(rel)&&!chatFiles.includes(rel.replace(/-(wal|shm)$/,'')))throw Error('controlled cache orphan sqlite sidecar '+rel)};${source.slice(lastVisitEnd + visitEnd.length)}`;
  const verifyVisit = "const visit=(dir,relative='')=>{"; const verifyVisitAt = source.lastIndexOf(verifyVisit);
  if (verifyVisitAt < 0) throw new Error('Cursor strict directory traversal anchor missing');
  source = `${source.slice(0, verifyVisitAt)}const visit=(dir,relative='',depth=0)=>{${source.slice(verifyVisitAt + verifyVisit.length)}`;
  const recurse = 'if(info.isDirectory())visit(full,rel);'; const recurseAt = source.lastIndexOf(recurse);
  if (recurseAt < verifyVisitAt) throw new Error('Cursor strict directory recursion anchor missing');
  const trust = "if(rel==='projects/workspace/.workspace-trusted'){let marker;try{marker=JSON.parse(fs.readFileSync(full,'utf8'))}catch{throw Error('controlled workspace trust invalid '+rel)}if(!info.isFile()||(info.mode&0o111)!==0||info.size>512||Object.keys(marker).sort().join(',')!=='trustMethod,trustedAt,workspacePath'||marker.workspacePath!=='/workspace'||marker.trustMethod!=='cli-flag'||typeof marker.trustedAt!=='string'||marker.trustedAt.length!==24||!marker.trustedAt.endsWith('Z')||!Number.isFinite(Date.parse(marker.trustedAt)))throw Error('controlled workspace trust invalid '+rel)}if(rel==='projects/workspace/repo.json'){let repo;try{repo=JSON.parse(fs.readFileSync(full,'utf8'))}catch{throw Error('controlled repo worker invalid '+rel)}if(!info.isFile()||(info.mode&0o111)!==0||info.size>256||!repo||typeof repo!=='object'||Array.isArray(repo)||Object.keys(repo).join(',')!=='id'||typeof repo.id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(repo.id))throw Error('controlled repo worker invalid '+rel)}if(rel==='projects/workspace/worker.log'&&(!info.isFile()||(info.mode&0o111)!==0||info.size>16777216))throw Error('controlled repo worker invalid '+rel);if(rel==='projects/workspace/worker.sock'&&(!info.isSocket()||info.size!==0||(info.mode&0o600)!==0o600||(info.mode&0o022)!==0))throw Error('controlled repo worker invalid '+rel);";
  source = `${source.slice(0, recurseAt)}${trust}if(info.isDirectory()){if(depth>=8)throw Error('controlled directory depth overflow '+rel);visit(full,rel,depth+1);}${source.slice(recurseAt + recurse.length)}`;
  const invalid = "else if(!info.isFile()||info.size>16777216)";
  if (source.split(invalid).length !== 2) throw new Error('Cursor repo worker terminal-type anchor mismatch');
  source = source.replace(invalid, "else if(rel!=='projects/workspace/worker.sock'&&(!info.isFile()||info.size>16777216))");
  return source;
}

function withProfileGuardAudit(source: string): string {
  const output = 'process.stdout.write(JSON.stringify({ok:true,';
  if (source.split(output).length !== 2) throw new Error('profile guard audit output anchor mismatch');
  const audit = `let profileGuardAudit=[],nativeApprovalAudit=[];if(input.mode!=='remove'){let file=input.root+'/profile/profile-guard-audit.jsonl',info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()||info.size>65536)throw Error('unsafe profile guard audit');profileGuardAudit=fs.readFileSync(file,'utf8').split('\\n').filter(Boolean).map(line=>JSON.parse(line));if(profileGuardAudit.length>4)throw Error('profile guard audit overflow');const disabled=['enableTeamHooks','enableWorkspaceOpenHook','enableManagedSkillsSync','enableMarketplacePlugins','enableUserLocalPlugins','enableFirstPartyPlugins','enableMcp'];for(const value of profileGuardAudit)if(!value||Object.keys(value).sort().join(',')!=='chunkSha256,disabled,version'||value.version!==1||value.chunkSha256!==input.hashes.profileChunk||JSON.stringify(value.disabled)!==JSON.stringify(disabled))throw Error('invalid profile guard audit');file=input.root+'/profile/native-approval-audit.jsonl';info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()||info.size>65536)throw Error('unsafe native approval audit');nativeApprovalAudit=fs.readFileSync(file,'utf8').split('\\n').filter(Boolean).map(line=>JSON.parse(line));if(nativeApprovalAudit.length>12)throw Error('native approval audit overflow');const kinds=${JSON.stringify(CURSOR_NATIVE_APPROVAL_CASES)},marker=${JSON.stringify(sha256(CURSOR_NATIVE_APPROVAL_MARKER))};for(const value of nativeApprovalAudit)if(!value||Object.keys(value).sort().join(',')!=='constructed,firewallSha256,homeProjectionSha256,indexSha256,invocationNonce,kind,markerSha256,profileProjectionSha256,queryIdSha256,returned,rootSha256,toolCallIdSha256,version'||value.version!==1||!kinds.includes(value.kind)||![value.queryIdSha256,value.toolCallIdSha256].every(x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x))||value.markerSha256!==marker||value.invocationNonce!==input.expected.invocationNonce||value.rootSha256!==input.expected.rootSha256||value.profileProjectionSha256!==input.hashes.profileProjection||value.homeProjectionSha256!==input.hashes.homeProjection||value.firewallSha256!==input.hashes.nativeApproval||value.indexSha256!==input.hashes.entry||value.constructed!==true||value.returned!==true)throw Error('invalid native approval audit')}\n`;
  return source.replace(output, `${audit}${output.replace('{ok:true,', '{ok:true,profileGuardAudit,nativeApprovalAudit,')}`);
}

function withFixedModelProjection(source: string): string {
  const stableAnchor = source.includes('const stable=(value)=>') ? 'const stable=(value)=>' : 'const stable=value=>';
  if (source.split(stableAnchor).length !== 2) throw new Error('fixed model guest stable anchor mismatch');
  const functionSource = cursorFixedModelSelection.toString();
  const stableHead = stableAnchor.includes('(value)') ? 'const stable=(value)=>' : 'const stable=value=>';
  source = source.replace(stableAnchor, `const __name=value=>value;const fixedModel=(${functionSource});const modelKeys=${JSON.stringify(CURSOR_MODEL_CACHE_KEYS)};const modelSignatureKey=${JSON.stringify(MODEL_SIGNATURE_KEY)};${stableHead}`);
  const projection = "const projected=Object.fromEntries(Object.entries(value).filter(([key])=>!['authInfo','privacyCache'].includes(key)));";
  if (source.split(projection).length !== 2) throw new Error('fixed model guest projection anchor mismatch');
  return source.replace(projection, "if(Object.hasOwn(value,modelSignatureKey))throw Error('mutable-config-invalid '+label+' reserved-model-signature');const selection=fixedModel(value);if(!selection)throw Error('mutable-config-invalid '+label+' missing-model-selection');const projected={...Object.fromEntries(Object.entries(value).filter(([key])=>!['authInfo','privacyCache'].includes(key)&&!modelKeys.includes(key))),[modelSignatureKey]:selection};");
}

const policyOperation = withProfileGuardAudit(withFixedModelProjection(withCursorCacheInventory(withProfileGuardArtifact(policyOperationBase))));

async function verifyProfileChunkOwner(cap: CursorWriteCapabilities, signal: AbortSignal): Promise<void> {
  const target = cap.entryPath.replace(/\/index\.js$/, '/4060.index.js');
  const source = "import fs from 'node:fs';import crypto from 'node:crypto';const [target,expected]=process.argv.slice(1),info=fs.lstatSync(target),realpathMatches=fs.realpathSync(target)===target,sha256=crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'),result={uid:info.uid,mode:info.mode&0o777,file:info.isFile(),symlink:info.isSymbolicLink(),realpathMatches,sha256Matches:sha256===expected};if(!result.file||result.symlink||result.uid!==0||(result.mode&0o022)!==0||!result.realpathMatches||!result.sha256Matches)throw Error('DMW_PROFILE_CHUNK_HOST '+JSON.stringify(result));process.stdout.write(JSON.stringify(result));";
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[key] !== undefined) env[key] = process.env[key];
  const result = await runProcess({ file: 'C:\\Windows\\System32\\wsl.exe', prefixArgs: [], via: 'config' }, [
    '-d', cap.distro, '--cd', '/home/codex', '--exec', cap.nodePath, '--input-type=module', '-e', source, target, CURSOR_PROFILE_CHUNK_SHA256,
  ], { cwd: process.cwd(), env, signal, timeoutMs: 30_000, stdinText: null });
  if (result.exitCode !== 0 || result.spawnError || result.timedOut || result.cancelled || result.terminationWarning) {
    const detail = result.spawnError ?? result.terminationWarning ?? (result.stderrTail.trim().slice(-2000) || 'no helper diagnostic');
    throw new Error(`Grok profile chunk host validation failed (exit=${String(result.exitCode)}, timedOut=${result.timedOut}, cancelled=${result.cancelled}): ${detail}`);
  }
}

/** New chat policy/cleanup only. Auth mounts and process control stay in the verified bridge. */
export class SystemWslCursorDenyBridge extends SystemWslCursorWriterBridge {
  private readonly dispatchedRoots = new Set<string>();
  private async policyOperation(cap: CursorWriteCapabilities, root: string, mode: 'policy' | 'inspect' | 'audit' | 'remove', signal: AbortSignal): Promise<CursorDenyPolicyResult> {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[key] !== undefined) env[key] = process.env[key];
    const artifacts = cursorDenyProfileArtifacts(cap, root); const binding = JSON.parse(artifacts.binding) as { invocationNonce: string; rootSha256: string };
    const result = await runProcess({ file: 'C:\\Windows\\System32\\wsl.exe', prefixArgs: [], via: 'config' }, ['-d', cap.distro, '--cd', '/home/codex', '--exec', cap.nodePath, '--input-type=module', '-e', policyOperation], {
      cwd: process.cwd(), env, signal, timeoutMs: 30_000,
      stdinText: JSON.stringify({ root, mode, contents: artifacts, hashes: artifacts.hashes, expected: binding }),
    });
    if (result.exitCode !== 0 || result.spawnError || result.timedOut || result.cancelled || result.terminationWarning) {
      const detail = result.spawnError ?? result.terminationWarning ?? (result.stderrTail.trim().slice(-2000) || 'no helper diagnostic');
      throw new Error(`Grok 临时策略、hook 或目录操作未完成（mode=${mode}, exit=${String(result.exitCode)}, timedOut=${result.timedOut}, cancelled=${result.cancelled}）：${detail}`);
    }
    const parsed = parseCursorPolicyHelperOutput(mode, result.stdoutTail, artifacts.hashes);
    if (mode !== 'remove' && this.dispatchedRoots.has(root) && parsed.profileGuardAudit.length !== 1) throw new Error(`profile_guard_audit_count root=${sha256(root)} count=${parsed.profileGuardAudit.length}`);
    return parsed;
  }
  override async setup(...args: Parameters<CursorWriterBridge['setup']>): Promise<void> {
    if (args[2].length) throw new Error('Grok deny_all 工作区必须为空');
    await verifyProfileChunkOwner(args[0], args[3]);
    await super.setup(...args);
    await this.policyOperation(args[0], args[1], 'policy', args[3]);
  }
  override async inspect(...args: Parameters<CursorWriterBridge['inspect']>): Promise<CursorWriterSnapshot> {
    await this.policyOperation(args[0], args[1], 'inspect', args[2]);
    return super.inspect(...args);
  }
  nativeAudit(capabilities: CursorWriteCapabilities, root: string, signal: AbortSignal): Promise<CursorDenyPolicyResult> {
    return this.policyOperation(capabilities, root, 'audit', signal);
  }
  nativeApprovalEvidence(capabilities: CursorWriteCapabilities, root: string, signal: AbortSignal): Promise<CursorDenyPolicyResult> {
    return this.policyOperation(capabilities, root, 'audit', signal);
  }
  override run(...args: Parameters<CursorWriterBridge['run']>): ReturnType<CursorWriterBridge['run']> { this.dispatchedRoots.add(args[1].root); return runCursorReadonlyRuntime('deny', ...args); }
  override async cleanup(...args: Parameters<CursorWriterBridge['cleanup']>): Promise<void> {
    // The base bridge first refuses cleanup while any marked process remains.
    await super.cleanup(...args);
    await this.policyOperation(args[0], args[1], 'remove', args[3]);
    this.dispatchedRoots.delete(args[1]);
  }
}

/** Compatibility alias: paired negative uses the exact production marker/output. */
export const CURSOR_HOOK_PROOF_MARKER = CURSOR_NATIVE_DENY_MARKER;

export interface CursorHookReceiptBinding { mode: 'control' | 'deny'; invocationNonce: string; marker: string }
export interface CursorHookReceipt {
  invocationNonce: string; rootSha256: string; markerSha256: string | null; toolName: string;
  profileProjectionSha256: string; homeProjectionSha256: string; profileGuardSha256: string; profileChunkSha256: string;
  scriptSha256: string; stdoutSha256: string; stdoutCompleted: boolean; exitCode: number;
}
export interface CursorScopeAuditEntry {
  toolName: string; toolInputShape: unknown; allowed: boolean; urlMatches: boolean; queryMatches: boolean;
}
export interface CursorHookProofArtifacts {
  projectPolicy: string; profileConfig: string; hooks: string; script: string; scopeGuard: string; profileGuard: string; nativeApproval: string; binding: string; fixedStdout: string;
  hashes: { projectPolicy: string; profileConfig: string; profileProjection: string; homeProjection: string; hooks: string; script: string; scopeGuard: string; profileGuard: string; profileChunk: string; nativeApproval: string; entry: string; binding: string; fixedStdout: string };
}

/** Test-only paired-control material. It is intentionally separate from the production deny bridge. */
export function cursorHookProofArtifacts(capabilities: CursorWriteCapabilities, root: string, receipt: CursorHookReceiptBinding): CursorHookProofArtifacts {
  if (!/^\/opt\/cursor-agent\/versions\/[^/]+\/node$/.test(capabilities.nodePath)) throw new Error('paired hook Node path is outside the trusted fixed-version directory');
  if (!/^\/home\/codex\/\.dual-model-workbench\/writer-[a-f0-9-]{36}$/.test(root)) throw new Error('invalid paired hook root');
  if (!/^[a-f0-9-]{16,128}$/.test(receipt.invocationNonce) || !/^DMW_CURSOR_[A-F0-9_]+$/.test(receipt.marker)) throw new Error('invalid paired hook binding');
  const policy = { permissions: {
    allow: ['WebFetch(*)', 'WebSearch(*)'], deny: ['Read(**)', 'Write(**)', 'Shell(*)', 'Mcp(*:*)'],
  } };
  const projectPolicy = `${JSON.stringify(policy, null, 2)}\n`;
  const profileConfig = materializedProfileConfig(policy, true);
  const fixedStdout = JSON.stringify({ permission: 'deny', user_message: CURSOR_NATIVE_DENY_MARKER, agent_message: NATIVE_DENY_AGENT_MESSAGE });
  const script = bindProfileGuardReceipt(canonicalDenyScript(fixedStdout)); const profileGuard = cursorProfileGuardSource(capabilities); const profileGuardSha256 = sha256(profileGuard);
  const nativeApproval = cursorNativeApprovalSource(capabilities); const nativeApprovalSha256 = sha256(nativeApproval);
  const scopeGuard = `import fs from 'node:fs';\nimport { fileURLToPath } from 'node:url';\nconst chunks=[];let bytes=0;for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>1048576)break;chunks.push(chunk)}\nconst auditFile=fileURLToPath(new URL('./scope-guard-audit.jsonl',import.meta.url));const info=fs.lstatSync(auditFile);if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()||info.size>65536)throw new Error('unsafe scope audit');\nlet allowed=false,toolName='INVALID',toolInputShape={type:'missing'},urlMatches=false,queryMatches=false;const shape=(value,depth=0,state={keys:0})=>{const type=value===null?'null':Array.isArray(value)?'array':typeof value;if(depth>=3||value===null||typeof value!=='object')return{type};if(Array.isArray(value))return{type,items:value.length?shape(value[0],depth+1,state):null};const keys=[];for(const key of Object.keys(value).sort()){if(state.keys>=32)break;state.keys++;keys.push({key,typeShape:shape(value[key],depth+1,state)})}return{type,keys}};try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(typeof value?.tool_name==='string'&&/^[A-Za-z0-9:_-]{1,200}$/.test(value.tool_name))toolName=value.tool_name;toolInputShape=shape(value?.tool_input);let normalizedUrl=null;try{normalizedUrl=new URL(value?.tool_input?.url).href}catch{}urlMatches=normalizedUrl==='https://example.com/';queryMatches=value?.tool_input?.searchTerm==='OpenAI official documentation';allowed=toolName==='WebFetch'&&urlMatches||toolName==='WebSearch'&&queryMatches}catch{}\nconst line=JSON.stringify({toolName,toolInputShape,allowed,urlMatches,queryMatches})+'\\n';if(info.size+Buffer.byteLength(line)>65536)throw new Error('scope audit overflow');fs.appendFileSync(auditFile,line);\nprocess.stdout.write(JSON.stringify(allowed?{permission:'allow'}:{permission:'deny',user_message:'DMW_PAIRED_SCOPE_DENY_V1',agent_message:'Only the fixed public paired-proof targets are allowed.'}));\nprocess.exitCode=allowed?0:2;\n`;
  const profileProjection = cursorMutableConfigProjectionSha256(JSON.parse(profileConfig));
  const binding = `${JSON.stringify({ invocationNonce: receipt.invocationNonce, rootSha256: sha256(root), markerSha256: sha256(receipt.marker), profileProjectionSha256: profileProjection,
    homeProjectionSha256: profileProjection, profileGuardSha256, profileChunkSha256: CURSOR_PROFILE_CHUNK_SHA256, nativeApprovalSha256, entrySha256: CURSOR_ENTRY_SHA256 }, null, 2)}\n`;
  const scopeHook = { type: 'command', command: `${posixQuote(capabilities.nodePath)} '/cursor-profile/scope-guard.mjs'`, matcher: '.*', timeout: 5, failClosed: true };
  const denyHook = { type: 'command', command: `${posixQuote(capabilities.nodePath)} '/cursor-profile/deny-native.mjs'`, matcher: '.*', timeout: 5, failClosed: true };
  const hooks = `${JSON.stringify({ version: 1, hooks: { preToolUse: receipt.mode === 'deny' ? [scopeHook, denyHook] : [scopeHook] } }, null, 2)}\n`;
  return { projectPolicy, profileConfig, hooks, script, scopeGuard, profileGuard, nativeApproval, binding, fixedStdout, hashes: {
    projectPolicy: sha256(projectPolicy), profileConfig: sha256(profileConfig), profileProjection, homeProjection: profileProjection, hooks: sha256(hooks), script: sha256(script),
    scopeGuard: sha256(scopeGuard), profileGuard: profileGuardSha256, profileChunk: CURSOR_PROFILE_CHUNK_SHA256, nativeApproval: nativeApprovalSha256, entry: CURSOR_ENTRY_SHA256, binding: sha256(binding), fixedStdout: sha256(fixedStdout),
  } };
}

type CursorProjectionDiagnostic = { path: string; beforeType: string; afterType: string; beforeHmac: string; afterHmac: string };
type CursorHookProofResult = { ok: true; receipts: CursorHookReceipt[]; scopeAudit: CursorScopeAuditEntry[]; directorySummary: Array<{ root: string; path: string; type: string; size?: number; mode: number; isSocket: boolean; ownerMatches: boolean }>;
  inventoryTruncated: boolean; inventoryOverflowPaths: string[]; projectionDiagnostics: CursorProjectionDiagnostic[]; diagnosticsTruncated: boolean; profileGuardAudit: CursorProfileGuardAudit[]; nativeApprovalAudit: CursorNativeApprovalAudit[]; hashes: CursorHookProofArtifacts['hashes'] };
const hookProofOperationBase = String.raw`
import fs from 'node:fs';import crypto from 'node:crypto';const chunks=[];for await(const c of process.stdin)chunks.push(c);const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
if(!/^\/home\/codex\/\.dual-model-workbench\/writer-[a-f0-9-]{36}$/.test(input.root))throw Error('invalid proof root');
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');const files={projectPolicy:input.root+'/workspace/.cursor/cli.json',profileConfig:input.root+'/profile/cli-config.json',hooks:input.root+'/profile/hooks.json',script:input.root+'/profile/deny-native.mjs',scopeGuard:input.root+'/profile/scope-guard.mjs',scopeAudit:input.root+'/profile/scope-guard-audit.jsonl',binding:input.root+'/profile/receipt-binding.json',homeHooks:input.root+'/project-state/hooks.json',homeProfileConfig:input.root+'/project-state/cli-config.json'};
const verifyFile=(label,file,expected)=>{const info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()||digest(file)!==expected)throw Error('paired artifact drift '+label)};
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;const project=(label,file,expected)=>{const info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid())throw Error('paired mutable config type drift '+label);let value;try{value=JSON.parse(fs.readFileSync(file,'utf8'))}catch{throw Error('paired mutable config parse failure '+label)}if(!value||typeof value!=='object'||Array.isArray(value))throw Error('paired mutable config root '+label);if(Object.hasOwn(value,'authInfo')){const x=value.authInfo;if(!x||typeof x!=='object'||Array.isArray(x))throw Error('paired mutable authInfo '+label);for(const [key,field] of Object.entries(x)){const stringKey=['email','displayName','teamName','authId','organizationId'].includes(key),numberKey=['teamId','userId','activeTeamId'].includes(key);if(stringKey?typeof field!=='string':numberKey?!(typeof field==='number'&&Number.isFinite(field)):true)throw Error('paired mutable authInfo field '+label+'/'+key)}}if(Object.hasOwn(value,'privacyCache')){const x=value.privacyCache;if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).some(key=>!['ghostMode','privacyMode','updatedAt'].includes(key))||typeof x.ghostMode!=='boolean'||(x.privacyMode!==undefined&&!(typeof x.privacyMode==='number'&&Number.isFinite(x.privacyMode)))||!(typeof x.updatedAt==='number'&&Number.isFinite(x.updatedAt)))throw Error('paired mutable privacyCache '+label)}const projected=Object.fromEntries(Object.entries(value).filter(([key])=>!['authInfo','privacyCache'].includes(key)));const actual=crypto.createHash('sha256').update(JSON.stringify(stable(projected))).digest('hex');if(actual!==expected)throw Error('paired mutable projection drift '+JSON.stringify({label,projectionSha256:actual,expectedProjectionSha256:expected,fields:Object.keys(value).sort()}))};
const directorySummary=[];const inventoryTrees=()=>{directorySummary.length=0;let count=0;for(const [root,label] of [[input.root+'/workspace','workspace'],[input.root+'/profile','profile'],[input.root+'/project-state','project-state']]){const visit=(dir,relative='',depth=0)=>{if(depth>8)throw Error('paired inventory depth overflow');for(const name of fs.readdirSync(dir).sort()){if(++count>256)throw Error('paired inventory count overflow');const rel=relative?relative+'/'+name:name,full=dir+'/'+name,info=fs.lstatSync(full),type=info.isSymbolicLink()?'symlink':info.isDirectory()?'directory':info.isFile()?'file':'other';directorySummary.push({root:label,path:rel,type,...info.isFile()?{size:info.size}:{},ownerMatches:info.uid===process.getuid()});if(info.isDirectory()&&!info.isSymbolicLink())visit(full,rel,depth+1)}};visit(root)}};const verifyTrees=()=>{inventoryTrees();const roots=[[input.root+'/workspace',new Set(['.cursor'])],[input.root+'/profile',new Set(['cli-config.json','hooks.json','deny-native.mjs','scope-guard.mjs','scope-guard-audit.jsonl','receipt-binding.json','native-deny-receipts.jsonl'])],[input.root+'/project-state',new Set(['cli-config.json','hooks.json','.gitignore','sandbox-policies','projects','chats'])]];const bucket=crypto.createHash('md5').update('/workspace').digest('hex'),sessions=new Set,chatFiles=[];const chatAllowed=(rel,info)=>{if(rel==='chats'||rel==='chats/'+bucket)return info.isDirectory();const session=/^chats\/([a-f0-9]{32})\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(rel);if(session){if(session[1]!==bucket||!info.isDirectory())return false;sessions.add(session[2].toLowerCase());return sessions.size<=4}const file=/^chats\/([a-f0-9]{32})\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/(store\.db(?:-wal|-shm)?|meta\.json|prompt_history\.json|pasted_text\.json)$/i.exec(rel);if(!file||file[1]!==bucket||!sessions.has(file[2].toLowerCase())||!info.isFile()||info.size>16777216||(info.mode&0o111)!==0)return false;chatFiles.push(rel);return chatFiles.length<=32};for(const [root,top] of roots){const visit=(dir,relative='')=>{for(const name of fs.readdirSync(dir).sort()){const rel=relative?relative+'/'+name:name,full=dir+'/'+name,info=fs.lstatSync(full);if(info.isSymbolicLink()||info.uid!==process.getuid())throw Error('paired controlled directory drift '+rel);if(!relative&&!top.has(name))throw Error('paired controlled directory unexpected '+rel);if(root.endsWith('/workspace')&&relative&&!['.cursor','.cursor/cli.json'].includes(rel))throw Error('paired controlled directory unexpected '+rel);if(root.endsWith('/project-state')&&relative){const allowed=rel==='sandbox-policies'||/^sandbox-policies\/sandbox-policy-[a-f0-9]+$/.test(rel)||rel==='projects'||rel==='projects/workspace'||/^projects\/workspace\/(agent-transcripts|terminals|agent-notes|agent-tools|subagents)(\/[A-Za-z0-9._-]{1,128}){0,4}$/.test(rel)||chatAllowed(rel,info);if(!allowed)throw Error('paired controlled directory unexpected '+rel)}if(info.isDirectory())visit(full,rel);else if(!info.isFile()||info.size>16777216)throw Error('paired controlled directory invalid '+rel)}};visit(root)}};
const verify=()=>{verifyFile('projectPolicy',files.projectPolicy,input.hashes.projectPolicy);verifyFile('hooks',files.hooks,input.hashes.hooks);verifyFile('script',files.script,input.hashes.script);verifyFile('scopeGuard',files.scopeGuard,input.hashes.scopeGuard);verifyFile('binding',files.binding,input.hashes.binding);verifyFile('homeHooks',files.homeHooks,input.hashes.hooks);project('profileConfig',files.profileConfig,input.hashes.profileProjection);project('homeProfileConfig',files.homeProfileConfig,input.hashes.homeProjection);verifyTrees()};
if(input.mode==='setup'){for(const relative of ['workspace','workspace/.cursor','profile','project-state']){const info=fs.lstatSync(input.root+'/'+relative);if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid())throw Error('unsafe proof directory')}fs.writeFileSync(files.projectPolicy,input.contents.projectPolicy,{mode:0o600});fs.writeFileSync(files.profileConfig,input.contents.profileConfig,{mode:0o600});fs.writeFileSync(files.hooks,input.contents.hooks,{flag:'wx',mode:0o600});fs.writeFileSync(files.script,input.contents.script,{flag:'wx',mode:0o700});fs.writeFileSync(files.scopeGuard,input.contents.scopeGuard,{flag:'wx',mode:0o700});fs.writeFileSync(files.scopeAudit,'',{flag:'wx',mode:0o600});fs.writeFileSync(files.binding,input.contents.binding,{flag:'wx',mode:0o600});fs.writeFileSync(input.root+'/profile/native-deny-receipts.jsonl','',{flag:'wx',mode:0o600});fs.writeFileSync(files.homeHooks,input.contents.hooks,{flag:'wx',mode:0o600});fs.writeFileSync(files.homeProfileConfig,input.contents.profileConfig,{flag:'wx',mode:0o600});verify()}
else if(input.mode==='inspect'||input.mode==='receipts')verify();else if(input.mode==='inventory')inventoryTrees();else if(input.mode==='remove')fs.rmSync(input.root,{recursive:true,force:false});else throw Error('invalid proof operation');
let receipts=[];if(input.mode!=='remove'){const file=input.root+'/profile/native-deny-receipts.jsonl';const info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()||info.size>65536)throw Error('unsafe proof receipts');receipts=fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));for(const receipt of receipts){if(receipt.invocationNonce!==input.expected.invocationNonce||receipt.rootSha256!==input.expected.rootSha256||receipt.markerSha256!==input.expected.markerSha256||receipt.profileProjectionSha256!==input.hashes.profileProjection||receipt.homeProjectionSha256!==input.hashes.homeProjection||receipt.scriptSha256!==input.hashes.script||receipt.stdoutSha256!==input.hashes.fixedStdout||receipt.stdoutCompleted!==true||receipt.exitCode!==2||!['WebFetch','WebSearch'].includes(receipt.toolName))throw Error('invalid paired receipt')}}
let scopeAudit=[];if(input.mode!=='remove'){const info=fs.lstatSync(files.scopeAudit);if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()||info.size>65536)throw Error('unsafe scope audit');scopeAudit=fs.readFileSync(files.scopeAudit,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));if(scopeAudit.length>32)throw Error('scope audit count overflow');const validShape=(value,depth=0)=>{if(!value||typeof value!=='object'||Array.isArray(value)||!['null','array','object','string','number','boolean','undefined'].includes(value.type))return false;if(depth>=3)return Object.keys(value).length===1;if(value.type==='object')return Array.isArray(value.keys)&&value.keys.length<=32&&value.keys.every(item=>item&&typeof item.key==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(item.key)&&validShape(item.typeShape,depth+1));if(value.type==='array')return value.items===null||validShape(value.items,depth+1);return Object.keys(value).length===1};for(const entry of scopeAudit)if(!entry||typeof entry.toolName!=='string'||!(/^[A-Za-z0-9:_-]{1,200}$/.test(entry.toolName))||!validShape(entry.toolInputShape)||typeof entry.allowed!=='boolean'||typeof entry.urlMatches!=='boolean'||typeof entry.queryMatches!=='boolean'||Object.keys(entry).sort().join(',')!=='allowed,queryMatches,toolInputShape,toolName,urlMatches')throw Error('invalid scope audit entry')}
process.stdout.write(JSON.stringify({ok:true,receipts,scopeAudit,directorySummary,hashes:input.hashes}));`;
function withBoundedProofInventory(source: string): string {
  const start = 'const directorySummary=[];const inventoryTrees=()=>{'; const end = ';const verifyTrees=()=>{';
  const startAt = source.indexOf(start); const endAt = source.indexOf(end, startAt);
  if (startAt < 0 || endAt < 0) throw new Error('paired inventory anchors missing');
  let replacement = `const directorySummary=[];let inventoryTruncated=false;const inventoryOverflowPaths=[];const inventoryTrees=()=>{directorySummary.length=0;inventoryTruncated=false;inventoryOverflowPaths.length=0;let count=0;const bucket=crypto.createHash('md5').update('/workspace').digest('hex');const approvedDirectory=(label,rel)=>label==='workspace'?rel==='.cursor':label==='profile'?false:rel==='sandbox-policies'||rel==='projects'||rel==='projects/workspace'||/^projects\\/workspace\\/(agent-transcripts|terminals|agent-notes|agent-tools|subagents)(\\/[A-Za-z0-9._-]{1,128}){0,4}$/.test(rel)||rel==='chats'||rel==='chats/'+bucket||new RegExp('^chats/'+bucket+'/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$','i').test(rel);for(const [root,label] of [[input.root+'/workspace','workspace'],[input.root+'/profile','profile'],[input.root+'/project-state','project-state']]){const visit=(dir,relative='',depth=0)=>{for(const name of fs.readdirSync(dir).sort()){const rel=relative?relative+'/'+name:name,full=dir+'/'+name,info=fs.lstatSync(full),type=info.isSymbolicLink()?'symlink':info.isDirectory()?'directory':info.isFile()?'file':'other';if(count>=256){inventoryTruncated=true;inventoryOverflowPaths.push(label+':'+rel);continue}count++;directorySummary.push({root:label,path:rel,type,...info.isFile()?{size:info.size}:{},mode:info.mode&0o777,isSocket:info.isSocket(),ownerMatches:info.uid===process.getuid()});if(info.isDirectory()&&!info.isSymbolicLink()&&approvedDirectory(label,rel)){if(depth>=8){inventoryTruncated=true;inventoryOverflowPaths.push(label+':'+rel)}else visit(full,rel,depth+1)}}};visit(root)}}`;
  const descent = "if(info.isDirectory()&&!info.isSymbolicLink()&&approvedDirectory(label,rel)){if(depth>=8){inventoryTruncated=true;inventoryOverflowPaths.push(label+':'+rel)}else visit(full,rel,depth+1)}";
  replacement = replacement.replace(descent, "if(info.isDirectory()&&!info.isSymbolicLink()){if(!approvedDirectory(label,rel)||depth>=8){inventoryTruncated=true;inventoryOverflowPaths.push(label+':'+rel)}else visit(full,rel,depth+1)}");
  replacement = replacement.replace("||rel==='chats'||rel==='chats/'+bucket||new RegExp('^chats/'+bucket+'/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$','i').test(rel)", () => "||rel==='projects/workspace/.workspace-trusted'");
  replacement = replacement.replace("label==='profile'?false:", () => "label==='profile'?rel==='chats'||rel==='chats/'+bucket||new RegExp('^chats/'+bucket+'/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$','i').test(rel):");
  if (!replacement.includes('!approvedDirectory(label,rel)')) throw new Error('paired bounded inventory descent anchor mismatch');
  source = `${source.slice(0, startAt)}${replacement}${source.slice(endAt)}`;
  const branch = "if(input.mode==='setup'){";
  if (source.split(branch).length !== 2) throw new Error('paired projection diagnostic branch anchor mismatch');
  const diagnostic = `let projectionDiagnostics=[],diagnosticsTruncated=false;const diagnosticProjection=(label,file,expectedText)=>{const omit=value=>Object.fromEntries(Object.entries(value).filter(([key])=>!['authInfo','privacyCache'].includes(key)));const before=omit(JSON.parse(expectedText)),after=omit(JSON.parse(fs.readFileSync(file,'utf8'))),key=crypto.randomBytes(32),kind=value=>value===undefined?'missing':value===null?'null':Array.isArray(value)?'array':typeof value,hmac=value=>crypto.createHmac('sha256',key).update(JSON.stringify(stable(value))??'undefined').digest('hex'),escape=value=>value.replaceAll('~','~0').replaceAll('/','~1');const walk=(a,b,path,depth=0)=>{if(JSON.stringify(stable(a))===JSON.stringify(stable(b)))return;if(projectionDiagnostics.length>=128||depth>=12){diagnosticsTruncated=true;return}const ta=kind(a),tb=kind(b);if(ta==='object'&&tb==='object'||ta==='array'&&tb==='array'){const keys=new Set([...Object.keys(a),...Object.keys(b)]);for(const child of [...keys].sort())walk(a[child],b[child],path+'/'+escape(child),depth+1);return}projectionDiagnostics.push({path:label+path,beforeType:ta,afterType:tb,beforeHmac:hmac(a),afterHmac:hmac(b)})};walk(before,after,'')};`;
  source = source.replace(branch, `${diagnostic}${branch}`);
  const modes = "else if(input.mode==='inspect'||input.mode==='receipts')verify();else if(input.mode==='inventory')inventoryTrees();";
  if (source.split(modes).length !== 2) throw new Error('paired projection diagnostic mode anchor mismatch');
  source = source.replace(modes, "else if(input.mode==='inspect'||input.mode==='receipts')verify();else if(input.mode==='inventory')inventoryTrees();else if(input.mode==='diagnostics'){inventoryTrees();diagnosticProjection('/profileConfig',files.profileConfig,input.contents.profileConfig);diagnosticProjection('/homeProfileConfig',files.homeProfileConfig,input.contents.profileConfig);}");
  const output = 'directorySummary,hashes:input.hashes';
  if (source.split(output).length !== 2) throw new Error('paired inventory output anchor mismatch');
  return source.replace(output, 'directorySummary,inventoryTruncated,inventoryOverflowPaths,projectionDiagnostics,diagnosticsTruncated,hashes:input.hashes');
}

const hookProofOperation = withProfileGuardAudit(withBoundedProofInventory(withFixedModelProjection(withCursorCacheInventory(withProfileGuardArtifact(hookProofOperationBase)))));

/** Test-only bridge for the explicitly approved causal paired-control proof. */
export class SystemWslCursorHookProofBridge extends SystemWslCursorWriterBridge {
  private readonly dispatchedRoots = new Set<string>();
  constructor(private readonly receipt: CursorHookReceiptBinding) { super(); }
  private async operation(cap: CursorWriteCapabilities, root: string, mode: 'setup' | 'inspect' | 'receipts' | 'inventory' | 'diagnostics' | 'remove', signal: AbortSignal): Promise<CursorHookProofResult> {
    const env: NodeJS.ProcessEnv = {}; for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[key] !== undefined) env[key] = process.env[key];
    const artifacts = cursorHookProofArtifacts(cap, root, this.receipt);
    const result = await runProcess({ file: 'C:\\Windows\\System32\\wsl.exe', prefixArgs: [], via: 'config' }, ['-d', cap.distro, '--cd', '/home/codex', '--exec', cap.nodePath, '--input-type=module', '-e', hookProofOperation], {
      cwd: process.cwd(), env, signal, timeoutMs: 30_000, stdinText: JSON.stringify({ root, mode, contents: artifacts, hashes: artifacts.hashes, expected: {
        invocationNonce: this.receipt.invocationNonce, rootSha256: sha256(root), markerSha256: sha256(this.receipt.marker),
      } }),
    });
    if (result.exitCode !== 0 || result.spawnError || result.timedOut || result.cancelled || result.terminationWarning) throw new Error(`paired hook operation failed mode=${mode} exit=${String(result.exitCode)}: ${result.spawnError ?? result.terminationWarning ?? result.stderrTail.trim().slice(-2000)}`);
    let parsed: CursorHookProofResult; try { parsed = JSON.parse(result.stdoutTail) as CursorHookProofResult; } catch { throw new Error(`paired_helper_stdout_parse_failure mode=${mode} size=${Buffer.byteLength(result.stdoutTail)} sha256=${sha256(result.stdoutTail)}`); }
    if (parsed.ok !== true || JSON.stringify(parsed.hashes) !== JSON.stringify(artifacts.hashes) || !Array.isArray(parsed.receipts) || !Array.isArray(parsed.scopeAudit)
      || !Array.isArray(parsed.directorySummary) || parsed.directorySummary.some(value => !value || typeof value.root !== 'string' || typeof value.path !== 'string'
        || !Number.isInteger(value.mode) || value.mode < 0 || value.mode > 0o777 || typeof value.isSocket !== 'boolean' || typeof value.ownerMatches !== 'boolean'
        || !['file', 'directory', 'symlink', 'other'].includes(value.type) || (value.size !== undefined && !(Number.isInteger(value.size) && value.size >= 0)))
      || typeof parsed.inventoryTruncated !== 'boolean' || !Array.isArray(parsed.inventoryOverflowPaths)
      || parsed.inventoryOverflowPaths.some(value => typeof value !== 'string' || value.length > 512) || !Array.isArray(parsed.projectionDiagnostics)
      || !Array.isArray(parsed.profileGuardAudit) || !Array.isArray(parsed.nativeApprovalAudit)
      || typeof parsed.diagnosticsTruncated !== 'boolean' || parsed.projectionDiagnostics.some(value => !value || typeof value.path !== 'string' || value.path.length > 1024
        || !['missing', 'null', 'array', 'object', 'string', 'number', 'boolean'].includes(value.beforeType)
        || !['missing', 'null', 'array', 'object', 'string', 'number', 'boolean'].includes(value.afterType)
        || !/^[a-f0-9]{64}$/.test(value.beforeHmac) || !/^[a-f0-9]{64}$/.test(value.afterHmac))) throw new Error(`paired_helper_contract_failure mode=${mode}`);
    if (mode !== 'remove' && this.dispatchedRoots.has(root) && parsed.profileGuardAudit.length !== 1) throw new Error(`paired_profile_guard_audit_count root=${sha256(root)} count=${parsed.profileGuardAudit.length}`);
    return parsed;
  }
  override async setup(...args: Parameters<CursorWriterBridge['setup']>): Promise<void> { if (args[2].length) throw new Error('paired hook workspace must be empty'); await verifyProfileChunkOwner(args[0], args[3]); await super.setup(...args); await this.operation(args[0], args[1], 'setup', args[3]); }
  override async inspect(...args: Parameters<CursorWriterBridge['inspect']>): Promise<CursorWriterSnapshot> { await this.operation(args[0], args[1], 'inspect', args[2]); return super.inspect(...args); }
  receipts(capabilities: CursorWriteCapabilities, root: string, signal: AbortSignal): Promise<CursorHookProofResult> { return this.operation(capabilities, root, 'receipts', signal); }
  scopeAudit(capabilities: CursorWriteCapabilities, root: string, signal: AbortSignal): Promise<CursorHookProofResult> { return this.operation(capabilities, root, 'receipts', signal); }
  inventory(capabilities: CursorWriteCapabilities, root: string, signal: AbortSignal): Promise<CursorHookProofResult> { return this.operation(capabilities, root, 'inventory', signal); }
  diagnostics(capabilities: CursorWriteCapabilities, root: string, signal: AbortSignal): Promise<CursorHookProofResult> { return this.operation(capabilities, root, 'diagnostics', signal); }
  override run(...args: Parameters<CursorWriterBridge['run']>): ReturnType<CursorWriterBridge['run']> { this.dispatchedRoots.add(args[1].root); return runCursorReadonlyRuntime('paired', ...args); }
  override async cleanup(...args: Parameters<CursorWriterBridge['cleanup']>): Promise<void> { await super.cleanup(...args); await this.operation(args[0], args[1], 'remove', args[3]); this.dispatchedRoots.delete(args[1]); }
}
