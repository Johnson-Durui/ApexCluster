import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod/v4';
import type { WorkbenchConfig } from '../config.js';
import { resolveCommand, scrubEnv, type ResolvedCommand } from '../adapters/process.js';
import type { CapabilityCall, CapabilityReply, CapabilityStatus, ChatCapabilityHost, ProducedFile } from './capability-contract.js';
import { CODEX_MEDIA_PROFILE, buildCodexDiscoveryArgs, buildCodexMediaIsolationArgs, parseCodexIsolationMetadata, validateCodexMediaIsolation, type CodexInventory } from './codex-policy.js';
import { ChatDriverError, CodexAppServer, codexInventory, codexPages, validateVersionResult } from './drivers.js';
import { loadChatWindowsJobSupervisorAssets, runChatWindowsJobProcess } from './windows-job-process.js';
import type { AgentTask, ChatAttachment, ChatRecord, ToolDefinition } from './types.js';
import type { ExtensionConfig } from './extensions/config.js';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MEDIA_LINE_BYTES = 32 * 1024 * 1024;
export const NATIVE_MEDIA_POLICY = 'codex-native-media-job-v1';
export const NATIVE_MEDIA_CODEX_VERSION = 'codex-cli 0.165.0-alpha.1.2';
export const NATIVE_MEDIA_REQUIRED_TESTS = ['readVerified','generateVerified','editVerified','cancellationConfirmed','normalExitTreeVerified','windowsJobTreeVerified','imageDecodeVerified','inputHashVerified','workspaceBoundaryVerified','nativeSurfaceVerified'] as const;
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type:'object', properties, required, additionalProperties:false });
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const moduleFile = fileURLToPath(import.meta.url);
const nativeMediaInput = z.object({ fileId:z.string().min(1).max(100), prompt:z.string().min(1).max(10_000) }).strict();
const nativeMediaGenerate = z.object({ prompt:z.string().min(1).max(10_000), size:z.enum(['1024x1024','1536x1024','1024x1536']).default('1024x1024'), referenceFileId:z.string().min(1).max(100).optional() }).strict();
export type NativeMediaOperation = { kind:'read'|'generate'|'edit'; prompt:string; size?:string; input?: { name:string; mime:string; bytes:Buffer; sha256:string } };
export type NativeMediaPhase = 'turn-requested'|'turn-started'|'image-started';
export type NativeMediaRunOptions = {scratchRoot:string;signal:AbortSignal;timeoutMs:number;onPhase?:(phase:NativeMediaPhase)=>void};
type NativeMediaInternalRunOptions = NativeMediaRunOptions & {preflightOnly:boolean};
export type NativeMediaInvocationEvidence = {
  version:string; model:string; effort:string; threadId:string; turnId:string;
  nativeCliInvocations:0|1; appServerProcessCount:number; turnRequested:boolean; imageGenerationStarted:number; imageGenerationCompleted:number;
  imageGenerationStartedIds:string[];
  preflightPolicyVerified:boolean; threadPolicyVerified:boolean;
  discoveryInventory:CodexInventory|null;
  preflightPolicy:unknown|null; threadPolicy:unknown|null;
  observedInputImages:Array<{path:string;sha256:string}>;
  stagedInput:{path:string;sha256:string}|null;
  workspaceRoot:string; inputRoot:string; outputRoot:string;
  outputBinding:'fixed-codex-cache/thread-and-call-id';
  jobEvidence:unknown[]; scratch:string|null;
};
export type NativeMediaInvocationResult = { text:string; image?:Buffer; sourceHash?:string; exitConfirmed:boolean; finishReason:'completed'|'cancelled'|'failed'|'exit_unknown'; evidence:NativeMediaInvocationEvidence };
export type NativeMediaProof = { schema:'dual-model-workbench/native-codex-media-proof/v1'; verifiedAt:string; version:string; fingerprint:string; policy:typeof NATIVE_MEDIA_POLICY; model:string; effort:string; verified:true; isolationVerified:true; tests:Record<(typeof NATIVE_MEDIA_REQUIRED_TESTS)[number],true> };
export type NativeMediaNotificationState = {threadId:string;turnId:string;startedImages:number;startedImageIds:Set<string>;completedItems:any[]};

export interface NativeCodexMediaOptions {
  config: WorkbenchConfig;
  proofFile: string;
  scratchRoot: string;
  settings: () => ExtensionConfig['media']['codex'] | undefined;
  readFile: (chat:ChatRecord,fileId:string)=>{metadata:ChatAttachment;bytes:Buffer};
  inspectImage: (file:{name:string;mime:string;bytes:Buffer},signal:AbortSignal)=>Promise<{mime:'image/png'|'image/jpeg'|'image/webp';width:number;height:number}>;
  invoke?: typeof runQualifiedNativeCodexMedia;
  /** Deterministic unit-test seam; never populated by bootstrap or configuration. */
  testOnlyProofLoader?: () => { proof?:NativeMediaProof; reason?:string };
}

function command(config:WorkbenchConfig):ResolvedCommand {
  const value=resolveCommand('codex',{override:config.adapters.codex.command});
  if(!value) throw new Error('受管Codex CLI不可用');
  return value;
}
function nativeCodexGeneratedRoot(env:NodeJS.ProcessEnv):string {const home=env.CODEX_HOME??path.join(os.homedir(),'.codex');if(!path.isAbsolute(home))throw new Error('CODEX_HOME必须是绝对路径');return path.join(path.resolve(home),'generated_images');}
function regular(file:string){const info=lstatSync(file);if(!info.isFile()||info.isSymbolicLink())throw new Error(`本机图片能力文件不安全: ${file}`);}
export function nativeMediaFingerprintPath(file:string):string {regular(file);return realpathSync.native(file);}
function fingerprintFiles(){const ext=path.extname(moduleFile);return [moduleFile,fileURLToPath(new URL(`./drivers${ext}`,import.meta.url)),fileURLToPath(new URL(`./codex-policy${ext}`,import.meta.url)),fileURLToPath(new URL(`./windows-job-process${ext}`,import.meta.url)),fileURLToPath(new URL(`./windows-job-app-server${ext}`,import.meta.url)),fileURLToPath(new URL(`./document-provider${ext}`,import.meta.url)),fileURLToPath(new URL(`../adapters/process${ext}`,import.meta.url)),process.execPath];}
export function nativeCodexMediaFingerprint(config:WorkbenchConfig):string {
  const cmd=command(config), assets=loadChatWindowsJobSupervisorAssets();
  const env=scrubEnv(process.env,config.adapters.codex.scrubEnvKeys).env;
  const hash=createHash('sha256').update(JSON.stringify({command:{file:nativeMediaFingerprintPath(cmd.file),prefixArgs:cmd.prefixArgs.map(nativeMediaFingerprintPath)},model:config.models.sol.model,effort:config.models.sol.effort,policy:NATIVE_MEDIA_POLICY,codexGeneratedRoot:nativeCodexGeneratedRoot(env),assets:{...assets,binaryPath:nativeMediaFingerprintPath(assets.binaryPath)}}));
  for(const file of [...fingerprintFiles(),cmd.file,...cmd.prefixArgs]){hash.update(nativeMediaFingerprintPath(file)).update(readFileSync(file));}
  return hash.digest('hex');
}
export function validateNativeMediaProof(raw:unknown,config:WorkbenchConfig):NativeMediaProof {
  const proof=raw as NativeMediaProof;
  if(!proof||proof.schema!=='dual-model-workbench/native-codex-media-proof/v1'||proof.verified!==true||proof.isolationVerified!==true||proof.policy!==NATIVE_MEDIA_POLICY)throw new Error('本机图片能力证明无效');
  if(proof.model!==config.models.sol.model||proof.effort!==config.models.sol.effort||proof.fingerprint!==nativeCodexMediaFingerprint(config))throw new Error('本机图片能力证明与当前候选不匹配');
  if(proof.version!==NATIVE_MEDIA_CODEX_VERSION||!Number.isFinite(Date.parse(proof.verifiedAt))||!NATIVE_MEDIA_REQUIRED_TESTS.every(name=>proof.tests?.[name]===true))throw new Error('本机图片能力证明不完整');
  return proof;
}
function loadProof(file:string,config:WorkbenchConfig):{proof?:NativeMediaProof;reason?:string}{try{regular(file);return{proof:validateNativeMediaProof(JSON.parse(readFileSync(file,'utf8')),config)}}catch(error){return{reason:error instanceof Error?error.message:String(error)}}}
function within(root:string,target:string){const relative=path.relative(root,target);return relative&&!relative.startsWith('..')&&!path.isAbsolute(relative);}
function noLinks(target:string){let current=path.parse(path.resolve(target)).root;for(const part of path.resolve(target).slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);const info=lstatSync(current);if(info.isSymbolicLink())throw new Error('Codex图片路径包含链接');}}
const artifactComponent=(value:string)=>value.replace(/[^A-Za-z0-9_-]/gu,'_');
function policyEvidence(value:ReturnType<typeof parseCodexIsolationMetadata>){return{features:Object.fromEntries(value.features),permissionProfileIds:value.permissionProfileIds,mcpServers:value.mcpServers,plugins:value.plugins,appsEnabled:value.appsEnabled,hookCount:value.hookCount};}
const NATIVE_MEDIA_PASSIVE_ITEMS=new Set(['userMessage','agentMessage','reasoning']);
export function consumeNativeMediaNotification(message:any,state:NativeMediaNotificationState):{imageStarted:boolean;textDelta:string}{
  const item=message.params?.item;
  if(item?.type==='imageGeneration'){
    if(!state.threadId||!state.turnId||message.params?.threadId!==state.threadId||message.params?.turnId!==state.turnId||typeof item.id!=='string'||!item.id)throw new Error('本机图片事件来自未知回合或调用');
    if(message.method==='item/started'){
      state.startedImageIds.add(item.id);
      if(state.startedImages+1>1||state.startedImageIds.size>1)throw new Error('本机图片单次调用启动了多个生成任务');
      return{imageStarted:true,textDelta:''};
    }
    if(message.method==='item/completed'){
      if(!state.startedImageIds.has(item.id))throw new Error('本机图片完成事件未绑定启动事件');
      state.completedItems.push(item);if(state.completedItems.length>1)throw new Error('本机图片单次调用完成了多个生成任务');
    }
  }else if(item&&(message.method==='item/started'||message.method==='item/completed')&&!NATIVE_MEDIA_PASSIVE_ITEMS.has(item.type))throw new Error(`本机图片调用暴露未授权工具: ${item.type}`);
  const textDelta=message.method==='item/agentMessage/delta'&&message.params?.threadId===state.threadId&&message.params?.turnId===state.turnId&&typeof message.params?.delta==='string'?message.params.delta:'';
  return{imageStarted:false,textDelta};
}
export function buildNativeMediaTurnInput(operation:NativeMediaOperation,staged?:{path:string;sha256:string}):any[]{
  const editBinding=operation.kind==='edit'&&staged?`必须通过 referenced_image_paths 参数仅引用这个受控本地文件：${JSON.stringify(staged.path)}；不得使用 num_last_images_to_include。`:'';
  const input:any[]=[{type:'text',text:operation.kind==='read'?operation.prompt:`请使用内置图片生成能力${operation.kind==='edit'?'编辑所附参考图':'生成一张图片'}。${editBinding}要求尺寸 ${operation.size??'1024x1024'}。${operation.prompt}`}];
  if(staged)input.push({type:'localImage',path:staged.path,restrictedEnvironmentAccess:true});
  return input;
}
export function buildNativeMediaEnvironments(scratch:string):Array<{environmentId:'local';cwd:string;runtimeWorkspaceRoots:string[]}>{
  if(!path.isAbsolute(scratch))throw new Error('本机图片环境scratch必须是绝对路径');
  return[{environmentId:'local',cwd:scratch,runtimeWorkspaceRoots:[scratch]}];
}
export const nativeMediaExitConfirmed=(processConfirmed:boolean,error:unknown)=>processConfirmed&&(!(error instanceof ChatDriverError)||error.exitConfirmed);
export function extractNativeImageItem(item:any,outputRoot:string,input:{path:string;sha256:string}|undefined,threadId:string):Buffer {
  if(!item||item.type!=='imageGeneration'||item.status!=='completed'||item.failure!=null)throw new Error('Codex图片生成未成功完成');
  const observed=Array.isArray(item.inputImages)?item.inputImages:[];
  if(input){if(observed.length!==1||path.resolve(observed[0]?.path??'')!==path.resolve(input.path)||observed[0]?.sha256!==input.sha256)throw new Error('Codex参考图来源绑定不匹配');}
  else if(observed.length!==0)throw new Error('Codex无参考图生成出现未知输入图片');
  if(item.savedPath!=null){if(typeof item.savedPath!=='string'||!path.isAbsolute(item.savedPath)||typeof item.id!=='string'||!item.id||!threadId)throw new Error('Codex图片保存路径无效');noLinks(item.savedPath);noLinks(outputRoot);const real=realpathSync.native(item.savedPath),root=realpathSync.native(outputRoot),relative=path.relative(root,real),parts=relative.split(path.sep),expectedThread=artifactComponent(threadId),expectedFile=`${artifactComponent(item.id)}.png`;if(!within(root,real)||parts.length!==2||parts[0]!==expectedThread||parts[1]!==expectedFile||!lstatSync(real).isFile())throw new Error('Codex图片保存路径、线程或调用绑定越界');const before=statSync(real,{bigint:true});if(before.size<1n||before.size>BigInt(MAX_IMAGE_BYTES))throw new Error('Codex图片产物大小无效');const bytes=readFileSync(real),after=statSync(real,{bigint:true});if(before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ino!==after.ino)throw new Error('Codex图片产物读取时发生变化');return bytes;}
  throw new Error('固定Codex图片完成项缺少受绑定的savedPath产物');
}
export function verifyNativeStagedInput(input:{path:string;sha256:string}):void {noLinks(input.path);const link=lstatSync(input.path);if(!link.isFile()||link.isSymbolicLink())throw new Error('参考图不再是普通文件');const before=statSync(input.path,{bigint:true});if(before.size<1n||before.size>BigInt(MAX_IMAGE_BYTES))throw new Error('参考图大小无效');const bytes=readFileSync(input.path),after=statSync(input.path,{bigint:true});if(before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ino!==after.ino||sha(bytes)!==input.sha256)throw new Error('参考图在调用中被替换或修改');}

async function runNativeCodexMedia(config:WorkbenchConfig,operation:NativeMediaOperation,options:NativeMediaInternalRunOptions):Promise<NativeMediaInvocationResult>{
  if(!path.isAbsolute(options.scratchRoot))throw new Error('本机图片scratch根目录必须是绝对路径');mkdirSync(options.scratchRoot,{recursive:true});noLinks(options.scratchRoot);
  if(!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<1_000||options.timeoutMs>900_000)throw new Error('本机图片超时必须在1秒到15分钟之间');
  if((operation.kind==='read'||operation.kind==='edit')&&!operation.input)throw new Error('图片理解或编辑必须绑定一张参考图');if(operation.kind==='generate'&&operation.input)throw new Error('纯图片生成不能携带参考图');
  const scratch=mkdtempSync(path.join(options.scratchRoot,'native-media-')),inputRoot=path.join(scratch,'input'),receipts=path.join(scratch,'job');let outputRoot='';
  const jobs:unknown[]=[],recordedJobs=new Set<CodexAppServer>(),startedImageIds=new Set<string>();let discovery:CodexAppServer|null=null,isolated:CodexAppServer|null=null,current:CodexAppServer|null=null,discoveryInventory:CodexInventory|null=null,threadId='',turnId='',turnActive=false,turnRequested=false,exitConfirmed=true,keepScratch=false,startedImages=0,appServerProcessCount=0,preflightPolicyVerified=false,threadPolicyVerified=false,preflightPolicy:unknown=null,threadPolicy:unknown=null;const items:any[]=[];let text='';
  const controller=new AbortController();let timer:NodeJS.Timeout|undefined;const relay=()=>controller.abort(options.signal.reason);
  let staged:{path:string;sha256:string}|undefined;
  const close=async(client:CodexAppServer|null)=>{if(!client)return true;const phase=client===discovery?'discovery':client===isolated?'isolated':'app-server';const confirmed=await client.stop().catch(()=>false);if(!recordedJobs.has(client)){recordedJobs.add(client);const value=client.jobEvidence();if(value)jobs.push(typeof value==='object'?{...value,phase}:{phase,evidence:value});}exitConfirmed&&=confirmed;if(current===client)current=null;return confirmed;};
  const abort=()=>{const client=current;if(client&&turnActive&&threadId&&turnId)void client.request('turn/interrupt',{threadId,turnId},5_000).catch(()=>undefined).finally(()=>close(client));else void close(client);};
  const evidence=(confirmed:boolean):NativeMediaInvocationEvidence=>({version:NATIVE_MEDIA_CODEX_VERSION,model:config.models.sol.model,effort:config.models.sol.effort,threadId,turnId,nativeCliInvocations:turnRequested?1:0,appServerProcessCount,turnRequested,imageGenerationStarted:startedImages,imageGenerationCompleted:items.length,imageGenerationStartedIds:[...startedImageIds],preflightPolicyVerified,threadPolicyVerified,discoveryInventory,preflightPolicy,threadPolicy,observedInputImages:items.flatMap(item=>Array.isArray(item.inputImages)?item.inputImages:[]),stagedInput:staged??null,workspaceRoot:scratch,inputRoot,outputRoot,outputBinding:'fixed-codex-cache/thread-and-call-id',jobEvidence:jobs,scratch:confirmed?null:scratch});
  try{
    mkdirSync(inputRoot);mkdirSync(receipts);
    const cmd=command(config),assets=loadChatWindowsJobSupervisorAssets(),env=scrubEnv(process.env,config.adapters.codex.scrubEnvKeys).env,job={supervisorPath:assets.binaryPath,receiptDirectory:receipts};
    const environments=buildNativeMediaEnvironments(scratch);
    outputRoot=nativeCodexGeneratedRoot(env);
    timer=setTimeout(()=>controller.abort('timeout'),options.timeoutMs);if(options.signal.aborted)relay();else options.signal.addEventListener('abort',relay,{once:true});controller.signal.addEventListener('abort',abort,{once:true});
    if(operation.input){if(operation.input.bytes.length>MAX_IMAGE_BYTES||sha(operation.input.bytes)!==operation.input.sha256)throw new Error('参考图字节或哈希无效');const ext=operation.input.mime==='image/png'?'.png':operation.input.mime==='image/webp'?'.webp':operation.input.mime==='image/jpeg'?'.jpg':null;if(!ext)throw new Error('本机图片仅支持PNG/JPEG/WebP');const file=path.join(inputRoot,`source${ext}`);writeFileSync(file,operation.input.bytes,{flag:'wx'});staged={path:realpathSync.native(file),sha256:operation.input.sha256};}
    const version=await runChatWindowsJobProcess(cmd,['--version'],{...job,cwd:scratch,env,stdinText:null,timeoutMs:10_000,signal:controller.signal});if('windowsJob'in version)jobs.push({...version.windowsJob,phase:'version'});validateVersionResult(version,NATIVE_MEDIA_CODEX_VERSION);
    discovery=new CodexAppServer(cmd,buildCodexDiscoveryArgs(),scratch,env,undefined,undefined,undefined,job);appServerProcessCount++;current=discovery;await discovery.initialize();const inventory=await codexInventory(discovery,scratch);discoveryInventory=inventory;if(!await close(discovery))throw new Error('Codex发现进程树退出状态未知');discovery=null;
    isolated=new CodexAppServer(cmd,buildCodexMediaIsolationArgs(inventory),scratch,env,undefined,message=>{const update=consumeNativeMediaNotification(message,{threadId,turnId,startedImages,startedImageIds,completedItems:items});if(update.imageStarted){startedImages++;options.onPhase?.('image-started');}text+=update.textDelta;},undefined,job,MEDIA_LINE_BYTES);appServerProcessCount++;current=isolated;await isolated.initialize();
    const features=await codexPages(isolated,'experimentalFeature/list',{limit:100}),profiles=await codexPages(isolated,'permissionProfile/list',{cwd:scratch,limit:100}),inv=await codexInventory(isolated,scratch),apps=await isolated.request('app/installed',{forceRefresh:false}),hooks=await isolated.request('hooks/list',{cwds:[scratch]});const meta=parseCodexIsolationMetadata({features,profiles,mcpServers:inv.mcpServers,plugins:inv.plugins,apps:apps?.apps,hooks:hooks?.data});preflightPolicy=policyEvidence(meta);const failures=validateCodexMediaIsolation(inventory,meta,'preflight');if(failures.length)throw new Error(`本机图片隔离未通过: ${failures.join('; ')}`);preflightPolicyVerified=true;
    const started=await isolated.request('thread/start',{model:config.models.sol.model,allowProviderModelFallback:false,cwd:scratch,runtimeWorkspaceRoots:[scratch],approvalPolicy:'never',permissions:CODEX_MEDIA_PROFILE,ephemeral:true,historyMode:'paginated',environments,selectedCapabilityRoots:[],config:{apps:{_default:{enabled:false}}},developerInstructions:'仅完成当前图片理解或图片生成请求。不得调用shell、文件修改、MCP、浏览器、搜索或其他原生工具；不得读取输入目录以外的文件。生成图片时只使用内置图片生成能力。',dynamicTools:[]});threadId=started?.thread?.id;threadPolicy={requested:{model:config.models.sol.model,effort:config.models.sol.effort,allowProviderModelFallback:false,cwd:scratch,runtimeWorkspaceRoots:[scratch],approvalPolicy:'never',permissions:CODEX_MEDIA_PROFILE,environments},reported:{model:started?.model,approvalPolicy:started?.approvalPolicy,permissionProfileId:started?.activePermissionProfile?.id}};if(!threadId||started?.model!==config.models.sol.model||started?.approvalPolicy!=='never'||started?.activePermissionProfile?.id!==CODEX_MEDIA_PROFILE)throw new Error('本机图片线程策略或模型不匹配');await isolated.request('thread/settings/update',{threadId,disabledPluginIds:[]});const threadMcp=await codexPages(isolated,'mcpServerStatus/list',{limit:100,detail:'toolsAndAuthOnly',threadId});const threadMeta=parseCodexIsolationMetadata({features,profiles,mcpServers:threadMcp,plugins:inv.plugins,apps:apps?.apps,hooks:hooks?.data});threadPolicy={...(threadPolicy as object),surface:policyEvidence(threadMeta)};const threadFailures=validateCodexMediaIsolation(inventory,threadMeta);if(threadFailures.length)throw new Error(`本机图片线程工具面未通过: ${threadFailures.join('; ')}`);threadPolicyVerified=true;
    if(options.preflightOnly){if(!await close(isolated)){keepScratch=true;throw new Error('本机图片进程树退出状态未知');}isolated=null;return{text:'本机Codex图片预检完成。',exitConfirmed:true,finishReason:'completed',evidence:evidence(true)};}
    const input=buildNativeMediaTurnInput(operation,staged);
    turnRequested=true;options.onPhase?.('turn-requested');const turn=await isolated.request('turn/start',{threadId,input,cwd:scratch,runtimeWorkspaceRoots:[scratch],model:config.models.sol.model,effort:config.models.sol.effort,approvalPolicy:'never',permissions:CODEX_MEDIA_PROFILE,environments,disabledPluginIds:[]});turnId=turn?.turn?.id;if(!turnId)throw new Error('本机图片回合未启动');turnActive=true;options.onPhase?.('turn-started');
    const done=await isolated.waitFor(message=>message.method==='turn/completed'&&message.params?.threadId===threadId&&message.params?.turn?.id===turnId,options.timeoutMs);turnActive=false;if(done.params?.turn?.status!=='completed')throw new Error(`本机图片回合未完成: ${done.params?.turn?.status??'unknown'}`);
    let image:Buffer|undefined;if(operation.kind==='read'){if(startedImages||items.length)throw new Error('图片理解意外启动图片生成');if(!text.trim())throw new Error('图片理解未返回文本');}else{if(items.length!==1)throw new Error(`本机图片产物数量无效: ${items.length}`);image=extractNativeImageItem(items[0],outputRoot,operation.kind==='edit'?staged:undefined,threadId);}
    if(staged)verifyNativeStagedInput(staged);if(!await close(isolated)){keepScratch=true;throw new Error('本机图片进程树退出状态未知');}isolated=null;
    return{text:text.trim()||'本机Codex图片生成完成。',...(image?{image}:{}),...(staged?{sourceHash:staged.sha256}:{}),exitConfirmed:true,finishReason:'completed',evidence:evidence(true)};
  }catch(error){if(controller.signal.aborted){const processConfirmed=await close(current),confirmed=nativeMediaExitConfirmed(exitConfirmed&&processConfirmed,error);if(!confirmed)keepScratch=true;return{text:'',exitConfirmed:confirmed,finishReason:confirmed?(controller.signal.reason==='timeout'?'failed':'cancelled'):'exit_unknown',evidence:evidence(confirmed)};}const processConfirmed=await close(current),confirmed=nativeMediaExitConfirmed(exitConfirmed&&processConfirmed,error);if(!confirmed)keepScratch=true;const failure=confirmed?error:new ChatDriverError(error instanceof Error?error.message:String(error),false);Object.assign(failure as object,{exitConfirmed:confirmed,evidence:evidence(confirmed)});throw failure;}
  finally{if(timer)clearTimeout(timer);options.signal.removeEventListener('abort',relay);controller.signal.removeEventListener('abort',abort);if(!keepScratch&&exitConfirmed)rmSync(scratch,{recursive:true,force:true});}
}

/** Explicit qualification/live primitive. Product calls are proof-gated by NativeCodexMediaProvider. */
export function runQualifiedNativeCodexMedia(config:WorkbenchConfig,operation:NativeMediaOperation,options:NativeMediaRunOptions):Promise<NativeMediaInvocationResult>{
  return runNativeCodexMedia(config,operation,{...options,preflightOnly:false});
}

/** Runs the real native media protocol through thread policy validation without starting a turn. */
export function runNativeCodexMediaPreflight(config:WorkbenchConfig,options:NativeMediaRunOptions):Promise<NativeMediaInvocationResult>{
  return runNativeCodexMedia(config,{kind:'generate',prompt:'native media preflight'},{...options,preflightOnly:true});
}

export class NativeCodexMediaProvider implements ChatCapabilityHost {
  private busy=false;
  private unsafeExit=false;
  constructor(private readonly options:NativeCodexMediaOptions){}
  private readiness(){const setting=this.options.settings();if(!setting?.enabled)return{setting,state:'disabled' as const,reason:'未启用本机Codex图片能力'};if(this.unsafeExit)return{setting,state:'unavailable' as const,reason:'本机Codex图片进程树退出状态未知，需重启应用并核实残留进程'};if(!setting.allowSubscriptionCalls)return{setting,state:'disabled' as const,reason:'未明确允许本机订阅图片调用'};const loaded=this.options.testOnlyProofLoader?.()??loadProof(this.options.proofFile,this.options.config);return loaded.proof?{setting,proof:loaded.proof,state:'ready' as const}:{setting,state:'unavailable' as const,reason:loaded.reason??'缺少本机图片能力证明'};}
  definitions(_task:AgentTask):ToolDefinition[]{const ready=this.readiness();if(ready.state!=='ready')return[];return[{name:'image_read',description:'使用已登录的本机Codex理解已绑定图片；不调用独立API。',inputSchema:object({fileId:{type:'string'},prompt:{type:'string'}},['fileId','prompt'])},{name:'image_generate',description:'使用已登录的本机Codex生成图片或编辑一张已绑定参考图；返回实际图片文件。',inputSchema:object({prompt:{type:'string'},size:{type:'string',enum:['1024x1024','1536x1024','1024x1536']},referenceFileId:{type:'string'}},['prompt'])}];}
  async status():Promise<CapabilityStatus[]>{const ready=this.readiness();return[{id:'media:vision',name:'Codex本机图片理解',state:ready.state,reason:ready.reason,tools:['image_read'],fingerprint:ready.proof?.fingerprint},{id:'media:image',name:'Codex本机图片生成',state:ready.state,reason:ready.reason,tools:['image_generate'],fingerprint:ready.proof?.fingerprint}];}
  private async source(chat:ChatRecord,id:string,signal:AbortSignal){const file=this.options.readFile(chat,id);if(!/^image\/(png|jpeg|webp)$/u.test(file.metadata.mime)||file.bytes.length>MAX_IMAGE_BYTES||sha(file.bytes)!==file.metadata.hash)throw new Error('仅支持哈希有效且20MiB以内的PNG/JPEG/WebP图片');const decoded=await this.options.inspectImage({name:file.metadata.name,mime:file.metadata.mime,bytes:file.bytes},signal);if(decoded.mime!==file.metadata.mime||decoded.width<1||decoded.height<1||decoded.width*decoded.height>64_000_000)throw new Error('图片实际解码无效');return{...file,decoded};}
  async call(name:string,input:unknown,context:CapabilityCall):Promise<CapabilityReply>{const ready=this.readiness();if(ready.state!=='ready')throw new Error(ready.reason);if(this.busy)throw new Error('本机Codex图片调用已有任务运行');this.busy=true;try{let operation:NativeMediaOperation;if(name==='image_read'){const value=nativeMediaInput.parse(input),file=await this.source(context.chat,value.fileId,context.signal);operation={kind:'read',prompt:value.prompt,input:{name:file.metadata.name,mime:file.metadata.mime,bytes:file.bytes,sha256:file.metadata.hash}};}else if(name==='image_generate'){const value=nativeMediaGenerate.parse(input);let source:Awaited<ReturnType<NativeCodexMediaProvider['source']>>|undefined;if(value.referenceFileId)source=await this.source(context.chat,value.referenceFileId,context.signal);operation={kind:source?'edit':'generate',prompt:value.prompt,size:value.size,...(source?{input:{name:source.metadata.name,mime:source.metadata.mime,bytes:source.bytes,sha256:source.metadata.hash}}:{})};}else throw new Error('未知本机图片工具');const result=await(this.options.invoke??runQualifiedNativeCodexMedia)(this.options.config,operation,{scratchRoot:this.options.scratchRoot,signal:context.signal,timeoutMs:ready.setting!.timeoutMs});if(!result.exitConfirmed)throw Object.assign(new ChatDriverError('本机Codex图片进程退出状态未知',false),{evidence:result.evidence});if(result.finishReason!=='completed')throw Object.assign(new ChatDriverError(result.finishReason==='cancelled'?'本机Codex图片调用已取消':'本机Codex图片调用超时或失败',true),{evidence:result.evidence});const accounting={nativeCliInvocations:result.evidence.nativeCliInvocations,appServerProcessCount:result.evidence.appServerProcessCount,imageGenerationCount:result.evidence.imageGenerationCompleted,modelRole:'sol',jobEvidence:result.evidence.jobEvidence};if(name==='image_read')return{text:result.text,data:{sourceHash:result.sourceHash,...accounting}};if(!result.image)throw new Error('本机Codex未返回图片');const decoded=await this.options.inspectImage({name:'native-generated',mime:'application/octet-stream',bytes:result.image},context.signal),ext=decoded.mime==='image/png'?'png':decoded.mime==='image/webp'?'webp':'jpg';const file:ProducedFile={name:`generated-${randomUUID()}.${ext}`,bytes:result.image,mime:decoded.mime,...(result.sourceHash?{inputHashes:[result.sourceHash]}:{})};return{text:result.text,files:[file],data:{width:decoded.width,height:decoded.height,bytes:result.image.length,hash:sha(result.image),sourceHash:result.sourceHash,...accounting}};}catch(error){if(error&&typeof error==='object'&&(error as {exitConfirmed?:boolean}).exitConfirmed===false)this.unsafeExit=true;throw error;}finally{this.busy=false;}}
}
