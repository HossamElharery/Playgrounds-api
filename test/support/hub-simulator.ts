import { WebSocket } from 'ws';

export interface SimConsole {
  id: string;
  name: string;
  type: 'PS4' | 'PS5';
  address: string;
  state: 'awake' | 'standby' | 'unreachable';
  paired: boolean;
  standbyAt: string | null;
}

export interface SimTv {
  id: string;
  name: string;
  brand: 'samsung' | 'lg' | 'sony' | 'roku';
  model?: string;
  address: string;
  state: 'on' | 'standby' | 'unreachable';
  paired: boolean;
  pairing: 'prompt' | 'secret' | 'none';
  canWake: boolean;
  offAt: string | null;
}

/**
 * A fake Matchena Hub speaking the hub protocol (matchena-hub/PROTOCOL.md) with simulated consoles,
 * for tests. Wake and standby take a configurable time; the hub keeps `standbyAt` like the real one.
 */
export class HubSimulator {
  readonly calls: { op: string; args: Record<string, unknown> }[] = [];
  readonly consoles = new Map<string, SimConsole>();
  readonly tvs = new Map<string, SimTv>();
  hubVersion = '1.0.0-test';
  /** pairing the next Samsung/LG TV pair call: the owner presses Allow, or declines */
  allowPrompt = true;
  psnLinked = false;
  signinState: 'idle' | 'waiting' | 'done' | 'error' = 'idle';
  delayMs = 30;
  /** op -> error code to answer with (until cleared). */
  fail: Record<string, string> = {};
  socket?: WebSocket;
  welcomed = false;
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(consoles: Partial<SimConsole>[] = []) {
    consoles.forEach((c, i) => {
      const full: SimConsole = {
        id: c.id ?? `CONSOLE${i + 1}`,
        name: c.name ?? `PS5-${i + 1}`,
        type: c.type ?? 'PS5',
        address: c.address ?? `192.168.1.${20 + i}`,
        state: c.state ?? 'standby',
        paired: c.paired ?? false,
        standbyAt: null,
      };
      this.consoles.set(full.id, full);
    });
  }

  connect(url: string, token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
      this.socket = ws;
      ws.once('open', () => {
        this.send({ t: 'hello', v: 1, hubVersion: this.hubVersion, platform: 'test', hostname: 'SIM-PC', psnLinked: this.psnLinked, tv: !this.hubVersion.startsWith('1.0') });
        this.snapshot();
        resolve();
      });
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once('error', reject);
      ws.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as { t: string; id?: number; op?: string; args?: Record<string, unknown> };
        if (frame.t === 'welcome') this.welcomed = true;
        if (frame.t === 'req') void this.handle(frame.id!, frame.op!, frame.args ?? {});
      });
    });
  }

  close() {
    this.timers.forEach(clearTimeout);
    this.socket?.close();
  }

  closed(): Promise<void> {
    return new Promise((resolve) =>
      this.socket?.readyState === WebSocket.CLOSED ? resolve() : this.socket?.once('close', () => resolve()),
    );
  }

  calledWith(op: string) {
    return this.calls.filter((c) => c.op === op);
  }

  /** Someone pressed the console's power button / PS button. */
  press(id: string) {
    const c = this.consoles.get(id)!;
    c.state = c.state === 'awake' ? 'standby' : 'awake';
    this.snapshot();
  }

  /** Someone woke (or rested) the console by hand, whatever it was doing before. */
  power(id: string, state: 'awake' | 'standby') {
    this.consoles.get(id)!.state = state;
    this.snapshot();
  }

  snapshot() {
    this.send({ t: 'consoles', list: [...this.consoles.values()] });
    if (this.tvs.size || !this.hubVersion.startsWith('1.0')) this.send({ t: 'tvs', list: [...this.tvs.values()] });
  }

  addTv(tv: Partial<SimTv>): SimTv {
    const i = this.tvs.size + 1;
    const brand = tv.brand ?? 'samsung';
    const full: SimTv = {
      id: tv.id ?? `tv-${brand}-0000000000${i}`.slice(0, 22),
      name: tv.name ?? `TV ${i}`,
      brand,
      model: tv.model,
      address: tv.address ?? `192.168.1.${40 + i}`,
      state: tv.state ?? 'on',
      paired: tv.paired ?? false,
      pairing: tv.pairing ?? (brand === 'sony' ? 'secret' : brand === 'roku' ? 'none' : 'prompt'),
      canWake: tv.canWake ?? true,
      offAt: null,
    };
    this.tvs.set(full.id, full);
    return full;
  }

  /** Someone used the TV's own remote. */
  tvPower(id: string, state: 'on' | 'standby') {
    this.tvs.get(id)!.state = state;
    this.snapshot();
  }

  private send(frame: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
  }

  private res(id: number, data: Record<string, unknown>) {
    this.send({ t: 'res', id, ok: true, data });
  }

  private err(id: number, code: string) {
    this.send({ t: 'res', id, ok: false, code, message: code });
  }

  private async handle(id: number, op: string, args: Record<string, unknown>) {
    this.calls.push({ op, args });
    const forced = this.fail[op];
    if (forced) return this.err(id, forced);
    const c = this.consoles.get(String(args.consoleId));
    const tv = this.tvs.get(String(args.tvId));
    await new Promise((r) => setTimeout(r, op === 'wake' || op === 'standby' || op === 'tv.on' || op === 'tv.off' ? this.delayMs : 0));
    switch (op) {
      case 'tv.scan':
        this.snapshot();
        return this.res(id, { count: this.tvs.size });
      case 'tv.add': {
        const added = this.addTv({ brand: (args.brand as SimTv['brand']) ?? 'roku', address: String(args.address) });
        this.snapshot();
        return this.res(id, { tv: added });
      }
      case 'tv.pair':
        if (!tv) return this.err(id, 'TV_NOT_FOUND');
        if (tv.pairing === 'secret' && args.secret !== '1234') return this.err(id, 'TV_SECRET_WRONG');
        if (tv.pairing === 'prompt' && !this.allowPrompt) return this.err(id, 'TV_PAIR_DENIED');
        tv.paired = true;
        this.snapshot();
        return this.res(id, { paired: true });
      case 'tv.cancel':
        return this.res(id, {});
      case 'tv.on':
        if (!tv) return this.err(id, 'TV_NOT_FOUND');
        if (!tv.paired) return this.err(id, 'TV_NOT_PAIRED');
        tv.state = 'on';
        tv.offAt = typeof args.offAt === 'string' ? args.offAt : null;
        this.armTv(tv);
        this.snapshot();
        return this.res(id, { state: 'on' });
      case 'tv.off':
        if (!tv) return this.err(id, 'TV_NOT_FOUND');
        if (!tv.paired) return this.err(id, 'TV_NOT_PAIRED');
        tv.offAt = null;
        this.armTv(tv);
        tv.state = 'standby';
        this.snapshot();
        return this.res(id, { state: 'standby' });
      case 'tv.check':
        if (!tv?.paired) return this.err(id, 'TV_NOT_PAIRED');
        return this.res(id, { steps: [{ key: 'reach', ok: true, ms: 40 }, { key: 'off', ok: true, ms: 2500 }, { key: 'on', ok: true, ms: 18000 }] });
      case 'tv.forget':
        if (tv) tv.paired = false;
        this.snapshot();
        return this.res(id, {});
      case 'ping':
        return this.res(id, {});
      case 'scan':
        this.snapshot();
        return this.res(id, { count: this.consoles.size });
      case 'psn.url':
        return this.res(id, { url: 'https://auth.api.sonyentertainmentnetwork.com/2.0/oauth/authorize?sim=1' });
      case 'psn.signin':
        this.signinState = 'waiting';
        setTimeout(() => { if (this.signinState === 'waiting') { this.psnLinked = true; this.signinState = 'done'; } }, this.delayMs * 4);
        return this.res(id, { state: 'waiting' });
      case 'psn.status':
        return this.res(id, { state: this.signinState, error: null, linked: this.psnLinked });
      case 'psn.cancel':
        this.signinState = 'error';
        return this.res(id, {});
      case 'psn.link':
        if (!String(args.redirectUrl).includes('code=')) return this.err(id, 'PSN_URL_INVALID');
        this.psnLinked = true;
        return this.res(id, { linked: true });
      case 'pair':
        if (!this.psnLinked) return this.err(id, 'PSN_NOT_LINKED');
        if (!c) return this.err(id, 'CONSOLE_NOT_FOUND');
        if (args.pin !== '12345678') return this.err(id, 'PIN_WRONG');
        c.paired = true;
        this.snapshot();
        return this.res(id, { paired: true });
      case 'wake':
        if (!c) return this.err(id, 'CONSOLE_NOT_FOUND');
        if (!c.paired) return this.err(id, 'NOT_PAIRED');
        c.standbyAt = typeof args.standbyAt === 'string' ? args.standbyAt : null;
        c.state = 'awake';
        this.arm(c);
        this.snapshot();
        return this.res(id, { state: 'awake' });
      case 'standby':
        if (!c) return this.err(id, 'CONSOLE_NOT_FOUND');
        if (!c.paired) return this.err(id, 'NOT_PAIRED');
        c.standbyAt = null;
        this.arm(c);
        c.state = 'standby';
        this.snapshot();
        return this.res(id, { state: 'standby' });
      case 'check':
        if (!c?.paired) return this.err(id, 'NOT_PAIRED');
        return this.res(id, { steps: [{ key: 'reach', ok: true, ms: 12 }, { key: 'standby', ok: true, ms: 3000 }, { key: 'wake', ok: true, ms: 9000 }] });
      case 'forget':
        if (c) c.paired = false;
        this.snapshot();
        return this.res(id, {});
      default:
        return this.err(id, 'UNKNOWN_OP');
    }
  }

  private armTv(t: SimTv) {
    clearTimeout(this.timers.get(t.id));
    if (!t.offAt) return;
    const wait = Math.max(0, Date.parse(t.offAt) - Date.now());
    this.timers.set(t.id, setTimeout(() => { t.state = 'standby'; t.offAt = null; this.snapshot(); }, wait));
  }

  /** The hub rests the console by itself when the schedule says so, internet or not. */
  private arm(c: SimConsole) {
    clearTimeout(this.timers.get(c.id));
    if (!c.standbyAt) return;
    const wait = Math.max(0, Date.parse(c.standbyAt) - Date.now());
    this.timers.set(c.id, setTimeout(() => { c.state = 'standby'; c.standbyAt = null; this.snapshot(); }, wait));
  }
}
