import test from 'node:test';
import assert from 'node:assert/strict';
import { ProxyRpcClient } from '../proxy-rpc-client.mjs';

// A subprocess speaking actual HTTP Upgrade + WebSocket frames, not JSONL.
const peer = `
const {createHash}=require('node:crypto'); let b=Buffer.alloc(0), upgraded=false;
process.stdin.on('data', chunk=>{ b=Buffer.concat([b,chunk]);
 if(!upgraded){const end=b.indexOf('\\r\\n\\r\\n');if(end<0)return;
 const h=b.subarray(0,end).toString();const key=/Sec-WebSocket-Key: (.*)/i.exec(h)[1].trim();
 const accept=createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
 process.stdout.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+accept+'\\r\\n\\r\\n');b=b.subarray(end+4);upgraded=true;}
 while(b.length>=2){let n=b[1]&127,o=2;if(n===126){if(b.length<4)return;n=b.readUInt16BE(2);o=4;}if(n===127)process.exit(2);
 if(b.length<o+4+n)return;const op=b[0]&15,mask=b.subarray(o,o+4),p=Buffer.from(b.subarray(o+4,o+4+n));b=b.subarray(o+4+n);
 if(op===8)process.exit(0);for(let i=0;i<p.length;i++)p[i]^=mask[i%4];const m=JSON.parse(p);if(!m.id)continue;
 const out=Buffer.from(JSON.stringify({id:m.id,result:{method:m.method}}));process.stdout.write(Buffer.concat([Buffer.from([129,out.length]),out]));}
});`;
test('proxy performs real websocket upgrade and masked JSON RPC roundtrip', async () => {
 const c=await ProxyRpcClient.connect(process.execPath,['-e',peer]);
 try { assert.deepEqual(await c.initialize(),{method:'initialize'});
 assert.deepEqual(await c.request('thread/read',{threadId:'test'}),{method:'thread/read'});
 } finally { c.close(); }
 assert.equal(c.pending.size,0);
 await assert.rejects(c.request('anything',{}),/DISCONNECTED/);
});
test('failed proxy never starts a replacement app-server',async()=>{
 await assert.rejects(ProxyRpcClient.connect(process.execPath,['-e','process.exit(1)']),/PROXY/);
});
