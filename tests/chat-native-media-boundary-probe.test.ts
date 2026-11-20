import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertBoundaryJobResult, nativeMediaBoundaryCanaries, parseNativeMediaBoundaryArgs } from '../scripts/chat-native-media-boundary-probe.js';

const job=(overrides:Record<string,unknown>={})=>({exitCode:0,signal:null,timedOut:false,cancelled:false,spawnError:null,stdoutTail:'',stderrTail:'',windowsJob:{confirmed:true,rootExited:true,jobActiveProcesses:0,targetExitCode:0},...overrides});

test('native media boundary CLI is strict and has no implicit live flag',()=>{
  const candidate=path.join(tmpdir(),'candidate'),output=path.join(tmpdir(),'work','fresh');
  assert.deepEqual(parseNativeMediaBoundaryArgs(['--candidate',candidate,'--output',output]),{candidate,output});
  assert.equal(parseNativeMediaBoundaryArgs(['--help']),null);assert.throws(()=>parseNativeMediaBoundaryArgs(['--candidate','relative','--output',output]));assert.throws(()=>parseNativeMediaBoundaryArgs(['--candidate',candidate,'--output',output,'--execute-live']));
});

test('boundary canaries use fixed relative paths and the two outside operations must be denied',()=>{
  assert.deepEqual(nativeMediaBoundaryCanaries(),[
    {name:'inside-read',command:'type inside-read.txt',expect:'success'},
    {name:'inside-write',command:'> inside-write.txt echo INSIDE_WRITE_OK',expect:'success'},
    {name:'outside-read-denied',command:'type ..\\outside\\outside-read.txt',expect:'denied'},
    {name:'outside-write-denied',command:'> ..\\outside\\outside-write.txt echo OUTSIDE_WRITE_SHOULD_FAIL',expect:'denied'},
  ]);
});

test('boundary Job evidence fails closed on exit, cleanup, or sentinel leakage',()=>{
  assert.doesNotThrow(()=>assertBoundaryJobResult(job({stdoutTail:'BOUNDARY_INSIDE_READ_OK'}),'success','SECRET_SENTINEL','BOUNDARY_INSIDE_READ_OK'));
  assert.throws(()=>assertBoundaryJobResult(job(),'success','SECRET_SENTINEL','BOUNDARY_INSIDE_READ_OK'),/complete sentinel/);
  assert.doesNotThrow(()=>assertBoundaryJobResult(job({exitCode:5,windowsJob:{confirmed:true,rootExited:true,jobActiveProcesses:0,targetExitCode:5}}),'denied','SECRET_SENTINEL'));
  assert.throws(()=>assertBoundaryJobResult(job({windowsJob:{confirmed:false,rootExited:true,jobActiveProcesses:0,targetExitCode:0}}),'success','SECRET_SENTINEL'));
  assert.throws(()=>assertBoundaryJobResult(job({stdoutTail:'SECRET_SENTINEL'}),'success','SECRET_SENTINEL'),/leaked/);
  assert.throws(()=>assertBoundaryJobResult(job(),'denied','SECRET_SENTINEL'),/not denied/);
});
