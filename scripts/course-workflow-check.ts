/** Deterministic orchestration + real Docker documents. Never invokes a model. */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ChatRuntime } from '../src/chat/runtime.js';
import { ChatStore } from '../src/chat/store.js';
import { SessionFiles } from '../src/chat/session-files.js';
import { DocumentProvider } from '../src/chat/document-provider.js';
import { backupChats, restoreChats } from '../src/chat/backup.js';
import type { ChatAttachment, ChatDriver, ChatRole, DriverInput, ToolReply } from '../src/chat/types.js';
const output = process.argv[2]; if (!output || process.env.DOCUMENT_WORKER_VERIFY !== '1') throw new Error('指定全新输出目录，并设置 DOCUMENT_WORKER_VERIFY=1。此脚本只运行确定性驱动和真实文档服务。');
mkdirSync(output, { recursive: false }); const store = new ChatStore(path.join(output,'data')), files = new SessionFiles(store);
const documents = new DocumentProvider(files, () => ({ enabled: true, url: 'http://127.0.0.1:18781' }));
const produced = (reply: ToolReply) => (reply.data as { files: ChatAttachment[] }).files;
let sourceId = '';
const invoke = async (input: DriverInput) => {
  input.onText('【确定性验收驱动，非真实模型】正在读取附件。');
  await input.callTool('plan_update', { revision:0,steps:[{id:'source',text:'核对输入资料',status:'in_progress',verification:{kind:'tool',toolName:'session_file_read'}},{id:'delivery',text:'生成并验证Office和PDF交付',status:'pending',dependsOn:['source'],verification:{kind:'artifact',name:'巡检交付.zip'}}] });
  const source = await input.callTool('session_file_read',{fileId:sourceId}); if (!source.text.includes('季度巡检')) throw new Error('附件来源读取失败');
  const created = produced(await input.callTool('document_create',{formats:['docx','xlsx','pptx'],document:{title:'智能体验收',blocks:[{type:'heading',text:'季度巡检',level:1},{type:'paragraph',text:'检查项目：水下机器人控制系统。结果：温度与电压均在预期范围。'},{type:'table',rows:[['项目','数值'],['温度',25],['电压',24]]}],sheets:[{name:'巡检数据',rows:[['项目','数值'],['温度',25],['电压',24],['合计','=SUM(B2:B3)']],widths:[24,18]}],slides:[{title:'季度巡检',body:['水下机器人控制系统','温度25℃，电压24V'],notes:'真实文档验收样例'},{title:'结论',body:'状态正常，保留原始检查数据。'}]}}));
  const docx = created.find(file=>file.name.endsWith('.docx'))!;
  const read = await input.callTool('document_read',{fileId:docx.id}); if (!read.text.includes('季度巡检')) throw new Error('DOCX中文往返失败');
  const converted = produced(await input.callTool('document_convert',{fileIds:[docx.id],to:'pdf'}));
  const pdf = await input.callTool('document_read',{fileId:converted[0]!.id}); if (!pdf.text.includes('季度巡检')) throw new Error('PDF中文往返失败');
  const archive = produced(await input.callTool('files_archive',{fileIds:[...created,...converted].map(file=>file.id),name:'巡检交付.zip'}));
  const receipt = store.get(input.chatId).toolResults!.find(receipt=>receipt.name==='session_file_read')!;
  await input.callTool('plan_update',{revision:1,steps:[{id:'source',text:'核对输入资料',status:'completed',evidenceRefs:[receipt.ref]},{id:'delivery',text:'生成并验证Office和PDF交付',status:'completed',dependsOn:['source'],evidenceRefs:[archive[0]!.id]}]});
  input.onText('文件已生成，中文读取和哈希校验通过。');
  await input.callTool('task_complete',{result:'确定性验收通过：附件→计划→DOCX/XLSX/PPTX→PDF→ZIP，全部为真实文档服务产物。未调用真实模型。'});
  return { text:'',exitConfirmed:true };
};
const drivers = Object.fromEntries((['claude','astra','sol','grok'] as ChatRole[]).map(role=>[role,{capability:{role,available:true,isolationVerified:true},invoke:async(input:DriverInput)=>{try{return await invoke(input);}catch(error){throw Object.assign(error instanceof Error?error:new Error(String(error)),{exitConfirmed:true});}}}])) as Record<ChatRole,ChatDriver>;
const runtime = new ChatRuntime({store,drivers,capabilities:{definitions:()=>documents.definitions(),call:(name,input,ctx)=>documents.call(name,input,ctx),status:async()=>[await documents.status()]}});
const chat = runtime.create({title:'课程升级确定性集成验收'}); const uploaded = runtime.upload(chat.id,{name:'巡检要求.txt',base64:Buffer.from('按季度巡检资料生成Word、Excel、PPT和PDF，保留中文和公式。').toString('base64'),clientUploadId:'sample'}); sourceId=uploaded.id;
runtime.send(chat.id,{text:'根据附件完成文档交付与归档',clientMessageId:'sample-message',attachmentIds:[sourceId]}); await runtime.idle(180_000);
if(chat.tasks[0]?.status!=='completed')throw new Error(chat.tasks[0]?.error??`任务终态${chat.tasks[0]?.status}`);
mkdirSync(path.join(output,'outputs'));
for(const file of files.list(chat)){writeFileSync(path.join(output,'outputs',file.name),files.read(chat,file.id).bytes,{flag:'wx'});}
const manifest=backupChats(path.join(output,'data'),path.join(output,'backup'));const restored=restoreChats(path.join(output,'backup'),path.join(output,'restored'));
for(const file of files.list(restored[0]!)){const restoredFiles=new SessionFiles(new ChatStore(path.join(output,'restored')));restoredFiles.read(restored[0]!,file.id);}
const report={kind:'deterministic-driver-real-document-service',modelCalls:0,chatId:chat.id,status:chat.tasks[0]?.status,files:files.list(chat),backupFiles:manifest.files.length,restoredChats:restored.length,services:await runtime.serviceCapabilities()};writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2)+'\n');
await runtime.shutdown();console.log(JSON.stringify({output,chatId:chat.id,status:report.status,files:report.files.length,modelCalls:0,restoredChats:restored.length}));
