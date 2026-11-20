import crypto from 'node:crypto';
import type { CursorWriteCapabilities } from '../adapters/cursor-writer.js';

export const CURSOR_ENTRY_SHA256 = '7b4bb3badb36cff7b6cee7996d61bd3c32866cf354214374b77f5a5d33a0b3f2';
export const CURSOR_NATIVE_APPROVAL_MARKER = 'DMW_NATIVE_APPROVAL_DENY_V1';
export const CURSOR_NATIVE_APPROVAL_CASES = Object.freeze([
  'webFetchRequestQuery', 'webSearchRequestQuery', 'generateImageRequestQuery',
] as const);

export type CursorNativeApprovalCase = typeof CURSOR_NATIVE_APPROVAL_CASES[number];
export interface CursorNativeApprovalAudit {
  version: 1;
  kind: CursorNativeApprovalCase;
  queryIdSha256: string;
  toolCallIdSha256: string;
  markerSha256: string;
  invocationNonce: string;
  rootSha256: string;
  profileProjectionSha256: string;
  homeProjectionSha256: string;
  firewallSha256: string;
  indexSha256: string;
  constructed: true;
  returned: true;
}

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

function cursorNativeApprovalInjectionSourceRaw(): string {
  const agentKey = '../agent-client/dist/index.js';
  const helperKey = '../agent-core/dist/interaction-queries.js';
  const marker = CURSOR_NATIVE_APPROVAL_MARKER;
  const cases = CURSOR_NATIVE_APPROVAL_CASES;
  return String.raw`(()=>{const agentKey=${JSON.stringify(agentKey)},helperKey=${JSON.stringify(helperKey)},marker=${JSON.stringify(marker)},cases=${JSON.stringify(cases)},original=__webpack_modules__[agentKey];if(typeof original!=='function')throw Error('DMW_NATIVE_APPROVAL_AGENT_FACTORY');__webpack_modules__[agentKey]=function(module,exports,webpackRequire){const proxy=new Proxy(webpackRequire,{get(target,property,receiver){if(property!=='d')return Reflect.get(target,property,receiver);return(out,definitions)=>{if(out!==exports||!definitions||typeof definitions.PW!=='function')return target.d(out,definitions);const originalPW=definitions.PW;let cached;const wrappedPW=()=>{if(cached)return cached;const Base=originalPW();if(typeof Base!=='function'||typeof Base.prototype?.run!=='function'||Base.prototype.run.length!==11||Base.prototype.run.constructor.name!=='AsyncFunction')throw Error('DMW_NATIVE_APPROVAL_RUN_ABI');const helpers=webpackRequire(helperKey)?.x1;if(!helpers||typeof helpers.webFetchRejected!=='function'||typeof helpers.webSearchRejected!=='function'||typeof helpers.generateImageRejected!=='function')throw Error('DMW_NATIVE_APPROVAL_HELPERS');cached=class extends Base{async run(...args){const listener=args[4];if(!listener||typeof listener.query!=='function')throw Error('DMW_NATIVE_APPROVAL_LISTENER');const originalQuery=listener.query;args[4]=new Proxy(listener,{get(targetObject,key){if(key!=='query'){const value=Reflect.get(targetObject,key,targetObject);return typeof value==='function'?value.bind(targetObject):value}return async(context,query)=>{const kind=query?.query?.case;if(!cases.includes(kind))return Reflect.apply(originalQuery,targetObject,[context,query]);const id=query?.id,toolCallId=query?.query?.value?.args?.toolCallId,idOk=typeof id==='string'?id.length>0&&Buffer.byteLength(id)<=512:Number.isSafeInteger(id)&&id>=0;if(!idOk||typeof toolCallId!=='string'||!toolCallId||Buffer.byteLength(toolCallId)>512)throw Error('DMW_NATIVE_APPROVAL_QUERY_ABI');const helper=kind==='webFetchRequestQuery'?helpers.webFetchRejected:kind==='webSearchRequestQuery'?helpers.webSearchRejected:helpers.generateImageRejected;const response=helper(id,marker),expectedCase=kind==='webFetchRequestQuery'?'webFetchRequestResponse':kind==='webSearchRequestQuery'?'webSearchRequestResponse':'generateImageRequestResponse';if(!response||response.id!==id||response.result?.case!==expectedCase||response.result?.value?.result?.case!=='rejected'||response.result.value.result.value?.reason!==marker)throw Error('DMW_NATIVE_APPROVAL_RESPONSE');const binding=require('/cursor-profile/receipt-binding.json');const fs=require('node:fs'),crypto=require('node:crypto'),self='/cursor-profile/native-approval.cjs',audit='/cursor-profile/native-approval-audit.jsonl',digest=value=>crypto.createHash('sha256').update(value).digest('hex'),selfHash=digest(fs.readFileSync(self));if(!binding||binding.nativeApprovalSha256!==selfHash||binding.entrySha256!==${JSON.stringify(CURSOR_ENTRY_SHA256)}||![binding.invocationNonce,binding.rootSha256,binding.profileProjectionSha256,binding.homeProjectionSha256].every(value=>typeof value==='string'&&value.length>0))throw Error('DMW_NATIVE_APPROVAL_BINDING');const info=fs.lstatSync(audit);if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()||info.size>65536)throw Error('DMW_NATIVE_APPROVAL_AUDIT');const entry={version:1,kind,queryIdSha256:digest(typeof id==='number'?'number:'+id:'string:'+id),toolCallIdSha256:digest(toolCallId),markerSha256:digest(marker),invocationNonce:binding.invocationNonce,rootSha256:binding.rootSha256,profileProjectionSha256:binding.profileProjectionSha256,homeProjectionSha256:binding.homeProjectionSha256,firewallSha256:selfHash,indexSha256:${JSON.stringify(CURSOR_ENTRY_SHA256)},constructed:true,returned:true};const line=JSON.stringify(entry)+'\n';if(info.size+Buffer.byteLength(line)>65536)throw Error('DMW_NATIVE_APPROVAL_AUDIT_OVERFLOW');fs.appendFileSync(audit,line);return response}});return super.run(...args)}};Object.freeze(cached.prototype);Object.freeze(cached);return cached};return target.d(out,{...definitions,PW:wrappedPW})}}});return original.call(this,module,exports,proxy)}})();`;
}

export function cursorNativeApprovalInjectionSource(): string {
  const source = cursorNativeApprovalInjectionSourceRaw();
  const anchor = 'return response}});return super.run';
  if (source.split(anchor).length !== 2) throw new Error('native approval listener proxy anchor mismatch');
  return source.replace(anchor, 'return response}}});return super.run');
}

/**
 * Fixed remote approval-response firewall. It does not remove the native surface and makes no
 * claim that the remote service cannot speculatively execute before receiving the rejection.
 */
export function cursorNativeApprovalSource(capabilities: CursorWriteCapabilities): string {
  if (!/^\/opt\/cursor-agent\/versions\/[^/]+\/index\.js$/.test(capabilities.entryPath)) throw new Error('native approval entry path is outside fixed Cursor install');
  const agentKey = '../agent-client/dist/index.js';
  const agentPrefix = '"../agent-client/dist/index.js"(t,e,r){"use strict";r.d(e,{ao:()=>$,PW:()=>Oe,Yv:()=>M,cc:()=>G,SK:()=>L,DN:()=>U,rS:()=>Ie,mb:()=>p,Oe:()=>h});';
  const helperPrefix = '"../agent-core/dist/interaction-queries.js"(t,e,r){"use strict";r.d(e,{l4:()=>d,x1:()=>m});';
  const tail = 'var __webpack_exports__=__webpack_require__("./src/main.tsx")})();';
  const injected = cursorNativeApprovalInjectionSource();
  return `'use strict';\nconst fs=require('node:fs'),crypto=require('node:crypto'),Module=require('node:module');\nconst target=${JSON.stringify(capabilities.entryPath)},expected=${JSON.stringify(CURSOR_ENTRY_SHA256)},agentPrefix=${JSON.stringify(agentPrefix)},helperPrefix=${JSON.stringify(helperPrefix)},tail=${JSON.stringify(tail)},injected=${JSON.stringify(injected)};\nconst uidMap=fs.readFileSync('/proc/self/uid_map','utf8').trim().split(/\\n/).map(line=>line.trim().split(/\\s+/).map(Number)),overflow=Number(fs.readFileSync('/proc/sys/kernel/overflowuid','utf8').trim()),mapped=uidMap.find(([,outside,length])=>outside===0||outside<0&&0<outside+length),rootUid=mapped?mapped[0]-mapped[1]:null,allowedUids=[overflow,...rootUid===null?[]:[rootUid]];const info=fs.lstatSync(target);if(!info.isFile()||info.isSymbolicLink()||!allowedUids.includes(info.uid)||(info.mode&0o022)!==0||fs.realpathSync(target)!==target)throw Error('DMW_NATIVE_APPROVAL_TARGET');const bytes=fs.readFileSync(target);if(crypto.createHash('sha256').update(bytes).digest('hex')!==expected)throw Error('DMW_NATIVE_APPROVAL_HASH');const source=bytes.toString('utf8');for(const anchor of [agentPrefix,helperPrefix,tail])if(source.split(anchor).length!==2)throw Error('DMW_NATIVE_APPROVAL_ANCHOR');const original=Module._extensions['.js'];let compiled=false;Module._extensions['.js']=function(module,filename){if(filename!==target)return original(module,filename);Module._extensions['.js']=original;compiled=true;return module._compile(source.replace(tail,injected+tail),filename)};process.once('exit',()=>{if(!compiled)throw Error('DMW_NATIVE_APPROVAL_ENTRY_NOT_LOADED')});\n`;
}

export function cursorNativeApprovalSha256(capabilities: CursorWriteCapabilities): string {
  return sha256(cursorNativeApprovalSource(capabilities));
}
