import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

// Owns only the stdio proxy process, never the shared Codex daemon.
export class JsonRpcClient {
  constructor(command, args, options = {}) {
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...options });
    let buffer = '';
    const decoder = new StringDecoder('utf8');
    this.child.stderr.on('data', () => {});
    this.child.stdout.on('data', chunk => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) return this.close();
      let boundary;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
        try {
          const message = JSON.parse(line);
          // This client does not authorize tools or answer server approval requests.
          if (message.method && Object.hasOwn(message, 'id')) {
            this.child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Unsupported request' } }) + '\n');
            continue;
          }
          const waiting = this.pending.get(message.id);
          if (!waiting) continue;
          this.pending.delete(message.id); clearTimeout(waiting.timer);
          if (message.error) waiting.reject(Object.assign(Error('CODEX_RPC_REJECTED'), { definitive: true }));
          else waiting.resolve(message.result);
        } catch { /* Malformed or unrelated notifications do not resolve a request. */ }
      }
    });
    this.child.on('error', () => this.close());
    this.child.on('exit', () => this.close());
    this.child.stdin.on('error', () => this.close());
  }
  request(method, params, timeout = 15000) {
    if (this.closed) return Promise.reject(Error('CODEX_DISCONNECTED'));
    if (this.pending.size >= 16) return Promise.reject(Error('CODEX_QUEUE_FULL'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error('CODEX_RESPONSE_UNKNOWN')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async initialize() {
    const result = await this.request('initialize', { clientInfo: { name: 'codex-dsh-mcp', version: '0.2.0' }, capabilities: { experimentalApi: true } });
    this.child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    return result;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error('CODEX_DISCONNECTED')); }
    this.pending.clear(); this.child.stdin.end(); this.child.kill();
  }
}
