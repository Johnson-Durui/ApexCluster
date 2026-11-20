/** Candidate-only native Codex media qualification. Default mode never dispatches a model. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertFreshWorkOutput, validateCandidateFiles } from './course-check-utils.js';

type Json = Record<string, any>;
type Phase = 'turn-requested'|'turn-started'|'image-started';
type Operation = { kind:'read'|'generate'|'edit'; prompt:string; size?:string; input?:{name:string;mime:string;bytes:Buffer;sha256:string} };
type Evidence = {
  version:string; model:string; effort:string; threadId:string; turnId:string; nativeCliInvocations:number;
  appServerProcessCount:number;
  turnRequested:boolean; imageGenerationStarted:number; imageGenerationCompleted:number;
  preflightPolicyVerified:boolean; threadPolicyVerified:boolean; discoveryInventory:{mcpServers:Json[];plugins:Json[]}|null; preflightPolicy:unknown; threadPolicy:unknown;
  observedInputImages:Array<{path:string;sha256:string}>; stagedInput:{path:string;sha256:string}|null;
  workspaceRoot:string; inputRoot:string; outputRoot:string; jobEvidence:Json[]; scratch:string|null;
};
type InvocationResult = { text:string; image?:Buffer; sourceHash?:string; exitConfirmed:boolean; finishReason:string; evidence:Evidence };
type Parsed = { candidate:string; output:string; executeLive:boolean };

const WORK_ROOT=path.resolve(process.env.DMW_WORK_ROOT??'work');
const MAX_SEGMENTS=4;
export const NATIVE_MEDIA_READ_PROMPT='请客观描述所附图片中实际可见的主要颜色、几何形状及其相对位置。不要猜测生成提示词，也不要补充图片中看不到的内容。';
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const at=()=>new Date().toISOString();

export function parseNativeMediaProbeArgs(argv:string[]):Parsed|null{
  if(argv.length===1&&['--help','-h'].includes(argv[0]!))return null;
  const values=new Map<string,string>();let executeLive=false;
  for(let index=0;index<argv.length;index++){
    const flag=argv[index]!;
    if(flag==='--execute-live'){assert.equal(executeLive,false,'--execute-live duplicated');executeLive=true;continue;}
    assert.ok(['--candidate','--output'].includes(flag)&&!values.has(flag),`unsupported or duplicate argument: ${flag}`);
    const value=argv[++index];assert.ok(value&&path.isAbsolute(value),`${flag} must be absolute`);values.set(flag,path.resolve(value));
  }
  assert.equal(values.size,2,'required: --candidate ABS --output ABS [--execute-live]');
  return{candidate:values.get('--candidate')!,output:values.get('--output')!,executeLive};
}

export function resolveCandidateDocumentWorkerSettings(candidate:string):{enabled:boolean;url:string}{
  assert.ok(path.isAbsolute(candidate),'candidate must be absolute');
  const readObject=(file:string,label:string):Json=>{
    const info=lstatSync(file);assert.ok(info.isFile()&&!info.isSymbolicLink(),`${label} must be a regular non-symlink file`);
    const value=JSON.parse(readFileSync(file,'utf8')) as unknown;assert.ok(value&&typeof value==='object'&&!Array.isArray(value),`${label} must contain a JSON object`);return value as Json;
  };
  const settingsFile=path.join(candidate,'app','config','chat.config.json'),settings=readObject(settingsFile,'chat.config.json');
  assert.ok(typeof settings.dataRoot==='string'&&path.isAbsolute(settings.dataRoot),'chat.config.json dataRoot must be absolute');
  const dataRoot=path.resolve(settings.dataRoot),dataInfo=lstatSync(dataRoot);assert.ok(dataInfo.isDirectory()&&!dataInfo.isSymbolicLink(),'chat dataRoot must be a regular directory');
  const services=readObject(path.join(dataRoot,'config','chat-services.json'),'chat-services.json'),documentWorker=services.documentWorker;
  assert.ok(documentWorker&&typeof documentWorker==='object'&&!Array.isArray(documentWorker),'chat-services.json documentWorker config is required');
  assert.equal(typeof documentWorker.enabled,'boolean','documentWorker.enabled must be boolean');assert.equal(typeof documentWorker.url,'string','documentWorker.url is required');
  let url:URL;try{url=new URL(documentWorker.url);}catch{throw new Error('documentWorker.url must be a local HTTP root URL');}
  assert.ok(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/', 'documentWorker.url must be a local HTTP root URL');
  return{enabled:documentWorker.enabled,url:documentWorker.url};
}

function normalJobs(value:unknown):boolean{
  if(!Array.isArray(value)||value.length!==3)return false;
  const phases=['version','discovery','isolated'];
  return phases.every(phase=>value.filter(item=>item?.phase===phase).length===1)
    &&value.every(item=>item&&item.confirmed===true&&item.rootExited===true&&(item.activeProcesses??item.jobActiveProcesses)===0);
}
export function assertNativeMediaInvocation(result:InvocationResult,kind:Operation['kind'],expected:{model:string;effort:string;version:string;cancelled?:boolean;sourceHash?:string}):void{
  const evidence=result.evidence;
  assert.equal(evidence.version,expected.version);assert.equal(evidence.model,expected.model);assert.equal(evidence.effort,expected.effort);
  assert.equal(evidence.nativeCliInvocations,1);assert.equal(evidence.appServerProcessCount,2);assert.equal(evidence.turnRequested,true);assert.ok(evidence.threadId&&evidence.turnId);
  assert.equal(evidence.preflightPolicyVerified,true);assert.equal(evidence.threadPolicyVerified,true);assert.ok(evidence.preflightPolicy&&evidence.threadPolicy);
  assert.equal(normalJobs(evidence.jobEvidence),true,'Codex media Job tree evidence incomplete');
  if(expected.cancelled){
    assert.equal(result.finishReason,'cancelled');assert.equal(result.exitConfirmed,true);assert.equal(result.image,undefined);assert.equal(evidence.imageGenerationStarted,1);assert.equal(evidence.imageGenerationCompleted,0);assert.equal(evidence.scratch,null);
    return;
  }
  assert.equal(result.finishReason,'completed');assert.equal(result.exitConfirmed,true);assert.equal(evidence.scratch,null);
  if(kind==='read'){
    assert.equal(evidence.imageGenerationStarted,0);assert.equal(evidence.imageGenerationCompleted,0);assert.ok(result.text.trim());assert.equal(result.image,undefined);
  }else{
    assert.equal(evidence.imageGenerationStarted,1);assert.equal(evidence.imageGenerationCompleted,1);assert.ok(result.image?.length);assert.equal(evidence.observedInputImages.length,kind==='edit'?1:0);
  }
  if(expected.sourceHash!==undefined){assert.equal(result.sourceHash,expected.sourceHash);assert.equal(evidence.stagedInput?.sha256,expected.sourceHash);if(kind==='edit')assert.equal(evidence.observedInputImages[0]?.sha256,expected.sourceHash);}
}

export function assertNativeMediaPreflight(result:InvocationResult,expected:{model:string;effort:string;version:string}):void{
  const evidence=result.evidence;
  assert.equal(result.finishReason,'completed');assert.equal(result.exitConfirmed,true);assert.equal(result.image,undefined);assert.equal(result.sourceHash,undefined);
  assert.equal(evidence.version,expected.version);assert.equal(evidence.model,expected.model);assert.equal(evidence.effort,expected.effort);
  assert.equal(evidence.nativeCliInvocations,0);assert.equal(evidence.appServerProcessCount,2);assert.equal(evidence.turnRequested,false);
  assert.ok(evidence.threadId);assert.equal(evidence.turnId,'');assert.equal(evidence.imageGenerationStarted,0);assert.equal(evidence.imageGenerationCompleted,0);
  assert.ok(evidence.discoveryInventory&&Array.isArray(evidence.discoveryInventory.mcpServers)&&Array.isArray(evidence.discoveryInventory.plugins));
  assert.equal(evidence.preflightPolicyVerified,true);assert.equal(evidence.threadPolicyVerified,true);assert.ok(evidence.preflightPolicy&&evidence.threadPolicy);
  assert.equal(normalJobs(evidence.jobEvidence),true,'Codex media preflight Job tree evidence incomplete');assert.equal(evidence.scratch,null);
}

export function meaningfulFixtureReading(text:string):boolean{
  return /(?:蓝|blue)/iu.test(text)&&/(?:黄|yellow)/iu.test(text)&&/(?:正方|方形|square)/iu.test(text)&&/(?:圆|circle)/iu.test(text);
}

export function recordNativeMediaResult(stage:Json,result:InvocationResult):void{
  stage.finishReason=result.finishReason;stage.exitConfirmed=result.exitConfirmed;stage.evidence=result.evidence;
}

export function recordNativeMediaFailure(stage:Json,error:unknown):void{
  const value=error as Json;stage.passed=false;stage.completedAt=at();stage.error=error instanceof Error?error.message:String(error);
  if(stage.exitConfirmed===undefined)stage.exitConfirmed=value?.exitConfirmed??value?.evidence?.scratch===null;
  if(stage.evidence===undefined&&value?.evidence!==undefined)stage.evidence=value.evidence;
}

export function recordNativeMediaReportFailure(report:Json,error:unknown):void{
  const value=error as Json;report.error=error instanceof Error?error.message:String(error);
  if(value?.exitConfirmed!==undefined||value?.evidence!==undefined)report.failure={exitConfirmed:value?.exitConfirmed??value?.evidence?.scratch===null,evidence:value?.evidence};
}

export function qualificationSummary(stages:Array<{name:string;passed:boolean;evidence?:Evidence}>,visualReviewPassed=false,workspaceBoundaryPassed=false){
  const names=new Set(stages.filter(stage=>stage.passed).map(stage=>stage.name));
  const functional=['generate','read','edit','cancel'].every(name=>names.has(name));
  const evidence=stages.flatMap(stage=>stage.evidence?[stage.evidence]:[]);
  const nativeSurface=evidence.length===4&&evidence.every(item=>item.preflightPolicyVerified&&item.threadPolicyVerified);
  const processTrees=evidence.length===4&&evidence.every(item=>item.appServerProcessCount===2&&normalJobs(item.jobEvidence));
  return{
    functionalPassed:functional,
    visualReviewPassed,
    workspaceBoundaryPassed,
    proofReady:functional&&visualReviewPassed&&workspaceBoundaryPassed&&nativeSurface&&processTrees,
    verifiedTests:{
      readVerified:names.has('read'),generateVerified:names.has('generate'),editVerified:names.has('edit'),cancellationConfirmed:names.has('cancel'),
      normalExitTreeVerified:functional&&processTrees,windowsJobTreeVerified:functional&&processTrees,imageDecodeVerified:names.has('generate')&&names.has('edit'),
      inputHashVerified:names.has('edit'),workspaceBoundaryVerified:workspaceBoundaryPassed,nativeSurfaceVerified:functional&&nativeSurface,
    },
    pending:[...(!visualReviewPassed?['independent_visual_review']:[]),...(!workspaceBoundaryPassed?['native_image_filesystem_boundary_evidence']:[])],
  };
}

async function main():Promise<void>{
  const args=parseNativeMediaProbeArgs(process.argv.slice(2));
  if(!args){process.stdout.write('Usage: CANDIDATE\\runtime\\node.exe --import tsx scripts/chat-live-native-media-probe.ts --candidate ABS --output NEW_ABS [--execute-live]\n');return;}
  const app=path.join(args.candidate,'app'),candidateNode=path.join(args.candidate,'runtime','node.exe');
  const report:Json={schema:'dual-model-workbench/native-codex-media-live/v1',candidate:args.candidate,startedAt:at(),executeLive:args.executeLive,maxInferenceSegments:MAX_SEGMENTS,paidSegmentsAttempted:0,prepared:false,readyForLive:false,functionalPassed:false,passed:false,proofReady:false,stages:[],artifacts:[]};
  let outputCreated=false;
  const persist=()=>writeFileSync(path.join(args.output,'result.json'),`${JSON.stringify(report,null,2)}\n`);
  try{
    assertFreshWorkOutput(args.output,WORK_ROOT);mkdirSync(args.output);outputCreated=true;persist();
    validateCandidateFiles(args.candidate);
    assert.equal(path.resolve(process.execPath).toLowerCase(),path.resolve(candidateNode).toLowerCase(),'Probe must run with the candidate runtime node.exe');
    const documentWorker=resolveCandidateDocumentWorkerSettings(args.candidate);
    const load=(relative:string)=>import(pathToFileURL(path.join(app,relative)).href);
    const[{loadConfig},nativeModule,{DocumentProvider}]=await Promise.all([load('src/config.js'),load('src/chat/codex-native-media.js'),load('src/chat/document-provider.js')]);
    const config=loadConfig(path.join(app,'config/workbench.config.json'),app);
    const expected={model:config.models.sol.model,effort:config.models.sol.effort,version:nativeModule.NATIVE_MEDIA_CODEX_VERSION};
    assert.equal(typeof nativeModule.runQualifiedNativeCodexMedia,'function');assert.equal(typeof nativeModule.runNativeCodexMediaPreflight,'function');assert.equal(typeof nativeModule.nativeCodexMediaFingerprint,'function');
    const fingerprint=nativeModule.nativeCodexMediaFingerprint(config);
    const documents=new DocumentProvider({} as any,()=>documentWorker);
    const service=await documents.status();assert.equal(service.state,'ready','Document image decoder must be ready');
    const nativePreflightStage:Json={passed:false,startedAt:at()};
    report.preflight={candidateManifestSha256:sha(readFileSync(path.join(args.candidate,'chat-source-manifest.json'))),candidateNodeSha256:sha(readFileSync(candidateNode)),fingerprint,model:expected.model,effort:expected.effort,version:expected.version,documentService:service,native:nativePreflightStage};persist();
    try{
      const nativePreflight:InvocationResult=await nativeModule.runNativeCodexMediaPreflight(config,{scratchRoot:path.join(args.output,'preflight-scratch'),signal:new AbortController().signal,timeoutMs:300_000});
      recordNativeMediaResult(nativePreflightStage,nativePreflight);nativePreflightStage.text=nativePreflight.text;persist();
      assertNativeMediaPreflight(nativePreflight,expected);nativePreflightStage.passed=true;nativePreflightStage.completedAt=at();persist();
    }catch(error){recordNativeMediaFailure(nativePreflightStage,error);persist();throw error;}
    report.prepared=true;report.readyForLive=true;persist();
    if(!args.executeLive)return;

    const scratchRoot=path.join(args.output,'scratch');mkdirSync(scratchRoot);
    let source:{name:string;mime:string;bytes:Buffer;sha256:string}|undefined;
    const run=async(name:'generate'|'read'|'edit'|'cancel',operation:Operation,cancelOnImage=false)=>{
      assert.ok(report.paidSegmentsAttempted<MAX_SEGMENTS,'Native media segment budget exceeded');
      const stage:Json={name,startedAt:at(),phases:[],paidSegmentAttempted:false,passed:false};report.stages.push(stage);persist();
      const controller=new AbortController();
      try{
        const result:InvocationResult=await nativeModule.runQualifiedNativeCodexMedia(config,operation,{scratchRoot,signal:controller.signal,timeoutMs:300_000,onPhase:(phase:Phase)=>{
          stage.phases.push({phase,at:at()});
          if(phase==='turn-requested'&&!stage.paidSegmentAttempted){stage.paidSegmentAttempted=true;report.paidSegmentsAttempted++;assert.ok(report.paidSegmentsAttempted<=MAX_SEGMENTS);}
          if(cancelOnImage&&phase==='image-started')setTimeout(()=>controller.abort('qualification cancellation'),0);
          persist();
        }});
        recordNativeMediaResult(stage,result);persist();
        assertNativeMediaInvocation(result,name==='cancel'?'generate':name,{...expected,cancelled:cancelOnImage,sourceHash:name==='read'||name==='edit'?source?.sha256:undefined});
        if(name==='read'){
          assert.equal(meaningfulFixtureReading(result.text),true,'Image reading did not identify the requested colors and shapes');stage.semanticReading=result.text;
        }
        if((name==='generate'||name==='edit')&&result.image){
          const decoded=await documents.inspectImage({name:`${name}.bin`,mime:'application/octet-stream',bytes:result.image},controller.signal);
          const extension=decoded.mime==='image/png'?'png':decoded.mime==='image/webp'?'webp':'jpg',file=path.join(args.output,`${name}.${extension}`);
          writeFileSync(file,result.image,{flag:'wx'});const digest=sha(result.image);stage.image={file,mime:decoded.mime,width:decoded.width,height:decoded.height,bytes:result.image.length,sha256:digest};report.artifacts.push(stage.image);
          if(name==='generate')source={name:path.basename(file),mime:decoded.mime,bytes:result.image,sha256:digest};
          else{assert.ok(source);assert.notEqual(digest,source.sha256,'Edited image bytes equal source image');}
        }
        stage.passed=true;stage.completedAt=at();
        persist();return result;
      }catch(error){
        recordNativeMediaFailure(stage,error);persist();throw error;
      }
    };

    await run('generate',{kind:'generate',size:'1024x1024',prompt:'生成一张简洁测试图：纯白背景，左侧一个明显的蓝色正方形，右侧一个明显的黄色圆形。不要文字、阴影、渐变或其他图形。'});
    assert.ok(source);
    await run('read',{kind:'read',prompt:NATIVE_MEDIA_READ_PROMPT,input:source});
    await run('edit',{kind:'edit',size:'1024x1024',prompt:'编辑所附图片：只把蓝色正方形改成红色正方形；黄色圆形、白色背景、位置和构图保持不变；不要添加文字或其他元素。',input:source});
    await run('cancel',{kind:'generate',size:'1024x1024',prompt:'生成一张纯白背景、中央一个绿色三角形的简洁测试图。不要文字或其他元素。'},true);
    const summary=qualificationSummary(report.stages,false,false);Object.assign(report,summary,{functionalPassed:summary.functionalPassed,passed:false,proofReady:false,proofPublication:'pending; root must complete independent visual and filesystem-boundary review'});
  }catch(error){
    recordNativeMediaReportFailure(report,error);process.exitCode=1;
  }
  finally{report.endedAt=at();if(outputCreated)persist();process.stdout.write(`${JSON.stringify({output:args.output,prepared:report.prepared,readyForLive:report.readyForLive,functionalPassed:report.functionalPassed,proofReady:report.proofReady,paidSegmentsAttempted:report.paidSegmentsAttempted,error:report.error})}\n`);}
}

const isMain=process.argv[1]!==undefined&&path.resolve(process.argv[1])===path.resolve(fileURLToPath(import.meta.url));
if(isMain)void main();
