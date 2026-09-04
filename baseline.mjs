import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

export async function captureBaseline(projectPath) {
  const options = { cwd: projectPath, windowsHide: true, timeout: 10000, maxBuffer: 65536, encoding: 'utf8' };
  try {
    const { stdout: status } = await run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], options);
    let head = null;
    try { head = (await run('git', ['rev-parse', '--verify', 'HEAD'], options)).stdout.trim(); } catch { /* Unborn repository. */ }
    return { kind: 'git', head, porcelain: status, note: 'Pre-existing changes; not permission to overwrite them.' };
  } catch { return { kind: 'unavailable', note: 'No verified Git baseline. Reviewer must establish change ownership independently.' }; }
}
