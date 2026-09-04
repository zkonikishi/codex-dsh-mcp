import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {inbox} from '../review-inbox.mjs';
test('durable binding and completion are idempotent and never imply approval',async()=>{
 const dir=await mkdtemp(tmpdir()+'/dsh-inbox-');
 try {
 const binding={taskId:'t',originCodexTaskId:'c',dshSessionId:'s',scope:'Only README'};
 assert.equal((await inbox(dir,'bind',binding)).state,'BOUND');
 await assert.rejects(inbox(dir,'bind',{...binding,dshSessionId:'other'}),/COLLISION/);
 const receipt={taskId:'t',dshSessionId:'s',requestId:'r',summary:'Updated README; checks reported'};
 await assert.rejects(inbox(dir,'complete',{...receipt,dshSessionId:'other'}),/MISMATCH/);
 const first=await inbox(dir,'complete',receipt);
 assert.deepEqual(await inbox(dir,'complete',receipt),first);
 await assert.rejects(inbox(dir,'complete',{...receipt,summary:'changed'}),/COLLISION/);
 assert.equal((await inbox(dir,'list',{})).items[0].evidence,'UNVERIFIED_CALLER_REPORT');
 assert.equal(first.state,'AWAITING_REVIEW');
 await assert.rejects(inbox(dir,'bind',{...binding,taskId:'../escape'}),/INVALID_ID/);
 } finally {await rm(dir,{recursive:true});}
});
