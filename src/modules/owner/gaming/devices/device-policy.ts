/**
 * What a station's smart plug should be doing right now. Pure: the reconciler feeds it the
 * device settings, the running session (if any) and the clock, and sends a command only when
 * the answer changes — or, with `guard`, whenever the plug disagrees with an "off".
 */
export interface DeviceSettings {
  /** Master switch: off = Matchena never touches this plug. */
  enabled: boolean;
  /** Turn the screen on when a session starts on the station. */
  autoOn: boolean;
  /** Turn the screen off when the session ends. */
  autoOff: boolean;
  /** Turn the screen off when a timed session runs out, even if nobody pressed "end". */
  cutAtEnd: boolean;
  /** Minutes after the planned end before the screen goes off. */
  graceMinutes: number;
  /** Keep the screen off whenever no session runs (switching it on by hand is undone and reported). */
  guard: boolean;
  /** The relay cuts power when ON (normally-closed wiring). */
  invert: boolean;
}

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = {
  enabled: true,
  autoOn: true,
  autoOff: true,
  cutAtEnd: true,
  graceMinutes: 2,
  guard: true,
  invert: false,
};

export const MAX_GRACE_MINUTES = 15;

export function deviceSettings(raw: unknown): DeviceSettings {
  const v =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const bool = (key: keyof DeviceSettings) =>
    typeof v[key] === 'boolean'
      ? v[key]
      : (DEFAULT_DEVICE_SETTINGS[key] as boolean);
  const grace = Number(v.graceMinutes);
  return {
    enabled: bool('enabled'),
    autoOn: bool('autoOn'),
    autoOff: bool('autoOff'),
    cutAtEnd: bool('cutAtEnd'),
    graceMinutes:
      Number.isInteger(grace) && grace >= 0 && grace <= MAX_GRACE_MINUTES
        ? grace
        : DEFAULT_DEVICE_SETTINGS.graceMinutes,
    guard: bool('guard'),
    invert: bool('invert'),
  };
}

export interface PolicySession {
  expectedEnd: Date | null;
}

export interface PolicyOverride {
  on: boolean;
  until: Date;
}

export interface DeviceIntent {
  /** Screen power wanted, or null = leave the plug alone. */
  screenOn: boolean | null;
  /** When the plug must switch itself off (on-device timer, survives the internet dropping). */
  cutAt: Date | null;
  /** Re-send whenever the plug disagrees, not only when the intent changes. */
  enforce: boolean;
  reason:
    | 'disabled'
    | 'override'
    | 'session'
    | 'session-manual'
    | 'expired'
    | 'idle'
    | 'idle-manual';
  /** Stable identity of the intent: a new key means a command goes out. */
  key: string;
}

export function deviceIntent(
  settings: DeviceSettings,
  session: PolicySession | null,
  override: PolicyOverride | null,
  now: Date,
): DeviceIntent {
  if (!settings.enabled)
    return {
      screenOn: null,
      cutAt: null,
      enforce: false,
      reason: 'disabled',
      key: 'disabled',
    };
  if (override && override.until > now) {
    return override.on
      ? {
          screenOn: true,
          cutAt: override.until,
          enforce: false,
          reason: 'override',
          key: `override-on:${override.until.toISOString()}`,
        }
      : {
          screenOn: false,
          cutAt: null,
          enforce: true,
          reason: 'override',
          key: `override-off:${override.until.toISOString()}`,
        };
  }
  if (session) {
    const cutAt =
      settings.cutAtEnd && session.expectedEnd
        ? new Date(
            session.expectedEnd.getTime() + settings.graceMinutes * 60_000,
          )
        : null;
    if (!cutAt || cutAt > now) {
      if (!settings.autoOn)
        return {
          screenOn: null,
          cutAt: null,
          enforce: false,
          reason: 'session-manual',
          key: 'session-manual',
        };
      return {
        screenOn: true,
        cutAt,
        enforce: false,
        reason: 'session',
        key: `on:${cutAt?.toISOString() ?? 'open'}`,
      };
    }
    return {
      screenOn: false,
      cutAt: null,
      enforce: settings.guard,
      reason: 'expired',
      key: 'off',
    };
  }
  if (settings.guard)
    return {
      screenOn: false,
      cutAt: null,
      enforce: true,
      reason: 'idle',
      key: 'off',
    };
  if (settings.autoOff)
    return {
      screenOn: false,
      cutAt: null,
      enforce: false,
      reason: 'idle',
      key: 'off',
    };
  return {
    screenOn: null,
    cutAt: null,
    enforce: false,
    reason: 'idle-manual',
    key: 'idle-manual',
  };
}

/** The relay state that gives the wanted screen power. */
export function relayFor(
  screenOn: boolean,
  settings: Pick<DeviceSettings, 'invert'>,
): boolean {
  return settings.invert ? !screenOn : screenOn;
}

/** Is the screen powered, given what the relay reported? */
export function screenFromRelay(
  output: boolean | null | undefined,
  settings: Pick<DeviceSettings, 'invert'>,
): boolean | null {
  if (output === null || output === undefined) return null;
  return settings.invert ? !output : output;
}

export interface CommandPlan {
  send: boolean;
  /** The relay output to set. */
  on: boolean;
  /** Seconds after which the relay flips back on its own (Shelly `toggle_after`). */
  toggleAfter: number | null;
}

/**
 * Turn an intent into one relay command, or none. `appliedKey` is the key last sent;
 * `reportedScreen` is the screen power the plug last reported (null = unknown).
 */
export function commandFor(
  intent: DeviceIntent,
  settings: DeviceSettings,
  appliedKey: string | null,
  reportedScreen: boolean | null,
  now: Date,
): CommandPlan | null {
  if (intent.screenOn === null) return null;
  const changed = intent.key !== appliedKey;
  const disagrees =
    reportedScreen !== null && reportedScreen !== intent.screenOn;
  if (!changed && !(intent.enforce && disagrees)) return null;
  const on = relayFor(intent.screenOn, settings);
  const seconds =
    intent.screenOn && intent.cutAt
      ? Math.max(1, Math.ceil((intent.cutAt.getTime() - now.getTime()) / 1000))
      : null;
  return { send: true, on, toggleAfter: seconds };
}
