/**
 * Wire format between the API and a Matchena Hub (the LAN agent that wakes consoles and puts them in
 * rest mode). JSON text frames over one WebSocket the hub dials. Contract: matchena-hub/PROTOCOL.md.
 */
export const HUB_PROTOCOL_VERSION = 1;
export const HUB_SOCKET_PATH = '/api/v1/gaming/hub/connect';

export type ConsoleKind = 'PS4' | 'PS5';
export type ConsolePower = 'awake' | 'standby' | 'unreachable';
export type TvBrand = 'samsung' | 'lg' | 'sony' | 'roku';
export const TV_BRANDS: readonly TvBrand[] = ['samsung', 'lg', 'sony', 'roku'];
/** How the owner links a TV: accept a prompt on the TV, type a key set on the TV, or nothing. */
export type TvPairing = 'prompt' | 'secret' | 'none';
export type TvPower = 'on' | 'standby' | 'unreachable';

export interface HubConsole {
  id: string;
  name: string;
  type: ConsoleKind;
  address: string;
  state: ConsolePower;
  paired: boolean;
  systemVersion?: string;
  standbyAt?: string | null;
}

export interface HubTv {
  id: string;
  name: string;
  brand: TvBrand;
  model?: string;
  address: string;
  state: TvPower;
  paired: boolean;
  pairing: TvPairing;
  canWake: boolean;
  offAt?: string | null;
}

export type HubFrame =
  | {
      kind: 'hello';
      hubVersion: string;
      platform: string;
      hostname: string;
      psnLinked: boolean;
      tv: boolean;
    }
  | { kind: 'consoles'; list: HubConsole[] }
  | { kind: 'tvs'; list: HubTv[] }
  | {
      kind: 'response';
      id: number;
      ok: boolean;
      data?: Record<string, unknown>;
      code?: string;
      message?: string;
    }
  | { kind: 'ignored' };

const MAX_CONSOLES = 64;
const CONSOLE_ID = /^[A-Za-z0-9:_-]{3,80}$/;
const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;

const str = (v: unknown, max: number) =>
  typeof v === 'string'
    ? [...v]
        .filter((ch) => ch.charCodeAt(0) > 31)
        .join('')
        .slice(0, max)
    : '';

export function parseConsole(raw: unknown): HubConsole | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== 'string' || !CONSOLE_ID.test(c.id)) return null;
  if (c.type !== 'PS4' && c.type !== 'PS5') return null;
  const state: ConsolePower =
    c.state === 'awake' || c.state === 'standby' ? c.state : 'unreachable';
  const address =
    typeof c.address === 'string' && IPV4.test(c.address) ? c.address : '';
  const standbyAt =
    typeof c.standbyAt === 'string' && !Number.isNaN(Date.parse(c.standbyAt))
      ? c.standbyAt
      : null;
  return {
    id: c.id,
    name: str(c.name, 60) || c.id,
    type: c.type,
    address,
    state,
    paired: c.paired === true,
    ...(typeof c.systemVersion === 'string'
      ? { systemVersion: str(c.systemVersion, 20) }
      : {}),
    standbyAt,
  };
}

const MAX_TVS = 64;

export function parseTv(raw: unknown): HubTv | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== 'string' || !CONSOLE_ID.test(c.id)) return null;
  if (!TV_BRANDS.includes(c.brand as TvBrand)) return null;
  const brand = c.brand as TvBrand;
  const state: TvPower =
    c.state === 'on' || c.state === 'standby' ? c.state : 'unreachable';
  const address =
    typeof c.address === 'string' && IPV4.test(c.address) ? c.address : '';
  const pairing: TvPairing =
    c.pairing === 'secret' || c.pairing === 'none' ? c.pairing : 'prompt';
  const offAt =
    typeof c.offAt === 'string' && !Number.isNaN(Date.parse(c.offAt))
      ? c.offAt
      : null;
  return {
    id: c.id,
    name: str(c.name, 60) || c.id,
    brand,
    ...(typeof c.model === 'string' ? { model: str(c.model, 40) } : {}),
    address,
    state,
    paired: c.paired === true,
    pairing,
    canWake: c.canWake === true,
    offAt,
  };
}

export function parseHubFrame(raw: string): HubFrame {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: 'ignored' };
  }
  if (!value || typeof value !== 'object') return { kind: 'ignored' };
  const f = value as Record<string, unknown>;
  if (f.t === 'hello')
    return {
      kind: 'hello',
      hubVersion: str(f.hubVersion, 24) || 'unknown',
      platform: str(f.platform, 24) || 'unknown',
      hostname: str(f.hostname, 80),
      psnLinked: f.psnLinked === true,
      tv: f.tv === true,
    };
  if (f.t === 'consoles' && Array.isArray(f.list)) {
    const list: HubConsole[] = [];
    const seen = new Set<string>();
    for (const item of f.list.slice(0, MAX_CONSOLES)) {
      const parsed = parseConsole(item);
      if (parsed && !seen.has(parsed.id)) {
        seen.add(parsed.id);
        list.push(parsed);
      }
    }
    return { kind: 'consoles', list };
  }
  if (f.t === 'tvs' && Array.isArray(f.list)) {
    const list: HubTv[] = [];
    const seen = new Set<string>();
    for (const item of f.list.slice(0, MAX_TVS)) {
      const parsed = parseTv(item);
      if (parsed && !seen.has(parsed.id)) {
        seen.add(parsed.id);
        list.push(parsed);
      }
    }
    return { kind: 'tvs', list };
  }
  if (
    f.t === 'res' &&
    typeof f.id === 'number' &&
    Number.isSafeInteger(f.id) &&
    typeof f.ok === 'boolean'
  ) {
    const data =
      f.data && typeof f.data === 'object' && !Array.isArray(f.data)
        ? (f.data as Record<string, unknown>)
        : undefined;
    return {
      kind: 'response',
      id: f.id,
      ok: f.ok,
      ...(data ? { data } : {}),
      ...(typeof f.code === 'string' ? { code: str(f.code, 40) } : {}),
      ...(typeof f.message === 'string'
        ? { message: str(f.message, 200) }
        : {}),
    };
  }
  return { kind: 'ignored' };
}

export function hubRequest(
  id: number,
  op: string,
  args: Record<string, unknown>,
): string {
  return JSON.stringify({ t: 'req', id, op, args });
}

export function hubWelcome(now: Date): string {
  return JSON.stringify({
    t: 'welcome',
    v: HUB_PROTOCOL_VERSION,
    serverNow: now.toISOString(),
  });
}

/** Error codes the hub may return that the owner pages know how to explain. */
export const HUB_ERROR_CODES = new Set([
  'PSN_URL_INVALID',
  'PSN_AUTH_FAILED',
  'PSN_NOT_LINKED',
  'PIN_INVALID',
  'PIN_WRONG',
  'CONSOLE_NOT_FOUND',
  'CONSOLE_UNREACHABLE',
  'PAIR_FAILED',
  'NOT_PAIRED',
  'WAKE_TIMEOUT',
  'WAKE_FAILED',
  'STANDBY_TIMEOUT',
  'STANDBY_FAILED',
  'BROWSER_NOT_FOUND',
  'SIGNIN_TIMEOUT',
  'SIGNIN_CANCELLED',
  'SIGNIN_FAILED',
  'UPDATE_FAILED',
  'UPDATE_NOT_AVAILABLE',
  'TV_NOT_FOUND',
  'TV_NOT_PAIRED',
  'TV_UNSUPPORTED',
  'TV_UNREACHABLE',
  'TV_PAIR_TIMEOUT',
  'TV_PAIR_DENIED',
  'TV_SECRET_WRONG',
  'TV_ON_TIMEOUT',
  'TV_ON_FAILED',
  'TV_OFF_TIMEOUT',
  'TV_OFF_FAILED',
]);

/** The first hub release that can control smart TVs. */
export const HUB_TV_VERSION = '1.1.0';

/** true when dotted version `a` is older than `b` ("1.0.0" < "1.0.1"); anything unusual is never "older". */
export function isOlderVersion(a: unknown, b: unknown): boolean {
  const ok = (v: unknown): v is string =>
    typeof v === 'string' && /^\d+(\.\d+){0,3}$/.test(v);
  if (!ok(a) || !ok(b)) return false;
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return false;
}
