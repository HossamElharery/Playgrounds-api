import { TurnstileService } from './turnstile.service';

const config = (env: Record<string, string> = {}) => ({ get: (k: string) => env[k] }) as never;
const withSecret = (extra: { sent?: number; after?: number } = {}) =>
  new TurnstileService(
    config({ TURNSTILE_SECRET_KEY: 'secret' }),
    { sentToday: jest.fn().mockResolvedValue(extra.sent ?? 0) } as never,
    { number: jest.fn().mockReturnValue(extra.after ?? 5) } as never,
  );

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});
const reply = (body: unknown, ok = true) => jest.fn().mockResolvedValue({ ok, status: ok ? 200 : 500, json: async () => body });

describe('TurnstileService', () => {
  it('is dormant without a secret: nothing to verify, nothing enabled', async () => {
    const t = new TurnstileService(config());
    expect(t.enabled).toBe(false);
    expect(await t.verify('anything')).toBe('ok');
  });

  it('accepts a token Cloudflare approves and rejects one it refuses', async () => {
    const t = withSecret();
    global.fetch = reply({ success: true });
    expect(await t.verify('tok', '1.2.3.4')).toBe('ok');
    global.fetch = reply({ success: false, 'error-codes': ['invalid-input-response'] });
    expect(await t.verify('tok')).toBe('failed');
    expect(await t.verify('')).toBe('failed');
  });

  it('reports "error" — not "failed" — when Cloudflare is down or the secret is wrong, so nobody is blamed for our problem', async () => {
    const t = withSecret();
    global.fetch = jest.fn().mockRejectedValue(new Error('network'));
    expect(await t.verify('tok')).toBe('error');
    global.fetch = reply({}, false);
    expect(await t.verify('tok')).toBe('error');
    global.fetch = reply({ success: false, 'error-codes': ['invalid-input-secret'] });
    expect(await t.verify('tok')).toBe('error');
  });

  it('never sends the secret anywhere but the siteverify call', async () => {
    const t = withSecret();
    const f = reply({ success: true });
    global.fetch = f;
    await t.verify('tok', '9.9.9.9');
    expect(f).toHaveBeenCalledTimes(1);
    expect(String(f.mock.calls[0][0])).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
  });

  it('remembers a visitor who passed, for a while', () => {
    const t = withSecret();
    const now = Date.now();
    expect(t.isVerified('1.1.1.1', 'dev-1', now)).toBe(false);
    t.markVerified('1.1.1.1', 'dev-1', now);
    expect(t.isVerified('1.1.1.1', 'dev-1', now + 60_000)).toBe(true);
    expect(t.isVerified('1.1.1.1', 'dev-2', now + 60_000)).toBe(false);
    expect(t.isVerified('1.1.1.1', 'dev-1', now + 31 * 60_000)).toBe(false);
  });

  describe('who looks automated', () => {
    it('lets an ordinary first message through', async () => {
      expect(await withSecret().suspicion('1.1.1.1', 'dev-ordinary', 1000)).toBeNull();
    });

    it('flags a visitor past the message threshold', async () => {
      expect(await withSecret({ sent: 5, after: 5 }).suspicion('1.1.1.1', 'dev-heavy')).toBe('volume');
      expect(await withSecret({ sent: 4, after: 5 }).suspicion('1.1.1.1', 'dev-light')).toBeNull();
    });

    it('flags a burst of messages within seconds', async () => {
      const t = withSecret();
      const now = Date.now();
      const results: (string | null)[] = [];
      for (let i = 0; i < 6; i++) results.push(await t.suspicion('2.2.2.2', 'dev-fast', now + i * 500));
      expect(results.slice(0, 4).every((r) => r === null)).toBe(true);
      expect(results[5]).toBe('burst');
    });

    it('flags one address that keeps producing new device ids', async () => {
      const t = withSecret();
      const now = Date.now();
      const out: (string | null)[] = [];
      for (let i = 0; i < 5; i++) out.push(await t.suspicion('3.3.3.3', `dev-new-${i}`, now + i * 60_000));
      expect(out.slice(0, 3).every((r) => r === null)).toBe(true);
      expect(out[3]).toBe('device_churn');
    });

    it('treats a missing device id as a signal', async () => {
      expect(await withSecret().suspicion('4.4.4.4', undefined)).toBe('no_device');
    });
  });
});
