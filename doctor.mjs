import { loadConfig } from './config.mjs';
import { bridge } from './server.mjs';
import { readCodex } from './codex-notifier.mjs';

try {
  const config = await loadConfig();
  const result = { configuration: 'OK', dsh: 'UNAVAILABLE', codex: 'UNAVAILABLE' };
  try { const status = await bridge(config, 'status'); result.dsh = status.connected ? 'AUTHENTICATED' : (status.error?.match(/^DSH_[A-Z_]+/)?.[0] || 'UNAVAILABLE'); }
  catch { result.dsh = 'CONNECTION_FAILED'; }
  try { const t = await readCodex(config, process.env.CODEX_THREAD_ID || config.reviewerThreadId); result.codex = t.status || 'UNKNOWN'; }
  catch { result.codex = 'PROXY_UNAVAILABLE_OR_THREAD_NOT_FOUND'; }
  console.log(JSON.stringify(result));
  if (result.dsh !== 'AUTHENTICATED' || !['idle','active'].includes(result.codex)) process.exitCode = 2;
} catch { console.error('CONFIG_INVALID: supply an absolute DSH_MCP_CONFIG path.'); process.exitCode = 2; }
