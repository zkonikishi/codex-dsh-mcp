import { inbox } from './review-inbox.mjs';
import { webTask } from './web-task.mjs';
import { loadConfig } from './config.mjs';
import { dispatch, review, workflowQuery, archive, resolveNotification } from './workflow.mjs';
import { readCodex } from './codex-notifier.mjs';
import { startRunner } from './start-runner.mjs';
import { StringDecoder } from 'node:string_decoder';
import { spawn } from 'node:child_process';
import { readFile, mkdir, open, writeFile, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=dirname(fileURLToPath(import.meta.url));
const schema=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const id={type:'string',minLength:1,maxLength:128,pattern:'^[A-Za-z0-9_-]+$'};
export const definitions=[
  {name:'web_task',description:'Durable ledger for agent-operated ChatGPT browser tasks. Does NOT control a browser or send prompts itself. prepare -> bind -> claim BEFORE Send -> collect visible result -> independently accept. Unknown submission must never be automatically resent. Image/video availability must be observed, not assumed.',inputSchema:schema({taskId:id,action:{type:'string',enum:['prepare','status','bind','claim','collect','accept','revise','export']},revision:{type:'integer',minimum:1,maximum:100000},kind:{type:'string',enum:['text','image','video']},text:{type:'string',minLength:1,maxLength:65536},browserId:{type:'string',minLength:1,maxLength:256},tabId:{type:'string',minLength:1,maxLength:512},url:{type:'string',minLength:1,maxLength:2048},evidence:{type:'string',minLength:1,maxLength:8192}},['taskId','action'])},
  {name:'workflow_resolve_notification',description:'Original reviewer resolves UNKNOWN/BLOCKED notification only after inspecting Codex history. Retry can duplicate delivery if that inspection was wrong.',inputSchema:schema({taskId:id,round:{type:'integer',minimum:1,maximum:5},action:{type:'string',enum:['acknowledged','retry']},notes:{type:'string',minLength:1,maxLength:8192}},['taskId','round','action','notes'])},
  {name:'workflow_dispatch',description:'Bind and dispatch bounded work to an existing DSH session, with a completion ticket and original Codex reviewer. Requires configured project allowlist and Codex connection.',inputSchema:schema({taskId:id,dshSessionId:id,projectPath:{type:'string',minLength:1,maxLength:2048},scope:{type:'string',minLength:1,maxLength:4096},acceptance:{type:'string',minLength:1,maxLength:4096},text:{type:'string',minLength:1,maxLength:65536},maxRounds:{type:'integer',minimum:1,maximum:5}},['taskId','dshSessionId','projectPath','scope','acceptance','text'])},
  {name:'workflow_status',description:'Read tasks owned by the current Codex reviewer, including notification failures and delivery uncertainty.',inputSchema:schema({taskId:id})},
  {name:'workflow_review',description:'Original Codex reviewer records independent acceptance or bounded rework. Worker role cannot approve.',inputSchema:schema({taskId:id,round:{type:'integer',minimum:1,maximum:5},decision:{type:'string',enum:['accept','changes']},notes:{type:'string',minLength:1,maxLength:8192}},['taskId','round','decision','notes'])},
  {name:'workflow_archive',description:'Archive an accepted terminal record to release active inbox capacity. Does not delete project files.',inputSchema:schema({taskId:id},['taskId'])},
  {name:'codex_status',description:'Read current bound Codex thread via official app-server proxy; no model turn is started.',inputSchema:schema({})},
  {name:'review_bind',description:'Bind a local task to an existing Codex task and DSH session. Does not dispatch work or enforce scope.',inputSchema:schema({taskId:id,originCodexTaskId:id,dshSessionId:id,scope:{type:'string',minLength:1,maxLength:4096}},['taskId','originCodexTaskId','dshSessionId','scope'])},
  {name:'review_complete',description:'Record an UNVERIFIED completion report for a bound task. Requests review; never approves or wakes Codex.',inputSchema:schema({taskId:id,dshSessionId:id,requestId:id,summary:{type:'string',minLength:1,maxLength:8192}},['taskId','dshSessionId','requestId','summary'])},
  {name:'review_pending',description:'Read the local pending-review inbox, up to 100 records. Reports are untrusted claims.',inputSchema:schema({})},
  {name:'dsh_status',description:'Verify configured DSH Web process and authenticated session/list. Does not submit work.',inputSchema:schema({})},
  {name:'dsh_sessions',description:'List DSH sessions. Inspect project and running state before submitting work.',inputSchema:schema({})},
  {name:'dsh_history',description:'Read a bounded initial history snapshot; hasMore is retained. No session is cancelled.',inputSchema:schema({sessionId:id,maxMessages:{type:'integer',minimum:1,maximum:100}},['sessionId'])},
  {name:'dsh_prompt',description:'Queue an explicitly authorized task in an EXISTING session. Durable request deduplication; unknown delivery is never retried automatically.',inputSchema:schema({sessionId:id,requestId:id,text:{type:'string',minLength:1,maxLength:262144}},['sessionId','requestId','text'])},
  {name:'dsh_wait',description:'Observe queue/job idle for at most 30 seconds. Idle does not prove success; review history and files.',inputSchema:schema({sessionId:id,seconds:{type:'integer',minimum:1,maximum:30}},['sessionId'])}
];
export function validate(name,args){
  const def=definitions.find(d=>d.name===name); if(!def||!args||typeof args!=='object'||Array.isArray(args))throw Error('INVALID_TOOL_ARGUMENTS');
  for(const k of Object.keys(args)){const s=def.inputSchema.properties[k];if(!s)throw Error('UNKNOWN_ARGUMENT');const v=args[k];if(s.type==='string'&&(typeof v!=='string'||v.length<(s.minLength||0)||v.length>(s.maxLength||Infinity)||(s.pattern&&!new RegExp(s.pattern).test(v))||(s.enum&&!s.enum.includes(v))))throw Error('INVALID_STRING');if(s.type==='integer'&&(!Number.isInteger(v)||v<s.minimum||v>s.maximum))throw Error('INVALID_INTEGER');}
  for(const k of def.inputSchema.required)if(!(k in args))throw Error('MISSING_ARGUMENT');
  if(name==='dsh_prompt'&&(!args.text.trim()||Buffer.byteLength(args.text)>262144))throw Error('PROMPT_TOO_LARGE_OR_EMPTY');
}
const config=loadConfig;
export async function bridge(c,action,args={}){
  const argv=['-NoProfile','-NonInteractive','-File',join(root,'bridge','dsh-bridge.ps1'),action];
  if(c.authFile)argv.push('-AuthFile',c.authFile);
  for(const [k,v] of Object.entries(args))argv.push('-'+k,String(v));
  return await new Promise((resolve,reject)=>{
    const child=spawn(c.powershell,argv,{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,DSH_MCP_WEB:JSON.stringify(c.web||{}),TEMP:c.tempDirectory||process.env.TEMP,TMP:c.tempDirectory||process.env.TMP}});
    let output='',count=0,failed=false;
    const decoder=new StringDecoder('utf8');
    const timer=setTimeout(()=>{failed=true;child.kill();reject(Error('BRIDGE_TIMEOUT_DELIVERY_UNKNOWN'));},120000);
    child.stdout.on('data',b=>{count+=b.length;if(count>8388608){failed=true;child.kill();clearTimeout(timer);reject(Error('BRIDGE_OUTPUT_LIMIT'));}else output+=decoder.write(b);});
    // Never return native stderr, which could contain request data or authentication URLs.
    child.stderr.on('data',()=>{});
    child.on('error',()=>{clearTimeout(timer);reject(Error('BRIDGE_START_FAILED'));});
    child.on('close',code=>{clearTimeout(timer);if(failed)return;try{const r=JSON.parse((output+decoder.end()).replace(/^\uFEFF/,'').trim());if(code!==0&&r.connected!==false)throw Error();resolve(r);}catch{reject(Error('BRIDGE_INVALID_RESPONSE_DELIVERY_UNKNOWN'));}});
  });
}
const sha=s=>createHash('sha256').update(s).digest('hex');
export async function submit(c,args,invoke=bridge){
  await mkdir(c.stateDirectory,{recursive:true});
  const locks=join(c.stateDirectory,'locks'), receipts=join(c.stateDirectory,'receipts');
  await mkdir(locks,{recursive:true});await mkdir(receipts,{recursive:true});
  const lockPath=join(locks,sha(args.sessionId)+'.lock');
  let lock;try{lock=await open(lockPath,'wx');await lock.writeFile(JSON.stringify({pid:process.pid,created:new Date().toISOString()}));}catch(e){if(e.code==='EEXIST')return {accepted:false,state:'SESSION_BUSY_OR_STALE_LOCK',note:'Inspect existing request/history; lock is not automatically removed.'};throw e;}
  const receipt=join(receipts,sha(args.sessionId+'\0'+args.requestId)+'.json');
  const fingerprint=sha(args.text);
  let taskPath;
  try{
    try{const old=JSON.parse(await readFile(receipt,'utf8'));return old.fingerprint===fingerprint?{...old,replayedLocally:true}:{accepted:false,state:'REQUEST_ID_COLLISION'};}catch(e){if(e.code!=='ENOENT')throw e;}
    const listing=await invoke(c,'sessions');
    if(listing.connected===false)return listing;
    const matches=(listing.items||[]).filter(s=>s.sessionId===args.sessionId);
    if(matches.length!==1)return {accepted:false,state:'SESSION_NOT_FOUND'};
    if(matches[0].running)return {accepted:false,state:'SESSION_RUNNING',note:'Read history before adding more work.'};
    taskPath=join(c.stateDirectory,'prompt-'+sha(args.sessionId+'\0'+args.requestId)+'.txt');
    await writeFile(taskPath,args.text,{flag:'wx'});
    const record={sessionId:args.sessionId,requestId:args.requestId,fingerprint,state:'DELIVERY_UNKNOWN',accepted:false,created:new Date().toISOString()};
    const file=await open(receipt,'wx');try{await file.writeFile(JSON.stringify(record));await file.sync();}finally{await file.close();}
    let result;try{result=await invoke(c,'prompt',{SessionId:args.sessionId,RequestId:args.requestId,TaskFile:taskPath});}catch{return record;}
    if(result.accepted===true){record.accepted=true;record.state='ACCEPTED';}
    // Any error remains unknown: caller must inspect history, never blindly retry.
    const temp=receipt+'.tmp';await writeFile(temp,JSON.stringify(record));
    const {rename}=await import('node:fs/promises');await rename(temp,receipt);
    return record;
  }finally{if(taskPath)await unlink(taskPath).catch(()=>{});await lock.close();await unlink(lockPath).catch(()=>{});}
}
export async function callTool(name,args){
  validate(name,args);const c=await config();
  if(c.role==='worker' && !['dsh_status','dsh_sessions','dsh_history','dsh_wait'].includes(name))throw Error('REVIEWER_ONLY');
  const adapters={submit,sessions:cfg=>bridge(cfg,'sessions')};
  if(name==='web_task')return webTask(c,args);
  if(name==='codex_status')return readCodex(c,process.env.CODEX_THREAD_ID||c.reviewerThreadId);
  if(name==='workflow_dispatch'){const r=await dispatch(c,args,adapters);startRunner(c);return r;}
  if(name==='workflow_review'){const r=await review(c,args,adapters);startRunner(c);return r;}
  if(name==='workflow_status')return workflowQuery(c,args);
  if(name==='workflow_archive')return archive(c,args);
  if(name==='workflow_resolve_notification'){const r=await resolveNotification(c,args);startRunner(c);return r;}
  if(name.startsWith('review_'))return inbox(c.stateDirectory,name==='review_pending'?'list':name.slice(7),args);
  if(name==='dsh_prompt')return submit(c,args);
  if(name==='dsh_status')return bridge(c,'status');
  if(name==='dsh_sessions')return bridge(c,'sessions');
  if(name==='dsh_history')return bridge(c,'history',{SessionId:args.sessionId,MaxMessages:args.maxMessages??30});
  return bridge(c,'wait',{SessionId:args.sessionId,TimeoutSeconds:args.seconds??15});
}
export async function rpc(req){
  if(!req||req.jsonrpc!=='2.0')return {jsonrpc:'2.0',id:req?.id??null,error:{code:-32600,message:'Invalid request'}};
  if(!Object.hasOwn(req,'id'))return null;
  const result=r=>({jsonrpc:'2.0',id:req.id,result:r});
  if(req.method==='initialize')return result({protocolVersion:['2024-11-05','2025-03-26','2025-06-18'].includes(req.params?.protocolVersion)?req.params.protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'codex-dsh-mcp',version:'0.2.0'}});
  if(req.method==='ping')return result({});
  if(req.method==='tools/list')return result({tools:definitions});
  if(req.method==='tools/call'){
    try{const value=await callTool(req.params?.name,req.params?.arguments??{});return result({isError:value.connected===false||value.accepted===false||['DELIVERY_UNKNOWN','BLOCKED'].includes(value.state),content:[{type:'text',text:JSON.stringify(value)}]});}
    catch(e){return result({isError:true,content:[{type:'text',text:/^[A-Z_]+$/.test(e.message)?e.message:'LOCAL_BRIDGE_ERROR'}]});}
  }
  return {jsonrpc:'2.0',id:req.id,error:{code:-32601,message:'Method not found'}};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  let buffer='',chain=Promise.resolve(),queued=0;
  const send=r=>{if(r)process.stdout.write(JSON.stringify(r)+'\n');};
  process.stdin.setEncoding('utf8');process.stdin.on('data',part=>{
    buffer+=part;if(Buffer.byteLength(buffer)>1048576){process.exitCode=1;process.stdin.destroy();return;}
    let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!line.trim())continue;if(++queued>32){process.exitCode=1;process.stdin.destroy();return;}chain=chain.then(async()=>{try{send(await rpc(JSON.parse(line)));}catch{send({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});}finally{queued--;}});}
  });
}
