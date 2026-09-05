import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

// The official proxy is a raw WebSocket stream, NOT JSONL. Node's WebSocket
// implements framing/fragmentation/ping; this one-use loopback relay supplies
// its stream from the existing control-plane proxy, never a new app-server.
export class ProxyRpcClient {
  constructor() { this.pending = new Map(); this.nextId = 1; this.closed = false; }
  static async connect(command, args, options = {}) {
    const c = new ProxyRpcClient();
    try {
      c.server = createServer(socket => {
        if (c.socket || c.closed) { socket.destroy(); return; }
        c.socket = socket; c.server.close();
        c.child = spawn(command, args, { ...options, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        c.child.stderr.on('data', () => {});
        c.child.on('error', () => c.close());
        c.child.on('exit', () => c.close());
        c.child.stdin.on('error', () => c.close());
        socket.on('error', () => c.close());
        socket.pipe(c.child.stdin); c.child.stdout.pipe(socket);
      });
      await new Promise((resolve, reject) => {
        c.server.once('error', reject); c.server.listen(0, '127.0.0.1', resolve);
      });
      c.ws = new WebSocket(`ws://127.0.0.1:${c.server.address().port}/`);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('CODEX_PROXY_CONNECT_TIMEOUT')), 15000);
        const fail = () => { clearTimeout(timer); reject(Error('CODEX_PROXY_UNAVAILABLE')); };
        c.ws.addEventListener('error', fail, { once: true });
        c.ws.addEventListener('close', fail, { once: true });
        c.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      c.ws.addEventListener('message', e => c.receive(e.data));
      c.ws.addEventListener('error', () => c.close());
      c.ws.addEventListener('close', () => c.close());
      return c;
    } catch (e) { c.close(); throw e; }
  }
  receive(data) {
    if (typeof data !== 'string' || Buffer.byteLength(data) > 8 * 1024 * 1024) { this.close(); return; }
    let m; try { m = JSON.parse(data); } catch { this.close(); return; }
    if (!m || typeof m !== 'object') { this.close(); return; }
    if (m.method && Object.hasOwn(m, 'id')) {
      this.ws.send(JSON.stringify({ id: m.id, error: { code: -32601, message: 'Unsupported request' } })); return;
    }
    const p = this.pending.get(m.id); if (!p) return;
    this.pending.delete(m.id); clearTimeout(p.timer);
    if (m.error) p.reject(Object.assign(Error('CODEX_RPC_REJECTED'), { definitive: true }));
    else p.resolve(m.result);
  }
  request(method, params, timeout = 15000) {
    if (this.closed) return Promise.reject(Error('CODEX_DISCONNECTED'));
    if (this.pending.size >= 16) return Promise.reject(Error('CODEX_QUEUE_FULL'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error('CODEX_RESPONSE_UNKNOWN')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch { this.close(); }
    });
  }
  async initialize() {
    const result = await this.request('initialize', { clientInfo: { name: 'codex-dsh-mcp', version: '0.2.0' }, capabilities: { experimentalApi: true } });
    this.ws.send(JSON.stringify({ method: 'initialized', params: {} })); return result;
  }
  close() {
    if (this.closed) return; this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error('CODEX_DISCONNECTED')); }
    this.pending.clear();
    try { this.ws?.close(); } catch {}
    this.socket?.destroy(); this.server?.close();
    this.child?.stdin.end(); this.child?.kill(); // Only the proxy spawned here.
  }
}
