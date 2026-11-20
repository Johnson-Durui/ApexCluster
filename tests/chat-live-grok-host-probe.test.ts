import assert from 'node:assert/strict';
import test from 'node:test';
import { CURSOR_GROK_PRESENTATION_ALIAS } from '../src/chat/cursor-model-state.js';
import { assertGrokHostInitIdentity, loadGrokHostCandidateRuntime, persistGrokCancellationReceipt } from '../scripts/chat-live-grok-host-probe.js';

const reportedModel='Grok 4.7 256K High Fast';

test('Grok host init accepts only the verified reported model or exact presentation alias',()=>{
  assert.doesNotThrow(()=>assertGrokHostInitIdentity({model:reportedModel,cwd:'/workspace'},reportedModel,CURSOR_GROK_PRESENTATION_ALIAS));
  assert.doesNotThrow(()=>assertGrokHostInitIdentity({model:CURSOR_GROK_PRESENTATION_ALIAS,cwd:'/workspace'},reportedModel,CURSOR_GROK_PRESENTATION_ALIAS));
  assert.throws(()=>assertGrokHostInitIdentity({model:'Grok 4.7 High Fast',cwd:'/workspace'},reportedModel,CURSOR_GROK_PRESENTATION_ALIAS),/model/);
  assert.throws(()=>assertGrokHostInitIdentity({model:'Grok 4.7  High Fast\u200B',cwd:'/workspace'},reportedModel,CURSOR_GROK_PRESENTATION_ALIAS),/model/);
  assert.throws(()=>assertGrokHostInitIdentity({model:CURSOR_GROK_PRESENTATION_ALIAS,cwd:'/'},reportedModel,CURSOR_GROK_PRESENTATION_ALIAS),/cwd/);
});

test('Grok host init rejects invalid capability identity inputs instead of broadening aliases',()=>{
  assert.throws(()=>assertGrokHostInitIdentity({model:CURSOR_GROK_PRESENTATION_ALIAS,cwd:'/workspace'},'',CURSOR_GROK_PRESENTATION_ALIAS),/reportedModel/);
  assert.throws(()=>assertGrokHostInitIdentity({model:reportedModel,cwd:'/workspace'},reportedModel,''),/presentation alias/);
  assert.throws(()=>assertGrokHostInitIdentity(null,reportedModel,CURSOR_GROK_PRESENTATION_ALIAS),/init/);
});

test('Grok host source runtime uses the source presentation alias',async()=>{
  const runtime=await loadGrokHostCandidateRuntime();
  assert.equal(runtime.source,'repository');
  assert.equal(runtime.presentationAlias,CURSOR_GROK_PRESENTATION_ALIAS);
});

test('Grok cancellation persists the raw exit receipt before a strict label assertion can fail',()=>{
  const report:Record<string,unknown>={},snapshots:Record<string,unknown>[]=[];
  const receipt=persistGrokCancellationReceipt(report,{model:'unknown-display',cwd:'/workspace'},{cancelled:true,exitConfirmed:true,exitCode:130,terminationWarning:undefined,lifecycle:{confirmed:true},nativeToolDetected:false},()=>snapshots.push(structuredClone(report)));
  assert.equal(snapshots.length,1);
  assert.deepEqual(snapshots[0],{cancellation:{passed:false,init:{model:'unknown-display',cwd:'/workspace'},cancelled:true,exitConfirmed:true,exitCode:130,terminationWarning:null,lifecycle:{confirmed:true},nativeToolDetected:false}});
  assert.throws(()=>assertGrokHostInitIdentity((report.cancellation as Record<string,unknown>).init,reportedModel,CURSOR_GROK_PRESENTATION_ALIAS),/model/);
  assert.equal(receipt.passed,false);
});
