import { WebSocket } from 'ws';

/**
 * A fake Shelly Gen2+ plug speaking the outbound-WebSocket JSON-RPC protocol, for tests and local
 * demos. It announces itself, obeys Switch.Set (including toggle_after) and Switch.SetConfig, and
 * can be "pressed" like the physical button.
 */
export class ShellySimulator {
  output: boolean;
  powerW = 0;
  initialState = 'restore_last';
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  socket?: WebSocket;
  private timer?: NodeJS.Timeout;

  constructor(
    readonly deviceId: string,
    readonly opts: { output?: boolean; auth?: boolean; watts?: number } = {},
  ) {
    this.output = opts.output ?? false;
  }

  connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.socket = ws;
      ws.once('open', () => {
        this.send({ src: this.deviceId, dst: 'ws', method: 'NotifyFullStatus', params: { ts: Date.now() / 1000, 'switch:0': this.status('init') } });
        resolve();
      });
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once('error', reject);
      ws.on('message', (raw) => this.handle(JSON.parse(String(raw)) as { id: number; src: string; method: string; params: Record<string, unknown> }));
    });
  }

  close() {
    clearTimeout(this.timer);
    this.socket?.close();
  }

  closed(): Promise<void> {
    return new Promise((resolve) => (this.socket?.readyState === WebSocket.CLOSED ? resolve() : this.socket?.once('close', () => resolve())));
  }

  /** Someone pressed the button on the plug. */
  press() {
    this.set(!this.output, 'button');
  }

  calledWith(method: string) {
    return this.calls.filter((c) => c.method === method);
  }

  private status(source: string) {
    return { id: 0, source, output: this.output, apower: this.output ? (this.opts.watts ?? 85.4) : 0, voltage: 230.1 };
  }

  private set(on: boolean, source: string) {
    this.output = on;
    this.send({ src: this.deviceId, dst: 'ws', method: 'NotifyStatus', params: { ts: Date.now() / 1000, 'switch:0': this.status(source) } });
  }

  private handle(req: { id: number; src: string; method: string; params: Record<string, unknown> }) {
    this.calls.push({ method: req.method, params: req.params });
    if (this.opts.auth) return this.send({ id: req.id, src: this.deviceId, dst: req.src, error: { code: 401, message: '{"auth_type":"digest"}' } });
    if (req.method === 'Switch.Set') {
      const wasOn = this.output;
      clearTimeout(this.timer);
      this.send({ id: req.id, src: this.deviceId, dst: req.src, result: { was_on: wasOn } });
      this.set(req.params.on === true, 'WS_in');
      const after = Number(req.params.toggle_after);
      if (after > 0) this.timer = setTimeout(() => this.set(!this.output, 'timer'), after * 1000);
      return;
    }
    if (req.method === 'Switch.SetConfig') {
      const config = req.params.config as { initial_state?: string };
      if (config?.initial_state) this.initialState = config.initial_state;
      return this.send({ id: req.id, src: this.deviceId, dst: req.src, result: { restart_required: false } });
    }
    this.send({ id: req.id, src: this.deviceId, dst: req.src, error: { code: 404, message: `No handler for ${req.method}` } });
  }

  private send(frame: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
  }
}
