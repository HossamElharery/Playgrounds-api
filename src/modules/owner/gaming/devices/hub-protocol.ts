/**
 * Wire format between the API and a Matchena Hub (the LAN agent that wakes consoles and puts them in
 * rest mode). JSON text frames over one WebSocket the hub dials. Contract: matchena-hub/PROTOCOL.md.
 */
export const HUB_PROTOCOL_VERSION = 1;
export const HUB_SOCKET_PATH = '/api/v1/gaming/hub/connect';

export type ConsoleKind = 'PS4' | 'PS5';
export type ConsolePower = 'awake' | 'standby' | 'unreachable';

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

export type HubFrame =
  | {
      kind: 'hello';
      hubVersion: string;
      platform: string;
      hostname: string;
      psnLinked: boolean;
    }
  | { kind: 'consoles'; list: HubConsole[] }
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
]);

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
