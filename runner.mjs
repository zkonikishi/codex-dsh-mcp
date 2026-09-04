import { open, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from './config.mjs';
import { tick } from './workflow.mjs';

const c = await loadConfig();
const dir = join(c.stateDirectory, 'workflow');
await mkdir(dir, { recursive: true });
let lock;
try { lock = await open(join(dir, 'runner.lock'), 'wx', 0o600); }
catch (e) { if (e.code === 'EEXIST') process.exit(0); throw e; }
await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
let stopped = false;
let wake;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopped = true; wake?.(); });
try {
  do {
    try { await tick(c); } catch { /* Persistent inbox remains intact; no credentials logged. */ }
    if (process.argv.includes('--once') || stopped) break;
    await new Promise(resolve => { const timer = setTimeout(resolve, 3000); wake = () => { clearTimeout(timer); resolve(); }; });
  } while (!stopped);
} finally { await lock.close(); await unlink(join(dir, 'runner.lock')); }
