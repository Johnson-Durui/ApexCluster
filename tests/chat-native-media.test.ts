import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildCodexMediaIsolationArgs, parseCodexIsolationMetadata, validateCodexMediaIsolation, type CodexInventory } from '../src/chat/codex-policy.js';
import { ExtensionHost, extensionConfigSchema } from '../src/chat/extensions/index.js';
import { NATIVE_MEDIA_REQUIRED_TESTS, NativeCodexMediaProvider, buildNativeMediaEnvironments, buildNativeMediaTurnInput, consumeNativeMediaNotification, extractNativeImageItem, nativeMediaExitConfirmed, verifyNativeStagedInput, type NativeMediaInvocationResult, type NativeMediaNotificationState, type NativeMediaProof } from '../src/chat/codex-native-media.js';
import { ChatDriverError } from '../src/chat/drivers.js';
import type { CapabilityCall, ChatCapabilityHost } from '../src/chat/capability-contract.js';
import type { ChatAttachment, ChatRecord } from '../src/chat/types.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const hash=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
const chat=():ChatRecord=>({version:1,id:'chat',title:'test',createdAt:'',updatedAt:'',seq:0,messageSeq:0,turns:[],tasks:[],invocations:[],tickets:[],artifacts:[],checkpoints:[],constraintMessageIds:[]});
const task={id:'task',turnId:'turn',role:'claude' as const,goal:'test',status:'running' as const,createdAt:'',updatedAt:'',segment:1,invocationIds:[],noProgressSegments:0,mode:'read' as const};
const invocation={id:'inv',taskId:'task',segment:1,status:'running' as const,startedAt:'',toolCount:0,promptVersion:'x',inputEstimate:0,contextWindow:null,contextUsed:null};
const context=():CapabilityCall=>({chat:chat(),task,invocation,toolCallId:'inv:1',signal:new AbortController().signal});
const discovery:CodexInventory={mcpServers:[{name:'direct',pluginId:null,runtimeStatus:null,toolCount:1}],plugins:[{id:'p',enabled:true}]};

test('native Codex media configuration is explicit and allows a bounded long timeout',()=>{
  const parsed=extensionConfigSchema.parse({version:1,media:{codex:{enabled:true,allowSubscriptionCalls:false}}});
  assert.deepEqual(parsed.media.codex,{enabled:true,allowSubscriptionCalls:false,timeoutMs:180_000});
  assert.throws(()=>extensionConfigSchema.parse({version:1,media:{codex:{enabled:true,allowSubscriptionCalls:true,timeoutMs:900_001}}}));
});

test('staged input verification refuses a replaced link before reading it',()=>{
  const root=mkdtempSync(path.join(process.cwd(),'.test-tmp','native-staged-')),staged=path.join(root,'staged.png'),outside=path.join(root,'outside.png');writeFileSync(staged,png);writeFileSync(outside,png);
  try{verifyNativeStagedInput({path:staged,sha256:hash(png)});rmSync(staged);try{symlinkSync(outside,staged,'file');assert.throws(()=>verifyNativeStagedInput({path:staged,sha256:hash(png)}),/链接/);}catch(error){if(!(error instanceof Error)||!['EPERM','EACCES'].includes((error as NodeJS.ErrnoException).code??''))throw error;}}
  finally{rmSync(root,{recursive:true,force:true});}
});

test('native media policy enables only image generation and validates the dedicated profile',()=>{
  const args=buildCodexMediaIsolationArgs(discovery);
  assert.deepEqual(args.slice(0,6),['--enable','prefer_mxc','--enable','skip_host_skill_discovery','--enable','image_generation']);
  for(const feature of ['shell_tool','view_image','artifact'])assert.ok(args.includes(feature));
  assert.equal(args.some((value,index)=>value==='--disable'&&args[index+1]==='unified_exec'),false);
  const features=['apps','plugins','hooks','multi_agent','skill_search','browser_use','computer_use','in_app_browser','shell_tool','view_image','artifact'].map(name=>({name,enabled:false}));
  features.push({name:'unified_exec',enabled:true});
  features.push({name:'image_generation',enabled:true},{name:'skip_host_skill_discovery',enabled:true});
  const metadata=parseCodexIsolationMetadata({features,profiles:[{id:'workbench-native-media'}],mcpServers:discovery.mcpServers.map(item=>({...item,runtimeStatus:'disabled',tools:{}})),plugins:[],apps:[],hooks:[]});
  assert.deepEqual(validateCodexMediaIsolation(discovery,metadata),[]);
  metadata.features.set('shell_tool',true);
  assert.match(validateCodexMediaIsolation(discovery,metadata).join(';'),/shell_tool/);
  metadata.features.set('unified_exec',false);
  assert.match(validateCodexMediaIsolation(discovery,metadata).join(';'),/shell_tool/);
});

test('native media accepts the fixed RPC passive item sequence but still rejects native tools',()=>{
  const state:NativeMediaNotificationState={threadId:'thread',turnId:'turn',startedImages:0,startedImageIds:new Set(),completedItems:[]};
  for(const method of ['item/started','item/completed'])assert.deepEqual(consumeNativeMediaNotification({method,params:{threadId:'thread',turnId:'turn',item:{id:'user-input',type:'userMessage',content:[{type:'text',text:'USER_INPUT_MUST_NOT_BECOME_ASSISTANT_OUTPUT'}]}}},state),{imageStarted:false,textDelta:''});
  for(const type of ['reasoning','agentMessage'])for(const method of ['item/started','item/completed'])assert.doesNotThrow(()=>consumeNativeMediaNotification({method,params:{threadId:'thread',turnId:'turn',item:{id:`${type}-${method}`,type}}},state));
  assert.deepEqual(consumeNativeMediaNotification({method:'item/agentMessage/delta',params:{threadId:'thread',turnId:'turn',delta:'answer'}},state),{imageStarted:false,textDelta:'answer'});
  assert.deepEqual(consumeNativeMediaNotification({method:'item/started',params:{threadId:'thread',turnId:'turn',item:{id:'image',type:'imageGeneration'}}},state),{imageStarted:true,textDelta:''});state.startedImages++;
  assert.deepEqual(consumeNativeMediaNotification({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{id:'image',type:'imageGeneration',status:'completed'}}},state),{imageStarted:false,textDelta:''});
  assert.equal(state.completedItems.length,1);
  for(const type of ['commandExecution','fileChange','mcpToolCall','dynamicToolCall','webSearch','imageView','functionCallOutput','hookPrompt'])assert.throws(()=>consumeNativeMediaNotification({method:'item/started',params:{threadId:'thread',turnId:'turn',item:{id:type,type}}},state),new RegExp(type));
});

test('native edit directs the image tool to the staged path instead of pathless history',()=>{
  const staged={path:'E:\\safe\\input\\source.png',sha256:'a'.repeat(64)},input=buildNativeMediaTurnInput({kind:'edit',prompt:'change it',size:'1024x1024'},staged);
  assert.equal(input[1]?.path,staged.path);assert.equal(input[1]?.restrictedEnvironmentAccess,true);
  assert.match(input[0]?.text,/referenced_image_paths/);assert.match(input[0]?.text,/不得使用 num_last_images_to_include/);assert.ok(input[0]?.text.includes(JSON.stringify(staged.path)));
  const generated=buildNativeMediaTurnInput({kind:'generate',prompt:'draw'});assert.doesNotMatch(generated[0]?.text,/referenced_image_paths|num_last_images_to_include/);
});

test('native media binds a non-empty local environment only to the private scratch',()=>{
  const scratch=path.resolve('work/native-media-scratch'),environments=buildNativeMediaEnvironments(scratch);
  assert.deepEqual(environments,[{environmentId:'local',cwd:scratch,runtimeWorkspaceRoots:[scratch]}]);
  assert.throws(()=>buildNativeMediaEnvironments('relative-scratch'),/绝对路径/);
});

test('native image item accepts only one bound input and a bounded real artifact',()=>{
  const root=mkdtempSync(path.join(process.cwd(),'.test-tmp','native-item-')),output=path.join(root,'generated_images'),session=path.join(output,'session_1'),input=path.join(root,'input.png');mkdirSync(session,{recursive:true});writeFileSync(input,png);const saved=path.join(session,'call_1.png');writeFileSync(saved,png);
  try{
    assert.deepEqual(extractNativeImageItem({id:'call_1',type:'imageGeneration',status:'completed',failure:null,savedPath:saved,inputImages:[{path:input,sha256:hash(png)}]},output,{path:input,sha256:hash(png)},'session_1'),png);
    assert.throws(()=>extractNativeImageItem({id:'call_1',type:'imageGeneration',status:'completed',failure:null,savedPath:saved,inputImages:[{path:'wrong',sha256:hash(png)}]},output,{path:input,sha256:hash(png)},'session_1'),/来源绑定/);
    assert.throws(()=>extractNativeImageItem({id:'call_1',type:'imageGeneration',status:'completed',failure:null,result:png.toString('base64'),inputImages:[]},output,undefined,'session_1'),/savedPath/);
    assert.throws(()=>extractNativeImageItem({id:'call_1',type:'imageGeneration',status:'completed',failure:null,fileId:'opaque',inputImages:[]},output,undefined,'session_1'),/savedPath/);
    assert.throws(()=>extractNativeImageItem({id:'other',type:'imageGeneration',status:'completed',failure:null,savedPath:saved,inputImages:[]},output,undefined,'session_1'),/调用绑定/);
    assert.throws(()=>extractNativeImageItem({id:'call_1',type:'imageGeneration',status:'completed',failure:null,savedPath:saved,inputImages:[]},output,undefined,'wrong-thread'),/线程/);
    const outside=path.join(root,'outside','session_1');mkdirSync(outside,{recursive:true});const outsideFile=path.join(outside,'call_1.png');writeFileSync(outsideFile,png);assert.throws(()=>extractNativeImageItem({id:'call_1',type:'imageGeneration',status:'completed',failure:null,savedPath:outsideFile,inputImages:[]},output,undefined,'session_1'),/越界/);
    const big=path.join(session,'large.png');writeFileSync(big,Buffer.alloc(20*1024*1024+1));assert.throws(()=>extractNativeImageItem({id:'large',type:'imageGeneration',status:'completed',failure:null,savedPath:big,inputImages:[]},output,undefined,'session_1'),/大小/);
    const linked=path.join(output,'linked');try{symlinkSync(outside,linked,'junction');assert.throws(()=>extractNativeImageItem({id:'call_1',type:'imageGeneration',status:'completed',failure:null,savedPath:path.join(linked,'call_1.png'),inputImages:[]},output,undefined,'linked'),/链接/);}catch(error){if(!(error instanceof Error)||!['EPERM','EACCES'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('proof-gated provider publishes decoded bytes and records one native invocation',async()=>{
  const root=mkdtempSync(path.join(process.cwd(),'.test-tmp','native-provider-'));
  try{
    const config=loadConfig(path.join(process.cwd(),'config','workbench.config.json'),process.cwd()),proofFile=path.join(root,'proof.json');
    const proof:NativeMediaProof={schema:'dual-model-workbench/native-codex-media-proof/v1',verifiedAt:new Date().toISOString(),version:'codex-cli 0.165.0-alpha.1.2',fingerprint:'test-fingerprint',policy:'codex-native-media-job-v1',model:config.models.sol.model,effort:config.models.sol.effort,verified:true,isolationVerified:true,tests:Object.fromEntries(NATIVE_MEDIA_REQUIRED_TESTS.map(name=>[name,true])) as NativeMediaProof['tests']};
    const metadata:ChatAttachment={id:'img',name:'source.png',bytes:png.length,hash:hash(png),mime:'image/png',createdAt:'',source:'upload',messageIds:['m']};
    const result:NativeMediaInvocationResult={text:'done',image:png,exitConfirmed:true,finishReason:'completed',evidence:{version:proof.version,model:proof.model,effort:proof.effort,threadId:'t',turnId:'v',nativeCliInvocations:1,appServerProcessCount:2,turnRequested:true,imageGenerationStarted:1,imageGenerationCompleted:1,imageGenerationStartedIds:['image'],preflightPolicyVerified:true,threadPolicyVerified:true,discoveryInventory:discovery,preflightPolicy:{},threadPolicy:{},observedInputImages:[],stagedInput:null,workspaceRoot:root,inputRoot:path.join(root,'input'),outputRoot:path.join(root,'generated_images'),outputBinding:'fixed-codex-cache/thread-and-call-id',jobEvidence:[],scratch:null}};
    const provider=new NativeCodexMediaProvider({config,proofFile,scratchRoot:root,settings:()=>({enabled:true,allowSubscriptionCalls:true,timeoutMs:180_000}),readFile:()=>({metadata,bytes:png}),inspectImage:async()=>({mime:'image/png',width:1,height:1}),invoke:async()=>result,testOnlyProofLoader:()=>({proof})});
    assert.deepEqual(provider.definitions(task).map(item=>item.name),['image_read','image_generate']);
    const reply=await provider.call('image_generate',{prompt:'draw'},context());assert.equal(reply.files?.[0]?.mime,'image/png');assert.deepEqual(reply.data,{width:1,height:1,bytes:png.length,hash:hash(png),sourceHash:undefined,nativeCliInvocations:1,appServerProcessCount:2,imageGenerationCount:1,modelRole:'sol',jobEvidence:[]});
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('unknown native process exit uses the Runtime blocking error contract',async()=>{
  assert.equal(nativeMediaExitConfirmed(true,new ChatDriverError('version tree unknown',false)),false);
  assert.equal(nativeMediaExitConfirmed(true,new Error('confirmed failure')),true);
  assert.equal(nativeMediaExitConfirmed(false,new Error('an earlier discovery client stop was unconfirmed and current is now null')),false);
  const root=mkdtempSync(path.join(process.cwd(),'.test-tmp','native-unknown-exit-'));
  try{
    const config=loadConfig(path.join(process.cwd(),'config','workbench.config.json'),process.cwd()),proof:NativeMediaProof={schema:'dual-model-workbench/native-codex-media-proof/v1',verifiedAt:new Date().toISOString(),version:'codex-cli 0.165.0-alpha.1.2',fingerprint:'test',policy:'codex-native-media-job-v1',model:config.models.sol.model,effort:config.models.sol.effort,verified:true,isolationVerified:true,tests:Object.fromEntries(NATIVE_MEDIA_REQUIRED_TESTS.map(name=>[name,true])) as NativeMediaProof['tests']};
    const evidence:NativeMediaInvocationResult['evidence']={version:proof.version,model:proof.model,effort:proof.effort,threadId:'t',turnId:'v',nativeCliInvocations:1,appServerProcessCount:2,turnRequested:true,imageGenerationStarted:1,imageGenerationCompleted:0,imageGenerationStartedIds:['image'],preflightPolicyVerified:true,threadPolicyVerified:true,discoveryInventory:discovery,preflightPolicy:{},threadPolicy:{},observedInputImages:[],stagedInput:null,workspaceRoot:root,inputRoot:path.join(root,'input'),outputRoot:path.join(root,'generated_images'),outputBinding:'fixed-codex-cache/thread-and-call-id',jobEvidence:[{confirmed:false}],scratch:root};
    let calls=0;const provider=new NativeCodexMediaProvider({config,proofFile:path.join(root,'proof.json'),scratchRoot:root,settings:()=>({enabled:true,allowSubscriptionCalls:true,timeoutMs:180_000}),readFile:()=>{throw new Error('unused');},inspectImage:async()=>({mime:'image/png',width:1,height:1}),invoke:async()=>{calls++;return{text:'',exitConfirmed:false,finishReason:'exit_unknown',evidence};},testOnlyProofLoader:()=>({proof})});
    await assert.rejects(()=>provider.call('image_generate',{prompt:'draw'},context()),error=>error instanceof ChatDriverError&&error.exitConfirmed===false&&Array.isArray((error as ChatDriverError&{evidence?:typeof evidence}).evidence?.jobEvidence));
    assert.equal((await provider.status())[0]?.state,'unavailable');await assert.rejects(()=>provider.call('image_generate',{prompt:'again'},context()),/需重启应用/);assert.equal(calls,1);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('enabled native mode never falls back to an independently billed API',async()=>{
  const root=mkdtempSync(path.join(process.cwd(),'.test-tmp','native-no-fallback-'));let calls=0;
  try{
    const native:ChatCapabilityHost={definitions:()=>[],status:async()=>[{id:'media:image',name:'native',state:'unavailable',reason:'proof missing',tools:['image_generate']}],call:async()=>{calls++;throw new Error('proof missing');}};
    const host=new ExtensionHost({configFile:path.join(root,'settings.json'),readFile:()=>{throw new Error('unused')},listFiles:()=>[],inspectImage:async()=>({mime:'image/png',width:1,height:1}),nativeMedia:native});
    await host.configure({version:1,media:{codex:{enabled:true,allowSubscriptionCalls:true,timeoutMs:180_000},image:{enabled:true,allowPaidCalls:true,endpoint:'https://example.com/images',model:'legacy',apiKeyEnv:'IMAGE_API_KEY'}}});
    assert.deepEqual(host.definitions(task).filter(item=>item.name.startsWith('image_')),[]);
    await assert.rejects(()=>host.call('image_generate',{prompt:'x'},context()),/proof missing/);assert.equal(calls,1);
  }finally{rmSync(root,{recursive:true,force:true});}
});
