import { mkdir, open, readFile, rename, unlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function atomicJson(path, value) {
  const data = JSON.stringify(value);
  if (Buffer.byteLength(data) > 8 * 1024 * 1024) throw Error('STATE_TOO_LARGE');
  const temp = path + '.' + randomUUID() + '.tmp';
  try {
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => {}); }
}

export async function readJson(path, max = 8 * 1024 * 1024) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > max) throw Error('INVALID_STATE_FILE');
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function transaction(config, fn) {
  const root = join(config.stateDirectory, 'workflow');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lockPath = join(root, 'state.lock');
  let lock;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { lock = await open(lockPath, 'wx', 0o600); break; }
    catch (e) { if (e.code !== 'EEXIST') throw e; await new Promise(r => setTimeout(r, 20)); }
  }
  if (!lock) throw Error('WORKFLOW_BUSY_OR_STALE_LOCK');
  try {
    const path = join(root, 'tasks.json');
    let db;
    try { db = await readJson(path); } catch (e) { if (e.code !== 'ENOENT') throw e; db = { version: 1, tasks: {} }; }
    if (db.version !== 1 || !db.tasks || Object.keys(db.tasks).length > 256) throw Error('STATE_INVALID');
    const result = await fn(db, root);
    await atomicJson(path, db);
    return result;
  } finally { await lock.close(); await unlink(lockPath); }
}
