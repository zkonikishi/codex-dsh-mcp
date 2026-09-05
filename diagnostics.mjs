import { access } from 'node:fs/promises';
import { join } from 'node:path';

// Presence checks only. Never read auth contents, search browser profiles, or
// start a replacement desktop runtime as a side effect of diagnosis.
export async function diagnose(config, threadId, { bridge, readCodex, exists = async p => {
  try { await access(p); return true; } catch { return false; }
} }) {
  const result = { configuration: 'OK', dsh: 'UNAVAILABLE', codex: 'UNAVAILABLE', ready: false, requiredActions: [] };
  if (!config.authFile) {
    result.dsh = 'DSH_AUTH_NOT_CONFIGURED';
    result.requiredActions.push('Import an authorized DSH launch token locally with configure-auth.ps1; never paste it into a task.');
  } else if (!await exists(config.authFile)) {
    result.dsh = 'DSH_AUTH_FILE_MISSING';
    result.requiredActions.push('Re-import DSH authorization using configure-auth.ps1.');
  } else {
    try {
      const s = await bridge(config, 'status');
      result.dsh = s.connected ? 'AUTHENTICATED' : (s.error?.match(/^DSH_[A-Z_]+/)?.[0] || 'UNAVAILABLE');
    } catch { result.dsh = 'CONNECTION_FAILED'; }
  }
  const home = config.codex?.home || process.env.CODEX_HOME;
  const socket = config.codex?.socket || (home && join(home, 'app-server-control', 'app-server-control.sock'));
  if (!config.codex?.command) result.codex = 'CODEX_NOT_CONFIGURED';
  else if (socket && !await exists(socket)) {
    result.codex = 'CODEX_CONTROL_SOCKET_MISSING';
    result.requiredActions.push('Enable a supported control endpoint in the existing Codex desktop runtime or configure its actual socket; do not start a duplicate server.');
  } else if (!threadId) result.codex = 'CODEX_REVIEWER_NOT_BOUND';
  else {
    try { const t = await readCodex(config, threadId); result.codex = t.status || 'UNKNOWN'; }
    catch (e) { result.codex = /^CODEX_[A-Z_]+$/.test(e.message) ? e.message : 'CODEX_CONNECTION_FAILED'; }
  }
  result.ready = result.dsh === 'AUTHENTICATED' && ['active', 'idle'].includes(result.codex);
  return result;
}
