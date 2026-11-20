/** Candidate-only document acceptance; inference requires the explicit final flag. No automatic retries. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChatDriver, ChatRole, CliChatRole, DriverInput } from '../src/chat/types.js';
import { assertFreshWorkOutput, validateCandidateFiles, verifyArchive } from './course-check-utils.js';

const [candidateArg, proofArg, outputArg, ...flags] = process.argv.slice(2);
assert.ok(candidateArg && proofArg && outputArg && flags.every(flag=>flag==='--execute-live') && flags.length<=1,
  'Usage: node --import tsx scripts/course-live-document-check.ts CANDIDATE PROOF_DIR NEW_OUTPUT [--execute-live]');
const candidate=path.resolve(candidateArg), proofDir=path.resolve(proofArg), output=path.resolve(outputArg), app=path.join(candidate,'app');
assert.ok(path.isAbsolute(candidateArg)&&path.isAbsolute(proofArg)&&path.isAbsolute(outputArg));
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const load=(name:string)=>import(pathToFileURL(path.join(app,`src/${name}.js`)).href);
const report:any={schema:'dual-model-workbench/course-live-documents/v1',candidate,startedAt:new Date().toISOString(),executeLive:flags.includes('--execute-live'),maxInvocations:2,paidInvocationsAttempted:0,passed:false,invocations:[]};
const persist=()=>writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));
let outputCreated=false;
let server:ReturnType<typeof createServer>|undefined;
let runtime:any;
let chatId:string|undefined;
try {
  assertFreshWorkOutput(output);mkdirSync(output);outputCreated=true;persist();
  validateCandidateFiles(candidate);
  const [{loadConfig},{ChatStore},{ChatRuntime},{createChatDrivers},{createChatHttp},{SessionFiles},{DocumentProvider}]=await Promise.all(['config','chat/store','chat/runtime','chat/drivers','chat/http','chat/session-files','chat/document-provider'].map(load));
  const config=loadConfig(path.join(app,'config/workbench.config.json'),app);
  const dataRoot=path.join(output,'data'), store=new ChatStore(dataRoot), files=new SessionFiles(store);
  const documentProvider=new DocumentProvider(files,()=>({enabled:true,url:'http://127.0.0.1:18781'}));
  let handler:any;
  server=createServer((req,res)=>{void Promise.resolve().then(()=>handler?.(req,res)).then(handled=>{if(!handled){res.writeHead(404);res.end();}}).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end();});});
  const bridge=server;
  await new Promise<void>((resolve,reject)=>{bridge.once('error',reject);bridge.listen(0,'127.0.0.1',()=>{bridge.off('error',reject);resolve();});});
  const port=(bridge.address() as {port:number}).port,bridgeToken=randomBytes(32).toString('hex');
  const rawDrivers=createChatDrivers(config,{bridgeUrl:`http://127.0.0.1:${port}`,bridgeToken,capabilitiesFile:path.join(proofDir,'models.json')}) as Record<CliChatRole,ChatDriver>;
  const drivers=Object.fromEntries(Object.entries(rawDrivers).map(([role,driver])=>[role,{capability:driver.capability,invoke:async(input:DriverInput)=>{
    if(!report.executeLive||role!=='claude'||report.paidInvocationsAttempted>=2)throw Object.assign(new Error('Course qualification role/call budget exceeded'),{exitConfirmed:true});
    report.paidInvocationsAttempted++;report.invocations.push({id:input.invocation.id,role,startedAt:new Date().toISOString()});persist();
    return driver.invoke(input);
  }}]));
  const capabilities={definitions:()=>documentProvider.definitions(),call:(name:string,input:unknown,context:unknown)=>documentProvider.call(name,input,context),status:async()=>[await documentProvider.status()]};
  runtime=new ChatRuntime({store,drivers,capabilities,requireCostConfirmation:true});
  handler=createChatHttp({runtime,bridgeToken,port,dataRoot});
  report.documentService=await documentProvider.status(); report.models=Object.values(rawDrivers).map(driver=>driver.capability);
  assert.equal(report.documentService.state,'ready');
  report.prepared=true;report.readyForLive=rawDrivers.claude.capability.available&&rawDrivers.claude.capability.isolationVerified;persist();
  if(report.executeLive){
    assert.equal(report.readyForLive,true,'Fresh candidate Claude isolation proof is required before any dispatch');
    const chat=runtime.create({title:'课程真实文档验收'});chatId=chat.id;
    const source=runtime.upload(chat.id,{name:'真实验收资料.txt',clientUploadId:'source',base64:Buffer.from('这是测试用合成资料。设备编号：ROV-QA-01。状态：正常。检查数：3。仅依据这三项事实制作交付，不添加真实设备结论。').toString('base64')});
    runtime.send(chat.id,{clientMessageId:'course-live-documents',confirmCost:true,attachmentIds:[source.id],text:'请只在当前任务内完成本次真实工具验收，不委派、不联网。先读取已发送资料，建立带预定验收条件的公开计划。以“课程真实验收”为标题，一次创建包含上述设备编号、状态、检查数的 Word、Excel、PPT 三种文件（formats docx/xlsx/pptx）；将 Word 转成 PDF；归档生成文件为“课程真实验收.zip”。至少读取一次实际生成文件核对内容。只有工具实际保存文件、计划证据匹配后才完成。不要伪造文件或使用空白模板。'});
    const deadline=Date.now()+15*60_000;
    while(!['completed','failed','cancelled','interrupted'].includes(chat.tasks[0]?.status)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,150));
    assert.equal(chat.tasks[0]?.status,'completed',chat.tasks[0]?.error??'Document workflow did not complete');
    await runtime.idle(10_000);assert.ok(!chat.blockedReason);assert.ok(chat.invocations.every((inv:any)=>inv.exitConfirmed===true));
    const artifacts=chat.artifacts.filter((item:any)=>item.fileId);
    for(const extension of ['.docx','.xlsx','.pptx','.pdf','.zip'])assert.ok(artifacts.some((item:any)=>item.name.endsWith(extension)),`Missing ${extension}`);
    assert.ok(chat.todos?.length&&chat.todos.every((item:any)=>item.status==='completed'));
    for(const artifact of artifacts){const file=files.read(chat,artifact.fileId);assert.equal(sha(file.bytes),artifact.hash);}
    const context={chat,task:chat.tasks[0],invocation:chat.invocations[0],toolCallId:'independent-document-read',signal:new AbortController().signal};
    for(const extension of ['.docx','.xlsx','.pptx','.pdf']){const artifact=artifacts.find((item:any)=>item.name.endsWith(extension));const read=await documentProvider.call('document_read',{fileId:artifact.fileId},context);const text=JSON.parse(read.text).text;assert.equal(typeof text,'string');assert.match(text,/ROV-QA-01/);assert.match(text,/正常/);assert.match(text,/检查数/);assert.match(text,/(?:^|[^\d])3(?:[^\d]|$)/);}
    const archive=artifacts.find((item:any)=>item.name.endsWith('.zip'));const expected=new Map<string,Buffer>();for(const item of artifacts.filter((item:any)=>!item.name.endsWith('.zip'))){assert.ok(!expected.has(item.name),'Ambiguous duplicate delivery filename');expected.set(item.name,files.read(chat,item.fileId).bytes);}report.archiveEntries=verifyArchive(files.read(chat,archive.fileId).bytes,expected);
    report.chatId=chat.id;report.artifacts=artifacts.map((item:any)=>({name:item.name,hash:item.hash,bytes:item.bytes}));report.passed=true;
  }
}catch(error){report.error=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{
  const cleanupErrors:string[]=[];
  try{if(runtime&&chatId&&report.passed!==true)runtime.cancel(chatId);}catch(error){cleanupErrors.push(`cancel: ${String(error)}`);}
  try{if(runtime)await runtime.shutdown(10_000);}catch(error){cleanupErrors.push(`shutdown: ${String(error)}`);}
  try{if(server?.listening){const bridge=server;bridge.closeAllConnections();await new Promise<void>((resolve,reject)=>bridge.close(error=>error?reject(error):resolve()));}}catch(error){cleanupErrors.push(`server: ${String(error)}`);}
  finally{
    if(cleanupErrors.length){report.cleanupErrors=cleanupErrors;report.passed=false;process.exitCode=1;}
    report.endedAt=new Date().toISOString();
    if(outputCreated)persist();
  }
}
console.log(JSON.stringify({output,prepared:report.prepared,readyForLive:report.readyForLive,passed:report.passed,paidInvocationsAttempted:report.paidInvocationsAttempted,error:report.error}));
