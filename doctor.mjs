import { loadConfig } from './config.mjs';
import { bridge } from './server.mjs';
import { readCodex } from './codex-notifier.mjs';
import { diagnose } from './diagnostics.mjs';

try {
  const config = await loadConfig();
  const result = await diagnose(config, process.env.CODEX_THREAD_ID || config.reviewerThreadId, { bridge, readCodex });
  console.log(JSON.stringify(result));
  if (!result.ready) process.exitCode = 2;
} catch { console.error('CONFIG_INVALID: supply an absolute DSH_MCP_CONFIG path.'); process.exitCode = 2; }
