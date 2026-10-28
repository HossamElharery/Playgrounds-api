import {
  commandFor,
  DEFAULT_DEVICE_SETTINGS,
  deviceIntent,
  deviceSettings,
  relayFor,
  screenFromRelay,
} from './device-policy';

const now = new Date('2026-10-28T18:00:00Z');
const at = (min: number) => new Date(now.getTime() + min * 60_000);
const s = (patch = {}) => ({ ...DEFAULT_DEVICE_SETTINGS, ...patch });

describe('device policy', () => {
  it('sanitises stored settings', () => {
    expect(deviceSettings(null)).toEqual(DEFAULT_DEVICE_SETTINGS);
    expect(
      deviceSettings({ graceMinutes: 99, guard: 'yes', invert: true }),
    ).toEqual({ ...DEFAULT_DEVICE_SETTINGS, invert: true });
  });

  it('timed session: on with a cut-off timer that includes the grace', () => {
    const intent = deviceIntent(s(), { expectedEnd: at(30) }, null, now);
    expect(intent).toMatchObject({
      screenOn: true,
      reason: 'session',
      cutAt: at(32),
    });
    expect(commandFor(intent, s(), null, false, now)).toEqual({
      send: true,
      on: true,
      toggleAfter: 32 * 60,
    });
  });

  it('open session: on, no timer; cutAtEnd off ignores the planned end', () => {
    expect(deviceIntent(s(), { expectedEnd: null }, null, now)).toMatchObject({
      screenOn: true,
      cutAt: null,
      key: 'on:open',
    });
    expect(
      deviceIntent(s({ cutAtEnd: false }), { expectedEnd: at(-10) }, null, now),
    ).toMatchObject({ screenOn: true, cutAt: null });
  });

  it('expired session goes off once the grace has passed', () => {
    expect(deviceIntent(s(), { expectedEnd: at(-1) }, null, now)).toMatchObject(
      { screenOn: true },
    );
    expect(deviceIntent(s(), { expectedEnd: at(-3) }, null, now)).toMatchObject(
      { screenOn: false, reason: 'expired', enforce: true },
    );
  });

  it('idle: guard enforces off, autoOff only sends once, neither leaves the plug alone', () => {
    expect(deviceIntent(s(), null, null, now)).toMatchObject({
      screenOn: false,
      enforce: true,
    });
    const once = deviceIntent(s({ guard: false }), null, null, now);
    expect(once).toMatchObject({ screenOn: false, enforce: false });
    expect(commandFor(once, s({ guard: false }), 'off', true, now)).toBeNull();
    expect(
      deviceIntent(s({ guard: false, autoOff: false }), null, null, now)
        .screenOn,
    ).toBeNull();
  });

  it('guard re-sends off when the plug disagrees, never when it agrees', () => {
    const intent = deviceIntent(s(), null, null, now);
    expect(commandFor(intent, s(), 'off', true, now)).toEqual({
      send: true,
      on: false,
      toggleAfter: null,
    });
    expect(commandFor(intent, s(), 'off', false, now)).toBeNull();
  });

  it('a session does not fight someone switching the screen off', () => {
    const intent = deviceIntent(s(), { expectedEnd: at(30) }, null, now);
    expect(commandFor(intent, s(), intent.key, false, now)).toBeNull();
  });

  it('override wins while it lasts, then normal rules return', () => {
    expect(
      deviceIntent(s(), null, { on: true, until: at(5) }, now),
    ).toMatchObject({ screenOn: true, cutAt: at(5), reason: 'override' });
    expect(
      deviceIntent(
        s(),
        { expectedEnd: null },
        { on: false, until: at(5) },
        now,
      ),
    ).toMatchObject({ screenOn: false, enforce: true });
    expect(
      deviceIntent(s(), null, { on: true, until: at(-1) }, now),
    ).toMatchObject({ reason: 'idle' });
  });

  it('disabled control and manual-start mode leave the plug alone', () => {
    expect(
      deviceIntent(s({ enabled: false }), { expectedEnd: at(5) }, null, now)
        .screenOn,
    ).toBeNull();
    expect(
      deviceIntent(s({ autoOn: false }), { expectedEnd: at(5) }, null, now)
        .screenOn,
    ).toBeNull();
  });

  it('inverted wiring flips relay commands and readings', () => {
    expect(relayFor(true, { invert: true })).toBe(false);
    expect(screenFromRelay(true, { invert: true })).toBe(false);
    expect(screenFromRelay(null, { invert: false })).toBeNull();
    const intent = deviceIntent(
      s({ invert: true }),
      { expectedEnd: at(10) },
      null,
      now,
    );
    expect(commandFor(intent, s({ invert: true }), null, null, now)).toEqual({
      send: true,
      on: false,
      toggleAfter: 12 * 60,
    });
  });
});
