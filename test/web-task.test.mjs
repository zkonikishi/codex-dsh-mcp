import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webTask, chatUrl } from '../web-task.mjs';
import { validate } from '../server.mjs';

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'web-task-'));
  const config = { stateDirectory: root };
  const call = a => webTask(config, { taskId: 'example', ...a }, { CODEX_THREAD_ID: 'owner' });
  try { await fn(call, config); } finally { await rm(root, { recursive: true }); }
}
test('web task durable claim, exact chat binding and independent review', () => fixture(async call => {
  let t = await call({action:'prepare',kind:'text',text:'Reply with a test word'});
  assert.equal(t.state,'PREPARED');
  assert.deepEqual(await call({action:'prepare',kind:'text',text:t.prompt}),t);
  t = await call({action:'bind',revision:t.revision,browserId:'b',tabId:'t',url:'https://chatgpt.com/'});
  t = await call({action:'claim',revision:t.revision,url:t.url,evidence:'Empty composer; text available'});
  assert.equal(t.state,'SUBMISSION_UNKNOWN');
  await assert.rejects(call({action:'claim',revision:t.revision,url:t.url,evidence:'retry'}),/INVALID_WEB_STATE/);
  t = await call({action:'collect',revision:t.revision,url:'https://chatgpt.com/c/test',text:'Test word',evidence:t.marker+' visible reply finished'});
  assert.equal(t.state,'AWAITING_REVIEW');
  t = await call({action:'accept',revision:t.revision,evidence:'Read returned word against prompt'});
  assert.equal((await call({action:'status'})).state,'ACCEPTED');
}));
test('reject foreign owner, tab collision, stale revision and unsafe URLs', () => fixture(async (call,c) => {
  await call({action:'prepare',kind:'image',text:'Black cat'});
  await assert.rejects(webTask(c,{taskId:'example',action:'status'},{CODEX_THREAD_ID:'other'}),/OWNER_MISMATCH/);
  await assert.rejects(call({action:'bind',revision:99,browserId:'b',tabId:'t',url:'https://chatgpt.com/'}),/STALE/);
  await call({action:'bind',revision:1,browserId:'b',tabId:'t',url:'https://chatgpt.com/c/existing'});
  await webTask(c,{taskId:'second',action:'prepare',kind:'text',text:'Second'},{CODEX_THREAD_ID:'owner'});
  await assert.rejects(webTask(c,{taskId:'second',action:'bind',revision:1,browserId:'b',tabId:'t',url:'https://chatgpt.com/'},{CODEX_THREAD_ID:'owner'}),/TAB_BUSY/);
  for(const u of ['https://chatgpt.com.evil/c/x','http://chatgpt.com/','https://chatgpt.com/?token=x','https://u:p@chatgpt.com/']) assert.throws(()=>chatUrl(u));
}));
test('same-chat collection needs marker and response, worker cannot review', () => fixture(async (call,c) => {
  await call({action:'prepare',kind:'video',text:'A test video'});
  await call({action:'bind',revision:1,browserId:'b',tabId:'t',url:'https://chatgpt.com/c/original'});
  await call({action:'claim',revision:2,url:'https://chatgpt.com/c/original',evidence:'Video control actually visible'});
  await assert.rejects(call({action:'collect',revision:3,url:'https://chatgpt.com/c/wrong',text:'result',evidence:'x'}),/CHAT_BINDING/);
  await assert.rejects(call({action:'collect',revision:3,url:'https://chatgpt.com/c/original',text:'result',evidence:'x'}),/MARKER/);
  await assert.rejects(webTask({...c,role:'worker'},{taskId:'example',action:'status'},{CODEX_THREAD_ID:'owner'}),/REVIEWER_ONLY/);
  assert.throws(()=>validate('web_task',{taskId:'x',action:'prepare',cookie:'secret'}),/UNKNOWN_ARGUMENT/);
}));

test('bounded same-chat rework preserves history and exports accepted result', () => fixture(async call => {
  let t=await call({action:'prepare',kind:'text',text:'original'});
  t=await call({action:'bind',revision:t.revision,browserId:'b',tabId:'t',url:'https://chatgpt.com/c/a'});
  for(let round=1;round<=3;round++) {
    t=await call({action:'claim',revision:t.revision,url:t.url,evidence:'empty composer'});
    t=await call({action:'collect',revision:t.revision,url:t.url,evidence:t.marker+' finished',text:'result '+round});
    if(round<3) t=await call({action:'revise',revision:t.revision,text:'shorter '+round,evidence:'independent changes'});
  }
  assert.equal(t.history.length,2);
  assert.equal((await call({action:'prepare',kind:'text',text:'original'})).round,3);
  await assert.rejects(call({action:'revise',revision:t.revision,text:'again',evidence:'change'}),/ROUND_LIMIT/);
  await assert.rejects(call({action:'export',revision:t.revision}),/INVALID_WEB_STATE/);
  t=await call({action:'accept',revision:t.revision,evidence:'independently read final answer'});
  t=await call({action:'export',revision:t.revision});
  const bytes=await readFile(t.exported.path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),t.exported.sha256);
  assert.equal(JSON.parse(bytes).result,'result 3');
}));
