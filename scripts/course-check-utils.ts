import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';

const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function noLinks(target:string){
  const full=path.resolve(target);let current=path.parse(full).root;
  for(const part of full.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);if(!existsSync(current))break;assert.ok(!lstatSync(current).isSymbolicLink(),`Linked path rejected: ${current}`);}
}
export function assertFreshWorkOutput(target:string,root=path.resolve(process.env.DMW_WORK_ROOT??'work')){
  assert.ok(path.isAbsolute(target)&&path.isAbsolute(root));noLinks(root);noLinks(target);
  assert.ok(!existsSync(target),'Output already exists');const parent=path.dirname(target);assert.ok(existsSync(parent)&&lstatSync(parent).isDirectory(),'Output parent must exist');
  const relative=path.relative(realpathSync.native(root),path.join(realpathSync.native(parent),path.basename(target)));
  assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'Output escapes work root');
}
function safeRelative(value:unknown):value is string{
  return typeof value==='string'&&!!value&&!path.isAbsolute(value)&&!/[\\:\0]/.test(value)&&value.split('/').every(part=>!!part&&part!=='.'&&part!=='..'&&!/[. ]$/.test(part));
}
function actualFiles(root:string):string[]{return readdirSync(root,{withFileTypes:true}).flatMap(item=>{const full=path.join(root,item.name);assert.ok(!item.isSymbolicLink(),'Candidate contains a link');if(item.isDirectory())return actualFiles(full).map(file=>`${item.name}/${file}`);assert.ok(item.isFile());return[item.name];});}
export function validateCandidateFiles(candidate:string){
  noLinks(candidate);const app=path.join(candidate,'app'),manifestFile=path.join(candidate,'chat-source-manifest.json');noLinks(app);noLinks(manifestFile);const actual=actualFiles(app);const manifest=JSON.parse(readFileSync(manifestFile,'utf8'));
  assert.ok(Array.isArray(manifest.application)&&manifest.application.length>0,'Candidate manifest must contain application files');
  const entries=new Map<string,string>();
  for(const item of manifest.application){assert.ok(item&&safeRelative(item.path)&&typeof item.sha256==='string'&&/^[a-f0-9]{64}$/.test(item.sha256),'Invalid manifest entry');assert.ok(!entries.has(item.path.toLowerCase()),'Duplicate manifest path');entries.set(item.path.toLowerCase(),item.sha256);assert.equal(sha(readFileSync(path.join(app,item.path))),item.sha256,`Candidate drift: ${item.path}`);}
  assert.equal(actual.length,entries.size,'Unregistered candidate files');for(const file of actual)assert.ok(entries.has(file.toLowerCase()),`Unregistered candidate file: ${file}`);
  for(const required of ['config/workbench.config.json','src/config.js','src/chat/store.js','src/chat/runtime.js','src/chat/drivers.js','src/chat/http.js','src/chat/session-files.js','src/chat/document-provider.js'])assert.ok(entries.has(required),`Required module absent: ${required}`);
  for(const [key,file]of [['launcherSha256','双模型工作台.exe'],['nodeSha256','runtime/node.exe']]){
    const executable=path.join(candidate,file!);noLinks(executable);assert.ok(lstatSync(executable).isFile(),'Candidate executable must be a regular file');
    assert.match(manifest[key!],/^[a-f0-9]{64}$/);assert.equal(sha(readFileSync(executable)),manifest[key!]);
  }
  return manifest;
}
/** Inspect a bounded, non-ZIP64 tool archive in memory; never extract paths to the filesystem. */
export function verifyArchive(bytes:Buffer,expected:Map<string,Buffer>){
  assert.ok(bytes.length>=22&&bytes.length<=20*1024*1024);const end=bytes.length-22;
  assert.equal(bytes.readUInt32LE(end),0x06054b50,'ZIP end record missing');assert.equal(bytes.readUInt16LE(end+4),0);assert.equal(bytes.readUInt16LE(end+6),0);assert.equal(bytes.readUInt16LE(end+20),0);
  const count=bytes.readUInt16LE(end+10);assert.equal(count,expected.size);assert.ok(count>0&&count<=200);assert.equal(bytes.readUInt16LE(end+8),count);
  let cursor=bytes.readUInt32LE(end+16);const centralEnd=cursor+bytes.readUInt32LE(end+12);assert.equal(centralEnd,end);const found=new Set<string>();let total=0;
  for(let index=0;index<count;index++){
    assert.equal(bytes.readUInt32LE(cursor),0x02014b50);const flags=bytes.readUInt16LE(cursor+8),method=bytes.readUInt16LE(cursor+10),compressed=bytes.readUInt32LE(cursor+20),size=bytes.readUInt32LE(cursor+24),nameSize=bytes.readUInt16LE(cursor+28),extraSize=bytes.readUInt16LE(cursor+30),commentSize=bytes.readUInt16LE(cursor+32),local=bytes.readUInt32LE(cursor+42);
    assert.equal(flags&1,0);assert.ok(size<=20*1024*1024);total+=size;assert.ok(total<=200*1024*1024);
    const name=bytes.subarray(cursor+46,cursor+46+nameSize).toString('utf8');assert.ok(safeRelative(name)&&expected.has(name)&&!found.has(name),`Unexpected ZIP entry: ${name}`);found.add(name);
    assert.equal(bytes.readUInt32LE(local),0x04034b50);const dataStart=local+30+bytes.readUInt16LE(local+26)+bytes.readUInt16LE(local+28);assert.ok(dataStart+compressed<=bytes.readUInt32LE(end+16));
    const raw=bytes.subarray(dataStart,dataStart+compressed);assert.ok(method===0||method===8,'Unsupported ZIP compression');const decoded=method===0?raw:inflateRawSync(raw,{maxOutputLength:20*1024*1024});assert.equal(decoded.length,size);assert.equal(sha(decoded),sha(expected.get(name)!));
    cursor+=46+nameSize+extraSize+commentSize;
  }
  assert.equal(cursor,centralEnd);return[...found];
}
