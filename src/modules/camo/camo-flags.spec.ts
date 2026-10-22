import { camoDailyEnabled, camoDraining, camoEnabled, camoPublicMatchEnabled, camoVoiceEnabled } from './camo-flags';

const cfg = (env: Record<string, string>) => ({ get: <T = string>(k: string) => env[k] as unknown as T });

describe('camo flags', () => {
  it('everything is off by default', () => {
    const c = cfg({});
    expect([camoEnabled(c), camoPublicMatchEnabled(c), camoVoiceEnabled(c), camoDailyEnabled(c), camoDraining(c)]).toEqual([false, false, false, false, false]);
  });
  it('sub-flags need the master flag', () => {
    const c = cfg({ CAMO_PUBLIC_MATCH_ENABLED: 'true', CAMO_VOICE_ENABLED: 'true', CAMO_DAILY_ENABLED: 'true' });
    expect([camoPublicMatchEnabled(c), camoVoiceEnabled(c), camoDailyEnabled(c)]).toEqual([false, false, false]);
    const on = cfg({ CAMO_ENABLED: 'true', CAMO_PUBLIC_MATCH_ENABLED: 'true' });
    expect([camoEnabled(on), camoPublicMatchEnabled(on), camoVoiceEnabled(on)]).toEqual([true, true, false]);
  });
  it('drain is its own switch', () => {
    expect(camoDraining(cfg({ CAMO_DRAIN: 'true' }))).toBe(true);
  });
});
