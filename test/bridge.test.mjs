import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { validate,submit,rpc } from '../server.mjs';
test('MCP initialization and listing do not connect or submit',async()=>{assert.equal((await rpc({jsonrpc:'2.0',id:1,method:'initialize'})).result.serverInfo.name,'codex-dsh-mcp');const tools=(await rpc({jsonrpc:'2.0',id:2,method:'tools/list'})).result.tools;assert.equal(tools.length,15);assert.ok(tools.some(t=>t.name==='web_task'));});
test('invalid session, unknown arguments, oversized text rejected',()=>{assert.throws(()=>validate('dsh_history',{sessionId:'../x'}));assert.throws(()=>validate('dsh_status',{cookie:'x'}));assert.throws(()=>validate('dsh_prompt',{sessionId:'x',requestId:'r',text:'a'.repeat(262145)}));});
test('same request replay never resubmits; different payload collides',async()=>{
 const dir=await mkdtemp(tmpdir()+'/dsh-mcp-test-');let sent=0;
 const invoke=async(c,action)=>action==='sessions'?{items:[{sessionId:'s',running:false}]}:(sent++,{accepted:true});
 try{const c={stateDirectory:dir},a={sessionId:'s',requestId:'r',text:'bounded work'};assert.equal((await submit(c,a,invoke)).state,'ACCEPTED');assert.equal((await submit(c,a,invoke)).replayedLocally,true);assert.equal((await submit(c,{...a,text:'other'},invoke)).state,'REQUEST_ID_COLLISION');assert.equal(sent,1);}finally{await rm(dir,{recursive:true});}
});
test('network failure preserves unknown receipt and prevents retry',async()=>{
 const dir=await mkdtemp(tmpdir()+'/dsh-mcp-test-');let sent=0;
 const invoke=async(c,action)=>{if(action==='sessions')return {items:[{sessionId:'s',running:false}]};sent++;throw Error('network');};
 try{const a={sessionId:'s',requestId:'r',text:'work'},c={stateDirectory:dir};assert.equal((await submit(c,a,invoke)).state,'DELIVERY_UNKNOWN');assert.equal((await submit(c,a,invoke)).state,'DELIVERY_UNKNOWN');assert.equal(sent,1);}finally{await rm(dir,{recursive:true});}
});
test('running session never receives prompt',async()=>{
 const dir=await mkdtemp(tmpdir()+'/dsh-mcp-test-');try{assert.equal((await submit({stateDirectory:dir},{sessionId:'s',requestId:'r',text:'work'},async()=>({items:[{sessionId:'s',running:true}]}))).state,'SESSION_RUNNING');}finally{await rm(dir,{recursive:true});}
});
test('concurrent requests to same session cannot both submit',async()=>{
 const dir=await mkdtemp(tmpdir()+'/dsh-mcp-test-');let release;const gate=new Promise(r=>release=r);let entered;const ready=new Promise(r=>entered=r);
 try{const first=submit({stateDirectory:dir},{sessionId:'s',requestId:'r',text:'work'},async(c,a)=>{if(a==='sessions'){entered();await gate;return {items:[{sessionId:'s',running:false}]};}return {accepted:true};});await ready;const other=await submit({stateDirectory:dir},{sessionId:'s',requestId:'r2',text:'work'},async()=>{throw Error('must not invoke');});assert.equal(other.state,'SESSION_BUSY_OR_STALE_LOCK');release();assert.equal((await first).state,'ACCEPTED');}finally{release?.();await rm(dir,{recursive:true});}
});
