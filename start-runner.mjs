import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function startRunner(config) {
  if (!config.autoRunner) return { started: false };
  const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'runner.mjs')], {
    detached: true, windowsHide: true, stdio: 'ignore', env: process.env
  });
  child.on('error', () => {}); child.unref();
  return { requested: true }; // Lock and actual liveness are not inferred from spawn alone.
}
