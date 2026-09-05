import { transaction } from './workflow-store.mjs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// The browser is driven by the calling agent's supported UI tools, not this process.
// Observations are claims from that agent, never authenticated website receipts.
const text = (v, max = 8192) => {
  if (typeof v !== 'string' || !v.trim() || Buffer.byteLength(v) > max) throw Error('INVALID_WEB_TEXT');
  return v;
};
export function chatUrl(value) {
  const u = new URL(text(value, 2048));
  if (u.origin !== 'https://chatgpt.com' || u.username || u.password || u.search || u.hash ||
      !/^\/(?:c\/[a-zA-Z0-9-]+)?$/.test(u.pathname)) throw Error('INVALID_CHAT_URL');
  return u.href;
}
export async function webTask(config, args, env = process.env) {
  const owner = env.CODEX_THREAD_ID || config.reviewerThreadId;
  if (!owner || config.role === 'worker') throw Error('REVIEWER_ONLY');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(args.taskId || '')) throw Error('INVALID_TASK_ID');
  return transaction({ ...config, stateDirectory: join(config.stateDirectory, 'web') }, db => {
    let t = Object.hasOwn(db.tasks, args.taskId) ? db.tasks[args.taskId] : undefined;
    if (t && t.owner !== owner) throw Error('OWNER_MISMATCH');
    if (args.action === 'prepare') {
      const prompt = text(args.text, 65536);
      if (!['text', 'image', 'video'].includes(args.kind)) throw Error('INVALID_KIND');
      if (t) {
        if (t.prompt !== prompt || t.kind !== args.kind) throw Error('TASK_ID_COLLISION');
        return structuredClone(t);
      }
      if (Object.keys(db.tasks).length >= 256) throw Error('WEB_TASK_LIMIT');
      t = { owner, taskId: args.taskId, kind: args.kind, prompt, state: 'PREPARED', revision: 1,
        marker: 'WEB-' + randomUUID(), created: new Date().toISOString() };
      Object.defineProperty(db.tasks, args.taskId, { value: t, enumerable: true, writable: true, configurable: true });
      return structuredClone(t);
    }
    if (!t) throw Error('WEB_TASK_NOT_FOUND');
    if (args.action === 'status') return structuredClone(t);
    if (args.revision !== t.revision) throw Error('STALE_WEB_REVISION');
    if (args.action === 'bind') {
      if (t.state !== 'PREPARED') throw Error('INVALID_WEB_STATE');
      const browserId = text(args.browserId, 256), tabId = text(args.tabId, 512);
      const url = chatUrl(args.url);
      // IDs must be freshly observed, not stale browser discovery indexes.
      if (Object.values(db.tasks).some(x => x.taskId !== t.taskId && x.browserId === browserId && x.tabId === tabId && x.state !== 'ACCEPTED')) throw Error('WEB_TAB_BUSY');
      Object.assign(t, { browserId, tabId, url, state: 'BOUND' });
    } else if (args.action === 'claim') {
      if (t.state !== 'BOUND' || chatUrl(args.url) !== t.url) throw Error('INVALID_WEB_STATE');
      text(args.evidence); // ready composer, no existing draft, capability observed
      t.state = 'SUBMISSION_UNKNOWN';
      t.submissionEvidence = args.evidence;
      t.submission = `[Task ${t.marker}]\n${t.prompt}`;
      // Persist before clicking Send. Never automatically reclaim or resend.
    } else if (args.action === 'collect') {
      if (t.state !== 'SUBMISSION_UNKNOWN') throw Error('INVALID_WEB_STATE');
      const url = chatUrl(args.url);
      if (url === 'https://chatgpt.com/' || (t.url !== 'https://chatgpt.com/' && url !== t.url)) throw Error('CHAT_BINDING_MISMATCH');
      if (!text(args.evidence).includes(t.marker)) throw Error('TASK_MARKER_REQUIRED');
      Object.assign(t, { url, result: text(args.text, 65536), evidence: args.evidence,
        state: 'AWAITING_REVIEW', evidenceLevel: 'agent-observed-unverified' });
    } else if (args.action === 'accept') {
      if (t.state !== 'AWAITING_REVIEW') throw Error('INVALID_WEB_STATE');
      t.review = text(args.evidence); t.state = 'ACCEPTED';
    } else throw Error('INVALID_WEB_ACTION');
    t.revision++;
    return structuredClone(t);
  });
}
