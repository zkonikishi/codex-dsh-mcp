import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { dispatch, tick } from '../workflow.mjs';
import { transaction } from '../workflow-store.mjs';

function run(args, env) {
  return new Promise((resolve,reject)=>{
    const c=spawn(process.execPath,args,{env:{...process.env,...env},windowsHide:true,stdio:['ignore','pipe','pipe']});
    let out='';c.stdout.on('data',b=>out+=b);c.stderr.on('data',()=>{});
    const timer=setTimeout(()=>{c.kill();reject(Error('TIMEOUT'));},10000);
    c.on('error',e=>{clearTimeout(timer);reject(e);});c.on('exit',code=>{clearTimeout(timer);resolve({code,out});});
  });
}

test('actual report subprocess and one-shot runner persist results and release own lock',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'dsh-process-'));
  const config={stateDirectory:dir,allowedProjects:[dir],powershell:process.execPath};
  const cp=join(dir,'config.json');await writeFile(cp,JSON.stringify(config));
  try {
    await dispatch(config,{taskId:'process',dshSessionId:'session',projectPath:dir,scope:'read only',acceptance:'report',text:'read'},
      {readCodex:async()=>({}),sessions:async()=>({items:[{sessionId:'session',cwd:dir,running:false}]}),submit:async()=>({accepted:true})},
      {CODEX_THREAD_ID:'reviewer'});
    const task=await transaction(config,db=>structuredClone(db.tasks.process));
    const report=join(dir,'report.json');await writeFile(report,JSON.stringify({summary:'真实中文完成回执',changedFiles:[],checks:['read'],blockers:[]}));
    const result=await run(['report.mjs','--ticket',task.ticket,'--report',report],{});
    assert.equal(result.code,0);assert.equal(JSON.parse(result.out).submitted,true);assert.ok(!result.out.includes(task.secret));
    assert.equal((await run(['runner.mjs','--once'],{DSH_MCP_CONFIG:cp})).code,0);
    const after=await transaction(config,db=>structuredClone(db.tasks.process));
    assert.equal(after.state,'AWAITING_REVIEW');assert.equal(after.report.summary,'真实中文完成回执');
    assert.equal(after.notification.state,'RETRY'); // No Codex configured; never pretends delivered.
    await assert.rejects(access(join(dir,'workflow','runner.lock')));
  }finally{await rm(dir,{recursive:true});}
});
