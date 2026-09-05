import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnose } from '../diagnostics.mjs';
const config = { codex: { command: 'codex', home: 'home' } };
test('missing credentials and socket diagnosed without connecting or creating work', async()=>{
 const forbidden=()=>{throw Error('must not connect');};
 const r=await diagnose(config,'thread',{exists:async()=>false,bridge:forbidden,readCodex:forbidden});
 assert.equal(r.dsh,'DSH_AUTH_NOT_CONFIGURED');assert.equal(r.codex,'CODEX_CONTROL_SOCKET_MISSING');assert.equal(r.ready,false);
});
test('presence alone does not claim authenticated runtime',async()=>{
 const r=await diagnose({...config,authFile:'private'},'thread',{exists:async()=>true,bridge:async()=>({connected:false,error:'DSH_AUTH_REQUIRED'}),readCodex:async()=>{throw Error('sensitive connection details');}});
 assert.equal(r.ready,false);assert.equal(r.codex,'CODEX_CONNECTION_FAILED');assert.ok(!JSON.stringify(r).includes('sensitive'));
});
test('ready requires both live services and a loaded reviewer',async()=>{
 for(const status of ['idle','active','notLoaded']){
 const r=await diagnose({...config,authFile:'private'},'thread',{exists:async()=>true,bridge:async()=>({connected:true}),readCodex:async()=>({status})});
 assert.equal(r.ready,status!=='notLoaded');
 }
});
