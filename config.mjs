import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export async function loadConfig() {
  const path = process.env.DSH_MCP_CONFIG;
  if (!path || !isAbsolute(path)) throw Error('CONFIG_PATH_REQUIRED');
  const c = JSON.parse(await readFile(path, 'utf8'));
  for (const key of ['powershell', 'stateDirectory']) if (!isAbsolute(c[key] || '')) throw Error('CONFIG_INVALID');
  if (c.authFile && !isAbsolute(c.authFile)) throw Error('CONFIG_INVALID');
  if (c.role && !['reviewer', 'worker'].includes(c.role)) throw Error('CONFIG_INVALID');
  if (c.workflowTimeoutMs !== undefined && (!Number.isInteger(c.workflowTimeoutMs) || c.workflowTimeoutMs < 60000 || c.workflowTimeoutMs > 86400000)) throw Error('CONFIG_INVALID');
  return c;
}
