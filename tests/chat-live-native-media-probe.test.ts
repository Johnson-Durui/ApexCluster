import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NATIVE_MEDIA_READ_PROMPT, assertNativeMediaInvocation, assertNativeMediaPreflight, meaningfulFixtureReading, parseNativeMediaProbeArgs, qualificationSummary, recordNativeMediaFailure, recordNativeMediaReportFailure, recordNativeMediaResult, resolveCandidateDocumentWorkerSettings } from '../scripts/chat-live-native-media-probe.js';

const job=(phase:string)=>({phase,confirmed:true,rootExited:true,activeProcesses:0});
const evidence=(overrides:Record<string,unknown>={})=>({version:'codex-cli 0.165.0-alpha.1.2',model:'gpt-6.2-sol',effort:'max',threadId:'thread',turnId:'turn',nativeCliInvocations:1,appServerProcessCount:2,turnRequested:true,imageGenerationStarted:1,imageGenerationCompleted:1,preflightPolicyVerified:true,threadPolicyVerified:true,discoveryInventory:{mcpServers:[],plugins:[]},preflightPolicy:{features:{}},threadPolicy:{surface:{}},observedInputImages:[],stagedInput:null,workspaceRoot:'E:\\work',inputRoot:'E:\\work\\input',outputRoot:'E:\\work\\output',jobEvidence:[job('version'),job('discovery'),job('isolated')],scratch:null,...overrides});
const expected={version:'codex-cli 0.165.0-alpha.1.2',model:'gpt-6.2-sol',effort:'max'};

function candidateFixture(url='http://127.0.0.1:18782'){
  const root=mkdtempSync(path.join(tmpdir(),'native-media-candidate-')),candidate=path.join(root,'candidate'),dataRoot=path.join(root,'data');
  mkdirSync(path.join(candidate,'app','config'),{recursive:true});mkdirSync(path.join(dataRoot,'config'),{recursive:true});
  writeFileSync(path.join(candidate,'app','config','chat.config.json'),JSON.stringify({dataRoot}));
  writeFileSync(path.join(dataRoot,'config','chat-services.json'),JSON.stringify({version:1,documentWorker:{enabled:true,url}}));
  return{root,candidate,dataRoot};
}

test('native media probe selects the candidate document worker without a legacy port fallback',()=>{
  for(const url of ['http://127.0.0.1:18782','http://127.0.0.1:18781']){
    const fixture=candidateFixture(url);
    try{assert.deepEqual(resolveCandidateDocumentWorkerSettings(fixture.candidate),{enabled:true,url});}
    finally{rmSync(fixture.root,{recursive:true,force:true});}
  }
});

test('native media probe rejects missing or unsafe candidate service config before native preflight',()=>{
  const missing=mkdtempSync(path.join(tmpdir(),'native-media-missing-'));
  try{mkdirSync(path.join(missing,'app','config'),{recursive:true});assert.throws(()=>resolveCandidateDocumentWorkerSettings(missing),/chat\.config\.json/);}
  finally{rmSync(missing,{recursive:true,force:true});}

  const missingServices=candidateFixture();
  try{rmSync(path.join(missingServices.dataRoot,'config','chat-services.json'));assert.throws(()=>resolveCandidateDocumentWorkerSettings(missingServices.candidate),/chat-services\.json/);}
  finally{rmSync(missingServices.root,{recursive:true,force:true});}

  const noWorker=candidateFixture();
  try{writeFileSync(path.join(noWorker.dataRoot,'config','chat-services.json'),JSON.stringify({version:1}));assert.throws(()=>resolveCandidateDocumentWorkerSettings(noWorker.candidate),/documentWorker config is required/);}
  finally{rmSync(noWorker.root,{recursive:true,force:true});}

  const noUrl=candidateFixture();
  try{writeFileSync(path.join(noUrl.dataRoot,'config','chat-services.json'),JSON.stringify({version:1,documentWorker:{enabled:true}}));assert.throws(()=>resolveCandidateDocumentWorkerSettings(noUrl.candidate),/documentWorker\.url is required/);}
  finally{rmSync(noUrl.root,{recursive:true,force:true});}

  for(const url of ['https://127.0.0.1:18782','http://example.com:18782','http://user:pass@127.0.0.1:18782/','http://127.0.0.1:18782/path','http://127.0.0.1:18782/?query=1','http://127.0.0.1:18782/#fragment']){
    const fixture=candidateFixture(url);
    try{assert.throws(()=>resolveCandidateDocumentWorkerSettings(fixture.candidate),/local HTTP root/);}
    finally{rmSync(fixture.root,{recursive:true,force:true});}
  }

  const relative=candidateFixture();
  try{writeFileSync(path.join(relative.candidate,'app','config','chat.config.json'),JSON.stringify({dataRoot:'relative-data'}));assert.throws(()=>resolveCandidateDocumentWorkerSettings(relative.candidate),/dataRoot.*absolute/);}
  finally{rmSync(relative.root,{recursive:true,force:true});}

  const linked=candidateFixture();
  try{
    const target=path.join(linked.root,'linked-data');rmSync(linked.dataRoot,{recursive:true,force:true});mkdirSync(path.join(target,'config'),{recursive:true});
    writeFileSync(path.join(target,'config','chat-services.json'),JSON.stringify({version:1,documentWorker:{enabled:true,url:'http://127.0.0.1:18782'}}));symlinkSync(target,linked.dataRoot,'junction');
    assert.throws(()=>resolveCandidateDocumentWorkerSettings(linked.candidate),/dataRoot.*regular directory/);
  }finally{rmSync(linked.root,{recursive:true,force:true});}
});

test('native media probe CLI is strict and defaults to no live execution',()=>{
  const candidate=path.join(tmpdir(),'candidate'),output=path.join(tmpdir(),'work','fresh');
  assert.deepEqual(parseNativeMediaProbeArgs(['--candidate',candidate,'--output',output]),{candidate,output,executeLive:false});
  assert.equal(parseNativeMediaProbeArgs(['--help']),null);
  assert.throws(()=>parseNativeMediaProbeArgs(['--candidate','relative','--output',output]));
  assert.throws(()=>parseNativeMediaProbeArgs(['--candidate',candidate,'--output',output,'--execute-live','--execute-live']),/duplicated/);
});

test('native media stage evidence accepts bound generate/read/edit/cancel and fails closed',()=>{
  assert.doesNotThrow(()=>assertNativeMediaInvocation({text:'done',image:Buffer.from('image'),exitConfirmed:true,finishReason:'completed',evidence:evidence()},'generate',expected));
  const sourceHash='a'.repeat(64),editEvidence=evidence({observedInputImages:[{path:'E:\\work\\input\\source.png',sha256:sourceHash}],stagedInput:{path:'E:\\work\\input\\source.png',sha256:sourceHash}});
  assert.doesNotThrow(()=>assertNativeMediaInvocation({text:'蓝色正方形和黄色圆形',sourceHash,exitConfirmed:true,finishReason:'completed',evidence:evidence({imageGenerationStarted:0,imageGenerationCompleted:0,stagedInput:{path:'E:\\work\\input\\source.png',sha256:sourceHash}})},'read',{...expected,sourceHash}));
  assert.doesNotThrow(()=>assertNativeMediaInvocation({text:'done',image:Buffer.from('edited'),sourceHash,exitConfirmed:true,finishReason:'completed',evidence:editEvidence},'edit',{...expected,sourceHash}));
  assert.doesNotThrow(()=>assertNativeMediaInvocation({text:'',exitConfirmed:true,finishReason:'cancelled',evidence:evidence({imageGenerationStarted:1,imageGenerationCompleted:0})},'generate',{...expected,cancelled:true}));
  assert.throws(()=>assertNativeMediaInvocation({text:'done',image:Buffer.from('image'),exitConfirmed:true,finishReason:'completed',evidence:evidence({jobEvidence:[job('version')]})},'generate',expected),/Job tree/);
  assert.throws(()=>assertNativeMediaInvocation({text:'done',image:Buffer.from('image'),exitConfirmed:true,finishReason:'completed',evidence:evidence({jobEvidence:[job('version'),job('discovery'),job('discovery')]})},'generate',expected),/Job tree/);
  assert.throws(()=>assertNativeMediaInvocation({text:'done',image:Buffer.from('image'),exitConfirmed:true,finishReason:'completed',evidence:evidence({appServerProcessCount:3})},'generate',expected));
  assert.throws(()=>assertNativeMediaInvocation({text:'',exitConfirmed:false,finishReason:'exit_unknown',evidence:evidence({scratch:'E:\\preserved'})},'generate',{...expected,cancelled:true}));
});

test('native media default preflight proves policy and process cleanup without requesting a turn',()=>{
  const preflight={text:'preflight complete',exitConfirmed:true,finishReason:'completed',evidence:evidence({turnId:'',nativeCliInvocations:0,turnRequested:false,imageGenerationStarted:0,imageGenerationCompleted:0})};
  assert.doesNotThrow(()=>assertNativeMediaPreflight(preflight,expected));
  assert.throws(()=>assertNativeMediaPreflight({...preflight,evidence:{...preflight.evidence,turnRequested:true,nativeCliInvocations:1}},expected));
  assert.throws(()=>assertNativeMediaPreflight({...preflight,evidence:{...preflight.evidence,imageGenerationStarted:1}},expected));
  const nativeStage:Record<string,unknown>={passed:false};const preflightError=Object.assign(new Error('preflight policy rejected'),{exitConfirmed:true,evidence:preflight.evidence});
  recordNativeMediaFailure(nativeStage,preflightError);assert.equal(nativeStage.passed,false);assert.equal(nativeStage.exitConfirmed,true);assert.equal(nativeStage.evidence,preflight.evidence);
  const report:Record<string,unknown>={};const failure=Object.assign(new Error('policy rejected'),{exitConfirmed:true,evidence:preflight.evidence});
  recordNativeMediaReportFailure(report,failure);assert.equal(report.error,'policy rejected');assert.deepEqual(report.failure,{exitConfirmed:true,evidence:preflight.evidence});
});

test('semantic and proof summaries never promote functional output without independent gates',()=>{
  assert.doesNotMatch(NATIVE_MEDIA_READ_PROMPT,/(?:蓝|blue|黄|yellow|正方|square|圆|circle)/iu);
  assert.equal(meaningfulFixtureReading('图片显示蓝色正方形和黄色圆形。'),true);
  assert.equal(meaningfulFixtureReading('图片里有两个形状。'),false);
  const stages=['generate','read','edit','cancel'].map(name=>({name,passed:true,evidence:evidence({imageGenerationStarted:name==='read'?0:1,imageGenerationCompleted:['generate','edit'].includes(name)?1:0})}));
  const pending=qualificationSummary(stages,false,false);assert.equal(pending.functionalPassed,true);assert.equal(pending.proofReady,false);assert.deepEqual(pending.pending,['independent_visual_review','native_image_filesystem_boundary_evidence']);
  const complete=qualificationSummary(stages,true,true);assert.equal(complete.proofReady,true);assert.equal(complete.verifiedTests.workspaceBoundaryVerified,true);
  const wrongReceiptCount=qualificationSummary(stages.map(stage=>({...stage,evidence:{...stage.evidence,appServerProcessCount:3}})),true,true);
  assert.equal(wrongReceiptCount.proofReady,false);assert.equal(wrongReceiptCount.verifiedTests.windowsJobTreeVerified,false);
});

test('a later assertion failure preserves the completed invocation exit evidence and forces the stage to fail',()=>{
  const stage:Record<string,unknown>={name:'generate',passed:false};
  const result={text:'done',image:Buffer.from('image'),exitConfirmed:true,finishReason:'completed',evidence:evidence()};
  recordNativeMediaResult(stage,result);
  stage.passed=true;
  recordNativeMediaFailure(stage,new Error('post-result image decode failed'));
  assert.equal(stage.passed,false);
  assert.equal(stage.exitConfirmed,true);
  assert.equal(stage.evidence,result.evidence);
  assert.equal(stage.finishReason,'completed');
});
