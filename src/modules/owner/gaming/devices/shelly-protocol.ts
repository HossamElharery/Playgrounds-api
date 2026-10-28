/**
 * Shelly Gen2+ JSON-RPC over the device's Outbound WebSocket. The plug dials our server,
 * announces itself with a full status notification, then accepts RPC requests on the same
 * socket. Only the few frames we use are modelled; anything else is ignored.
 * https://shelly-api-docs.shelly.cloud/gen2/General/RPCProtocol
 */
export const SHELLY_RPC_SOURCE = 'matchena';
/** Shelly device ids look like "shellyplugsg3-a1b2c3d4e5f6". */
const DEVICE_ID = /^[a-z0-9][a-z0-9_-]{2,63}$/i;

export interface ShellySwitchState {
  channel: number;
  output?: boolean;
  powerW?: number;
  source?: string;
}

export type ShellyFrame =
  | {
      kind: 'status';
      deviceId: string;
      full: boolean;
      switches: ShellySwitchState[];
    }
  | {
      kind: 'response';
      deviceId: string;
      id: number;
      result?: unknown;
      error?: { code: number; message: string };
    }
  | { kind: 'ignored' };

export function isShellyDeviceId(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_ID.test(value);
}

function switches(params: unknown): ShellySwitchState[] {
  if (!params || typeof params !== 'object') return [];
  const out: ShellySwitchState[] = [];
  for (const [key, value] of Object.entries(
    params as Record<string, unknown>,
  )) {
    const match = /^switch:(\d{1,2})$/.exec(key);
    if (!match || !value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    out.push({
      channel: Number(match[1]),
      ...(typeof v.output === 'boolean' ? { output: v.output } : {}),
      ...(typeof v.apower === 'number' && Number.isFinite(v.apower)
        ? { powerW: v.apower }
        : {}),
      ...(typeof v.source === 'string'
        ? { source: v.source.slice(0, 32) }
        : {}),
    });
  }
  return out;
}

export function parseShellyFrame(raw: string): ShellyFrame {
  let msg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return { kind: 'ignored' };
    msg = parsed as Record<string, unknown>;
  } catch {
    return { kind: 'ignored' };
  }
  if (!isShellyDeviceId(msg.src)) return { kind: 'ignored' };
  const deviceId = msg.src;
  if (
    typeof msg.id === 'number' &&
    msg.dst === SHELLY_RPC_SOURCE &&
    ('result' in msg || 'error' in msg)
  ) {
    const error =
      msg.error && typeof msg.error === 'object'
        ? (msg.error as Record<string, unknown>)
        : null;
    return {
      kind: 'response',
      deviceId,
      id: msg.id,
      result: msg.result,
      ...(error
        ? {
            error: {
              code: Number(error.code) || 0,
              message:
                typeof error.message === 'string'
                  ? error.message.slice(0, 200)
                  : '',
            },
          }
        : {}),
    };
  }
  if (msg.method === 'NotifyFullStatus' || msg.method === 'NotifyStatus') {
    return {
      kind: 'status',
      deviceId,
      full: msg.method === 'NotifyFullStatus',
      switches: switches(msg.params),
    };
  }
  return { kind: 'ignored' };
}

export function shellyRequest(
  id: number,
  method: string,
  params: Record<string, unknown>,
): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    src: SHELLY_RPC_SOURCE,
    method,
    params,
  });
}

/** Switch.Set; `toggleAfter` makes the plug flip back on its own, so a timed session ends even offline. */
export function switchSetParams(
  channel: number,
  on: boolean,
  toggleAfter: number | null,
): Record<string, unknown> {
  return {
    id: channel,
    on,
    ...(toggleAfter ? { toggle_after: toggleAfter } : {}),
  };
}

/** Unplugging and re-plugging must not hand out free play: power back on into "off". */
export function safeConfigParams(channel: number): Record<string, unknown> {
  return { id: channel, config: { initial_state: 'off' } };
}

/** Shelly answers 401 when the device's own password protection is on. */
export function isAuthError(error: { code: number } | undefined): boolean {
  return error?.code === 401;
}

/** "shellyplugsg3-a1b2…" → "shellyplugsg3": good enough to name the model in the UI. */
export function modelFromDeviceId(deviceId: string): string {
  return deviceId.split('-')[0].slice(0, 40);
}
