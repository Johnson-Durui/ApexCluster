import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync as readBytes } from 'node:fs';
import { callMcp, discoverMcp } from '../src/chat/extensions/mcp-client.js';
import type { McpConfig } from '../src/chat/extensions/config.js';

const enabled = process.env.DMW_RUN_DOCKER_MCP_TEST === '1';
const docker = process.env.DMW_DOCKER_CLI ?? 'docker';
const image = 'python:3.13-slim-trixie@sha256:ae14d4ce8771606477a81446e7ef429edd6762305fc50c84507c1041fa8285d1';
const program = String.raw`import sys,json,time
for line in sys.stdin:
 r=json.loads(line)
 if 'id' not in r: continue
 m=r.get('method')
 if m=='initialize': out={'protocolVersion':'2025-03-26','capabilities':{'tools':{}},'serverInfo':{'name':'docker-fake','version':'1'}}
 elif m=='tools/list': out={'tools':[{'name':'read','description':'read','inputSchema':{'type':'object','properties':{'slow':{'type':'boolean'}},'additionalProperties':False}}]}
 else:
  if r.get('params',{}).get('arguments',{}).get('slow'): time.sleep(60)
  out={'content':[{'type':'text','text':'ok'}],'isError':False}
 print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':out}),flush=True)`;
const managed = () => new Set(execFileSync(docker,['container','ls','-aq','--filter','label=com.dualmodelworkbench.mcp.managed=true'],{encoding:'utf8'}).trim().split(/\r?\n/).filter(Boolean));
const waitFor = async (predicate:()=>string|undefined,timeout=5_000) => { const end=Date.now()+timeout; for (;;) { const value=predicate();if(value)return value;if(Date.now()>end)throw new Error('container did not appear');await new Promise(resolve=>setTimeout(resolve,50)); } };

test('real Docker stdio MCP removes its exact container after normal completion and cancellation', { skip: !enabled }, async () => {
  const before=managed(), config={ id:'dockerfake',enabled:true,transport:'stdio',dockerCli:docker,dockerCliSha256:createHash('sha256').update(readBytes(docker)).digest('hex'),image,serverArgs:['python','-u','-c',program],toolAllowlist:['read'],toolAccess:{read:'read'},allowWrites:false,writeToolAllowlist:[],timeoutMs:15_000,maxOutputBytes:256*1024 } satisfies McpConfig;
  const manifest=await discoverMcp(config,new AbortController().signal);assert.equal(manifest.tools[0]?.name,'read');assert.deepEqual(managed(),before);
  const normal=await callMcp(config,'read',{},new AbortController().signal,manifest) as any;assert.equal(normal.content[0].text,'ok');assert.deepEqual(managed(),before);
  const controller=new AbortController(),pending=callMcp(config,'read',{slow:true},controller.signal,manifest),rejected=assert.rejects(pending,/取消|退出/);try{const id=await waitFor(()=>[...managed()].find(item=>!before.has(item)));const inspected=JSON.parse(execFileSync(docker,['container','inspect',id],{encoding:'utf8'}))[0];assert.equal(inspected.HostConfig.NetworkMode,'none');assert.equal(inspected.HostConfig.ReadonlyRootfs,true);assert.deepEqual(inspected.HostConfig.CapDrop,['ALL']);assert.ok(inspected.HostConfig.SecurityOpt.includes('no-new-privileges'));assert.equal(inspected.HostConfig.PidsLimit,128);assert.equal(inspected.HostConfig.Memory,536870912);assert.equal(inspected.HostConfig.NanoCpus,1_000_000_000);assert.equal(inspected.Config.User,'65532:65532');assert.equal(inspected.Config.OpenStdin,true);assert.deepEqual(inspected.Mounts,[]);assert.ok(inspected.HostConfig.Tmpfs['/tmp'].includes('noexec'));}finally{controller.abort();}await rejected;assert.deepEqual(managed(),before);
});
