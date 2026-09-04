import { mkdir, readFile, readdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const identifier = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw Error('INVALID_ID');
  return value;
};
const bounded = (value, max) => {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max) throw Error('INVALID_TEXT');
  return value;
};

// This is a local inbox, not an authenticated DSH callback or a review verdict.
export async function inbox(directory, action, args) {
  const root = join(directory, 'review-inbox');
  await mkdir(root, { recursive: true });
  const lockPath = join(root, 'writer.lock');
  let lock;
  try { lock = await open(lockPath, 'wx'); }
  catch (e) { if (e.code === 'EEXIST') throw Error('INBOX_BUSY_OR_STALE_LOCK'); throw e; }
  try {
    const files = (await readdir(root)).filter(f => f.endsWith('.json'));
    if (files.length > 1000) throw Error('INBOX_LIMIT');
    if (action === 'list') {
      const records = await Promise.all(files.sort().map(f => readFile(join(root, f), 'utf8').then(JSON.parse)));
      return { items: records.filter(r => r.state === 'AWAITING_REVIEW').slice(0, 100),
        hasMore: records.filter(r => r.state === 'AWAITING_REVIEW').length > 100 };
    }
    const taskId = identifier(args.taskId);
    const path = join(root, taskId + '.json');
    let existing;
    try { existing = JSON.parse(await readFile(path, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    let record;
    if (action === 'bind') {
      const binding = { taskId, originCodexTaskId: identifier(args.originCodexTaskId),
        dshSessionId: identifier(args.dshSessionId), scope: bounded(args.scope, 4096) };
      if (existing) {
        if (Object.keys(binding).some(k => existing[k] !== binding[k])) throw Error('TASK_BINDING_COLLISION');
        return existing;
      }
      if (files.length >= 1000) throw Error('INBOX_LIMIT');
      record = { ...binding, state: 'BOUND', createdAt: new Date().toISOString() };
    } else if (action === 'complete') {
      if (!existing) throw Error('TASK_NOT_BOUND');
      if (existing.dshSessionId !== identifier(args.dshSessionId)) throw Error('SESSION_MISMATCH');
      const receipt = { requestId: identifier(args.requestId), summary: bounded(args.summary, 8192) };
      if (existing.receipt) {
        if (JSON.stringify(existing.receipt) !== JSON.stringify(receipt)) throw Error('RECEIPT_COLLISION');
        return existing;
      }
      record = { ...existing, state: 'AWAITING_REVIEW', receipt,
        evidence: 'UNVERIFIED_CALLER_REPORT', updatedAt: new Date().toISOString() };
    } else throw Error('INVALID_INBOX_ACTION');
    const temp = join(root, randomUUID() + '.tmp');
    try {
      const file = await open(temp, 'wx');
      try { await file.writeFile(JSON.stringify(record)); await file.sync(); }
      finally { await file.close(); }
      await rename(temp, path);
    } finally { await unlink(temp).catch(() => {}); }
    return record;
  } finally { await lock.close(); await unlink(lockPath); }
}
