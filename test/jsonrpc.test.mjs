import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonRpcClient } from '../jsonrpc-client.mjs';

test('stdio client handshake, correlation, timeout and disconnect',async()=>{
  const script=`let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',p=>{b+=p;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='slow'||m.id===undefined)continue;process.stdout.write(JSON.stringify({id:m.id,result:{ok:true}})+'\\n')}});`;
  const c=new JsonRpcClient(process.execPath,['--input-type=module','-e',script]);
  try {
    assert.equal((await c.initialize()).ok,true);
    assert.equal((await c.request('ping',{})).ok,true);
    await assert.rejects(c.request('slow',{},20),/UNKNOWN/);
  } finally {c.close();}
  await assert.rejects(c.request('ping',{}),/DISCONNECTED/);
});
