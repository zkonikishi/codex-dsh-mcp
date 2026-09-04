import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch, submitReport, tick, review, workflowQuery, archive, resolveNotification, validateReport } from '../workflow.mjs';
import { transaction, readJson } from '../workflow-store.mjs';

async function fixture(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-workflow-'));
  const config = { stateDirectory: directory, allowedProjects: [directory] };
  const env = { CODEX_THREAD_ID: 'codex-owner' };
  let sends = 0;
  const adapters = { readCodex: async () => ({ status: 'idle' }),
    sessions: async () => ({ items: [{ sessionId: 'dsh-session', cwd: directory, running: false }] }),
    submit: async () => { sends++; return { accepted: true }; } };
  const args = { taskId: 'task', dshSessionId: 'dsh-session', projectPath: directory,
    scope: 'Only example.txt', acceptance: 'Read back contents', text: 'Write example', maxRounds: 2 };
  const record = () => transaction(config, db => structuredClone(db.tasks.task));
  const complete = async () => { const t = await record(); await submitReport(t.ticket, { summary: 'done', checks: ['reported check'] }); };
  try { await fn({ config, env, adapters, args, record, complete, sends: () => sends }); }
  finally { await rm(directory, { recursive: true }); }
}

test('dispatch -> signed completion -> notification -> independent acceptance survives reload', () => fixture(async f => {
  assert.equal((await dispatch(f.config, f.args, f.adapters, f.env)).state, 'RUNNING');
  await dispatch(f.config, f.args, f.adapters, f.env); assert.equal(f.sends(), 1);
  await f.complete();
  let notifications = 0;
  const notify = async (c, t, before) => { notifications++; await before(); return { turnId: 'review-turn' }; };
  await tick(f.config, { notify }); await tick(f.config, { notify });
  assert.equal(notifications, 1);
  assert.equal((await f.record()).notification.state, 'ACKNOWLEDGED');
  assert.equal((await f.record()).state, 'AWAITING_REVIEW');
  await assert.rejects(review(f.config, { taskId: 'task', round: 1, decision: 'accept', notes: 'ok' }, f.adapters, { CODEX_THREAD_ID: 'other' }), /NOT_OWNED/);
  const result = await review(f.config, { taskId: 'task', round: 1, decision: 'accept', notes: 'inspected actual files' }, f.adapters, f.env);
  assert.equal(result.state, 'ACCEPTED');
  assert.ok(!JSON.stringify(await workflowQuery(f.config, {}, f.env)).includes('"secret"'));
}));

test('rework routes to original session, changes ticket, rejects stale review and caps rounds', () => fixture(async f => {
  await dispatch(f.config, f.args, f.adapters, f.env); const first = await f.record();
  await f.complete(); await tick(f.config, { notify: async (c,t,b) => { await b(); return { turnId: 'r' }; } });
  await review(f.config, { taskId:'task',round:1,decision:'changes',notes:'Fix missing output' }, f.adapters, f.env);
  const second = await f.record(); assert.equal(second.round, 2); assert.notEqual(first.secret, second.secret); assert.equal(f.sends(), 2);
  await assert.rejects(review(f.config,{taskId:'task',round:1,decision:'accept',notes:'stale'},f.adapters,f.env),/STALE/);
  await f.complete(); await tick(f.config, { notify: async(c,t,b)=>{await b();return {turnId:'r2'};} });
  assert.equal((await review(f.config,{taskId:'task',round:2,decision:'changes',notes:'Still failing'},f.adapters,f.env)).reason,'REWORK_LIMIT');
}));

test('unknown notification is durable and never automatically replayed', () => fixture(async f => {
  await dispatch(f.config,f.args,f.adapters,f.env); await f.complete();
  let attempts=0;
  const notify=async(c,t,b)=>{attempts++;await b();throw Error('lost acknowledgement');};
  await tick(f.config,{notify});await tick(f.config,{notify});
  assert.equal(attempts,1);assert.equal((await f.record()).notification.state,'UNKNOWN');
  await resolveNotification(f.config,{taskId:'task',round:1,action:'acknowledged',notes:'Receipt visible in Codex history'},f.env);
  assert.equal((await f.record()).notification.state,'ACKNOWLEDGED');
}));

test('pre-send outage retries are bounded without duplicating DSH work', () => fixture(async f => {
  await dispatch(f.config,f.args,f.adapters,f.env);await f.complete();
  for(let i=0;i<6;i++) {
    await tick(f.config,{notify:async()=>{throw Error('offline');}});
    await transaction(f.config,db=>{db.tasks.task.notification.nextAttempt=0;});
  }
  assert.equal((await f.record()).notification.state,'BLOCKED');assert.equal((await f.record()).notification.attempts,5);assert.equal(f.sends(),1);
}));

test('forged, partial and wrong-round receipts cannot request review', () => fixture(async f => {
  await dispatch(f.config,f.args,f.adapters,f.env); const t=await f.record();
  await writeFile(t.receiptPath,JSON.stringify({payload:{taskId:'task',round:1,report:{summary:'fake'}},mac:'0'.repeat(64)}));
  await tick(f.config);assert.equal((await f.record()).state,'RUNNING');
  await writeFile(t.receiptPath,'{');await tick(f.config);assert.equal((await f.record()).state,'RUNNING');
}));

test('submission uncertainty never re-executes an implementation', () => fixture(async f => {
  let calls=0;f.adapters.submit=async()=>{calls++;throw Error('disconnected');};
  assert.equal((await dispatch(f.config,f.args,f.adapters,f.env)).state,'DELIVERY_UNKNOWN');
  await dispatch(f.config,f.args,f.adapters,f.env);assert.equal(calls,1);
}));

test('worker cannot dispatch or approve; project mismatch fails before write', () => fixture(async f => {
  await assert.rejects(dispatch({...f.config,role:'worker'},f.args,f.adapters,f.env),/REVIEWER/);
  f.adapters.sessions=async()=>({items:[{sessionId:'dsh-session',cwd:join(f.config.stateDirectory,'absent')}]});
  await assert.rejects(dispatch(f.config,f.args,f.adapters,f.env));assert.equal(f.sends(),0);
  await assert.rejects(dispatch({...f.config,allowedProjects:[]},f.args,f.adapters,f.env),/PROJECT_NOT_ALLOWED/);
}));

test('archive prevents task id reuse and does not archive active tasks', () => fixture(async f => {
  await dispatch(f.config,f.args,f.adapters,f.env);
  await assert.rejects(archive(f.config,{taskId:'task'},f.env),/TERMINAL/);
  await f.complete();await tick(f.config,{notify:async(c,t,b)=>{await b();return {turnId:'r'};}});
  await review(f.config,{taskId:'task',round:1,decision:'accept',notes:'Reviewed'},f.adapters,f.env);
  await archive(f.config,{taskId:'task'},f.env);
  await assert.rejects(dispatch(f.config,f.args,f.adapters,f.env),/ARCHIVED/);
}));

test('receipt schema rejects instructions that try to redirect the destination',()=>{
  assert.throws(()=>validateReport({summary:'x',originCodexTaskId:'attacker'}),/UNKNOWN/);
  assert.throws(()=>validateReport({summary:'x',changedFiles:Array(65).fill('a')}));
  assert.throws(()=>validateReport({summary:'x'.repeat(8193)}));
});

test('concurrent completion scanners cannot send twice or undo another claim',()=>fixture(async f=>{
  await dispatch(f.config,f.args,f.adapters,f.env);await f.complete();let sends=0;
  const notify=async(c,t,b)=>{await b();sends++;await new Promise(r=>setTimeout(r,25));return {turnId:'one'};};
  await Promise.all([tick(f.config,{notify}),tick(f.config,{notify})]);
  assert.equal(sends,1);assert.equal((await f.record()).notification.state,'ACKNOWLEDGED');
}));

test('concurrent duplicate completion publication is idempotent',()=>fixture(async f=>{
  await dispatch(f.config,f.args,f.adapters,f.env);const t=await f.record();
  await Promise.all([submitReport(t.ticket,{summary:'done'}),submitReport(t.ticket,{summary:'done'})]);
  assert.equal((await readJson(t.receiptPath)).payload.report.summary,'done');
}));
