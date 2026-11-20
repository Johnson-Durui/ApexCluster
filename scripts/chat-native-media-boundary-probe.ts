/** Candidate-only, zero-inference filesystem boundary qualification for native Codex media. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertFreshWorkOutput, validateCandidateFiles } from './course-check-utils.js';

type Json=Record<string,any>;
type Parsed={candidate:string;output:string};
type JobResult={exitCode:number|null;signal:string|null;timedOut:boolean;cancelled:boolean;spawnError:string|null;stdoutTail:string;stderrTail:string;terminationWarning?:string;windowsJob?:{confirmed:boolean;rootExited:boolean;jobActiveProcesses:number|null;targetExitCode:number|null}};
type Canary={name:'inside-read'|'inside-write'|'outside-read-denied'|'outside-write-denied';command:string;expect:'success'|'denied'};

const WORK_ROOT=path.resolve(process.env.DMW_WORK_ROOT??'work');
const PROFILE='workbench-native-media';
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const at=()=>new Date().toISOString();

export function parseNativeMediaBoundaryArgs(argv:string[]):Parsed|null{
  if(argv.length===1&&['--help','-h'].includes(argv[0]!))return null;
  const values=new Map<string,string>();
  for(let index=0;index<argv.length;index++){
    const flag=argv[index]!;assert.ok(['--candidate','--output'].includes(flag)&&!values.has(flag),`unsupported or duplicate argument: ${flag}`);
    const value=argv[++index];assert.ok(value&&path.isAbsolute(value),`${flag} must be absolute`);values.set(flag,path.resolve(value));
  }
  assert.equal(values.size,2,'required: --candidate ABS --output NEW_ABS');
  return{candidate:values.get('--candidate')!,output:values.get('--output')!};
}

export function nativeMediaBoundaryCanaries():Canary[]{return[
  {name:'inside-read',command:'type inside-read.txt',expect:'success'},
  {name:'inside-write',command:'> inside-write.txt echo INSIDE_WRITE_OK',expect:'success'},
  {name:'outside-read-denied',command:'type ..\\outside\\outside-read.txt',expect:'denied'},
  {name:'outside-write-denied',command:'> ..\\outside\\outside-write.txt echo OUTSIDE_WRITE_SHOULD_FAIL',expect:'denied'},
];}

export function assertBoundaryJobResult(result:JobResult,expect:'success'|'denied',forbiddenSentinel:string,requiredOutput?:string):void{
  assert.equal(result.spawnError,null);assert.equal(result.signal,null);assert.equal(result.timedOut,false);assert.equal(result.cancelled,false);assert.equal(result.terminationWarning,undefined);
  assert.equal(result.windowsJob?.confirmed,true);assert.equal(result.windowsJob?.rootExited,true);assert.equal(result.windowsJob?.jobActiveProcesses,0);assert.equal(result.windowsJob?.targetExitCode,result.exitCode);
  assert.equal((result.stdoutTail+result.stderrTail).includes(forbiddenSentinel),false,'Outside sentinel leaked through sandbox output');
  if(requiredOutput!==undefined)assert.ok(result.stdoutTail.includes(requiredOutput),'Inside read did not return the complete sentinel');
  if(expect==='success')assert.equal(result.exitCode,0);else assert.ok(Number.isInteger(result.exitCode)&&result.exitCode!==0,'Outside canary was not denied');
}

function assertPreflight(result:Json,expected:{version:string;model:string;effort:string}){
  const evidence=result.evidence;
  assert.equal(result.finishReason,'completed');assert.equal(result.exitConfirmed,true);assert.equal(result.image,undefined);assert.equal(evidence.version,expected.version);assert.equal(evidence.model,expected.model);assert.equal(evidence.effort,expected.effort);
  assert.equal(evidence.nativeCliInvocations,0);assert.equal(evidence.turnRequested,false);assert.equal(evidence.imageGenerationStarted,0);assert.equal(evidence.imageGenerationCompleted,0);assert.equal(evidence.appServerProcessCount,2);
  assert.ok(evidence.threadId);assert.equal(evidence.turnId,'');assert.equal(evidence.preflightPolicyVerified,true);assert.equal(evidence.threadPolicyVerified,true);assert.ok(evidence.discoveryInventory&&Array.isArray(evidence.discoveryInventory.mcpServers)&&Array.isArray(evidence.discoveryInventory.plugins));
  const jobs=evidence.jobEvidence;assert.ok(Array.isArray(jobs)&&jobs.length===3);for(const phase of ['version','discovery','isolated'])assert.equal(jobs.filter((item:Json)=>item?.phase===phase&&item.confirmed===true&&item.rootExited===true&&(item.activeProcesses??item.jobActiveProcesses)===0).length,1);
  assert.equal(evidence.scratch,null);return evidence;
}

function regularSha(file:string){assert.ok(path.isAbsolute(file));const info=lstatSync(file);assert.ok(info.isFile()&&!info.isSymbolicLink(),`Unsafe executable: ${file}`);return sha(readFileSync(file));}

async function main():Promise<void>{
  const args=parseNativeMediaBoundaryArgs(process.argv.slice(2));
  if(!args){process.stdout.write('Usage: CANDIDATE\\runtime\\node.exe --import tsx scripts/chat-native-media-boundary-probe.ts --candidate ABS --output NEW_ABS\n');return;}
  const app=path.join(args.candidate,'app'),candidateNode=path.join(args.candidate,'runtime','node.exe');
  const report:Json={schema:'dual-model-workbench/native-codex-media-boundary/v1',candidate:args.candidate,startedAt:at(),inferenceSegments:0,turnsRequested:0,prepared:false,boundaryVerified:false,passed:false,proofReady:false,canaries:[]};
  let outputCreated=false;const persist=()=>writeFileSync(path.join(args.output,'result.json'),`${JSON.stringify(report,null,2)}\n`);
  try{
    assertFreshWorkOutput(args.output,WORK_ROOT);mkdirSync(args.output);outputCreated=true;persist();validateCandidateFiles(args.candidate);report.initialManifestSha256=sha(readFileSync(path.join(args.candidate,'chat-source-manifest.json')));
    assert.equal(path.resolve(process.execPath).toLowerCase(),path.resolve(candidateNode).toLowerCase(),'Probe must run with candidate runtime node.exe');
    const load=(relative:string)=>import(pathToFileURL(path.join(app,relative)).href);
    const[{loadConfig},nativeModule,policyModule,jobModule,processModule]=await Promise.all([load('src/config.js'),load('src/chat/codex-native-media.js'),load('src/chat/codex-policy.js'),load('src/chat/windows-job-process.js'),load('src/adapters/process.js')]);
    const config=loadConfig(path.join(app,'config/workbench.config.json'),app),expected={version:nativeModule.NATIVE_MEDIA_CODEX_VERSION,model:config.models.sol.model,effort:config.models.sol.effort};
    for(const [name,value] of Object.entries({runNativeCodexMediaPreflight:nativeModule.runNativeCodexMediaPreflight,nativeCodexMediaFingerprint:nativeModule.nativeCodexMediaFingerprint,buildCodexMediaIsolationArgs:policyModule.buildCodexMediaIsolationArgs,runChatWindowsJobProcess:jobModule.runChatWindowsJobProcess,loadChatWindowsJobSupervisorAssets:jobModule.loadChatWindowsJobSupervisorAssets,resolveCommand:processModule.resolveCommand,scrubEnv:processModule.scrubEnv}))assert.equal(typeof value,'function',`Candidate export missing: ${name}`);
    const command=processModule.resolveCommand('codex',{override:config.adapters.codex.command});assert.ok(command&&command.via!=='cmd-fallback','Managed Codex CLI unavailable for Windows Job boundary probe');
    const assets=jobModule.loadChatWindowsJobSupervisorAssets(),env=processModule.scrubEnv(process.env,config.adapters.codex.scrubEnvKeys).env;
    const computeSourceBinding=()=>({candidateManifestSha256:sha(readFileSync(path.join(args.candidate,'chat-source-manifest.json'))),candidateNodeSha256:regularSha(candidateNode),nativeFingerprint:nativeModule.nativeCodexMediaFingerprint(config),codexCommandFileSha256:regularSha(command.file),codexCommandPrefixArgsSha256:sha(JSON.stringify(command.prefixArgs)),windowsJobAssets:jobModule.loadChatWindowsJobSupervisorAssets()});
    report.initialSourceBinding=computeSourceBinding();assert.equal(report.initialSourceBinding.candidateManifestSha256,report.initialManifestSha256);
    const preflightStage:Json={passed:false,startedAt:at()};report.preflight=preflightStage;persist();let evidence:Json;
    try{
      const preflight=await nativeModule.runNativeCodexMediaPreflight(config,{scratchRoot:path.join(args.output,'preflight-scratch'),signal:new AbortController().signal,timeoutMs:300_000});
      Object.assign(preflightStage,{text:preflight.text,finishReason:preflight.finishReason,exitConfirmed:preflight.exitConfirmed,evidence:preflight.evidence});persist();
      evidence=assertPreflight(preflight,expected);preflightStage.passed=true;preflightStage.completedAt=at();persist();
    }catch(error){const value=error as Json;preflightStage.passed=false;preflightStage.completedAt=at();preflightStage.error=error instanceof Error?error.message:String(error);if(preflightStage.exitConfirmed===undefined)preflightStage.exitConfirmed=value?.exitConfirmed??value?.evidence?.scratch===null;if(preflightStage.evidence===undefined&&value?.evidence!==undefined)preflightStage.evidence=value.evidence;persist();throw error;}
    const isolationArgs:string[]=policyModule.buildCodexMediaIsolationArgs(evidence.discoveryInventory);assert.ok(isolationArgs.length>0);assert.ok(isolationArgs.some(value=>value.includes(PROFILE)),'Native media profile missing from isolation args');
    validateCandidateFiles(args.candidate);assert.deepEqual(computeSourceBinding(),report.initialSourceBinding,'Candidate changed during native preflight');
    const boundaryRoot=path.join(args.output,'boundary'),inside=path.join(boundaryRoot,'inside'),outside=path.join(boundaryRoot,'outside'),receipts=path.join(args.output,'job'),logs=path.join(args.output,'logs');mkdirSync(inside,{recursive:true});mkdirSync(outside);mkdirSync(receipts);mkdirSync(logs);
    const insideSentinel='BOUNDARY_INSIDE_READ_OK',outsideSentinel='BOUNDARY_OUTSIDE_SENTINEL_DO_NOT_LEAK';writeFileSync(path.join(inside,'inside-read.txt'),insideSentinel,{flag:'wx'});writeFileSync(path.join(outside,'outside-read.txt'),outsideSentinel,{flag:'wx'});
    report.boundaryPaths={inside:realpathSync.native(inside),outside:realpathSync.native(outside)};
    const computeBinding=()=>({...computeSourceBinding(),codexVersion:evidence.version,profile:PROFILE,profileArgsSha256:sha(JSON.stringify(policyModule.buildCodexMediaIsolationArgs(evidence.discoveryInventory)))});
    report.binding=computeBinding();
    report.prepared=true;persist();
    for(const canary of nativeMediaBoundaryCanaries()){
      const stage:Json={name:canary.name,startedAt:at(),passed:false};report.canaries.push(stage);persist();
      const cliArgs=[...isolationArgs,'sandbox','-P',PROFILE,'-C',inside,'--','cmd.exe','/d','/c',canary.command];stage.cliArgsSha256=sha(JSON.stringify(cliArgs));
      const result:JobResult=await jobModule.runChatWindowsJobProcess(command,cliArgs,{cwd:inside,env,stdinText:null,timeoutMs:30_000,signal:new AbortController().signal,supervisorPath:assets.binaryPath,receiptDirectory:receipts});
      const stdoutFile=path.join(logs,`${canary.name}.stdout.log`),stderrFile=path.join(logs,`${canary.name}.stderr.log`),stdoutBytes=Buffer.from(result.stdoutTail,'utf8'),stderrBytes=Buffer.from(result.stderrTail,'utf8');writeFileSync(stdoutFile,stdoutBytes,{flag:'wx'});writeFileSync(stderrFile,stderrBytes,{flag:'wx'});
      stage.exitCode=result.exitCode;stage.job=result.windowsJob;stage.logs={stdout:{path:stdoutFile,sha256:sha(stdoutBytes),bytes:stdoutBytes.length},stderr:{path:stderrFile,sha256:sha(stderrBytes),bytes:stderrBytes.length}};stage.sentinelLeakDetected=(result.stdoutTail+result.stderrTail).includes(outsideSentinel);persist();
      assertBoundaryJobResult(result,canary.expect,outsideSentinel,canary.name==='inside-read'?insideSentinel:undefined);
      if(canary.name==='inside-write')assert.equal(readFileSync(path.join(inside,'inside-write.txt'),'utf8').trim(),'INSIDE_WRITE_OK');
      if(canary.name==='outside-read-denied')assert.equal(readFileSync(path.join(outside,'outside-read.txt'),'utf8'),outsideSentinel);
      if(canary.name==='outside-write-denied')assert.equal(existsSync(path.join(outside,'outside-write.txt')),false);
      stage.passed=true;stage.completedAt=at();persist();
    }
    assert.equal(readdirSync(receipts).length,0,'Confirmed Windows Job receipts were not cleaned');assert.equal(readFileSync(path.join(outside,'outside-read.txt'),'utf8'),outsideSentinel);
    validateCandidateFiles(args.candidate);report.postBinding=computeBinding();persist();assert.deepEqual(computeSourceBinding(),report.initialSourceBinding,'Candidate source changed during the boundary probe');assert.deepEqual(report.postBinding,report.binding,'Candidate native-media binding changed during the boundary probe');
    report.receiptDirectoryClean=true;report.boundaryVerified=true;report.passed=true;report.proofReady=false;report.proofPublication='pending; root must combine this zero-inference boundary report with live media evidence and independent visual review';
  }catch(error){const value=error as Json;report.error=error instanceof Error?error.message:String(error);if(value?.exitConfirmed!==undefined||value?.evidence!==undefined)report.failure={exitConfirmed:value?.exitConfirmed??value?.evidence?.scratch===null,evidence:value?.evidence};process.exitCode=1;}
  finally{report.endedAt=at();if(outputCreated)persist();process.stdout.write(`${JSON.stringify({output:args.output,prepared:report.prepared,boundaryVerified:report.boundaryVerified,passed:report.passed,proofReady:report.proofReady,inferenceSegments:report.inferenceSegments,error:report.error})}\n`);}
}

const isMain=process.argv[1]!==undefined&&path.resolve(process.argv[1])===path.resolve(fileURLToPath(import.meta.url));
if(isMain)void main();
