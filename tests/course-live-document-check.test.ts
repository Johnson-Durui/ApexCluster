import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';

// These CLI lifecycle checks require a temp directory below the configured work root.
const workRoot=path.resolve(process.env.DMW_WORK_ROOT??'work');
const relativeTemp=path.relative(workRoot,path.resolve(tmpdir()));
const insideWork=relativeTemp!==''&&!relativeTemp.startsWith('..')&&!path.isAbsolute(relativeTemp);
test('document qualification records initialization failures and exits without model calls', {skip:!insideWork},()=>{
  for(const failure of ['import','drivers','runtime','http'] as const){
    const root=mkdtempSync(path.join(tmpdir(),'course-live-init-'));
    try{
      const candidate=path.join(root,'candidate'),app=path.join(candidate,'app'),output=path.join(root,'result');
      const modules:Record<string,string>={
        'package.json':'{"type":"module"}',
        'config/workbench.config.json':'{}',
        'src/config.js':failure==='import'?"throw Error('init-import');":"export const loadConfig=()=>({});",
        'src/chat/store.js':'export class ChatStore {}',
        'src/chat/runtime.js':`export class ChatRuntime { constructor(){${failure==='runtime'?"throw Error('init-runtime');":''}} async shutdown(){} }`,
        'src/chat/drivers.js':failure==='drivers'?"export const createChatDrivers=()=>{throw Error('init-drivers')};":"export const createChatDrivers=()=>({claude:{capability:{available:false,isolationVerified:false}}});",
        'src/chat/http.js':"export const createChatHttp=()=>{throw Error('init-http')};",
        'src/chat/session-files.js':'export class SessionFiles {}',
        'src/chat/document-provider.js':'export class DocumentProvider {}',
      };
      for(const [file,text] of Object.entries(modules)){const target=path.join(app,file);mkdirSync(path.dirname(target),{recursive:true});writeFileSync(target,text);}
      const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
      mkdirSync(path.join(candidate,'runtime'));writeFileSync(path.join(candidate,'runtime/node.exe'),'fixture');writeFileSync(path.join(candidate,'双模型工作台.exe'),'fixture');
      writeFileSync(path.join(candidate,'chat-source-manifest.json'),JSON.stringify({application:Object.entries(modules).map(([file,text])=>({path:file,sha256:sha(text)})),launcherSha256:sha('fixture'),nodeSha256:sha('fixture')}));
      const child=spawnSync(process.execPath,['--import','tsx','scripts/course-live-document-check.ts',candidate,path.join(root,'proofs'),output],{cwd:process.cwd(),encoding:'utf8',timeout:15_000,windowsHide:true});
      assert.equal(child.error,undefined,child.stderr);assert.equal(child.status,1,child.stdout+child.stderr);
      const report=JSON.parse(readFileSync(path.join(output,'result.json'),'utf8'));
      assert.equal(report.passed,false);assert.equal(report.paidInvocationsAttempted,0);assert.match(report.error,new RegExp(`init-${failure}`));assert.ok(report.endedAt);assert.equal(report.cleanupErrors,undefined);
    }finally{
      const relative=path.relative(path.resolve(tmpdir()),path.resolve(root));assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(root).startsWith('course-live-init-'));rmSync(root,{recursive:true,force:true});
    }
  }
});
