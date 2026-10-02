import { AiCounterStore } from './ai-counter.store';
import { AiQuotaService } from './ai-quota.service';

describe('AiQuotaService', () => {
  let counters: AiCounterStore;
  let quota: AiQuotaService;
  beforeEach(() => {
    counters = new AiCounterStore();
    quota = new AiQuotaService(counters);
  });
  afterEach(async () => {
    quota.onModuleDestroy();
    await counters.onModuleDestroy();
  });

  const rule = (key: string, perMinute = 3, perDay = 5) => ({ key, perMinute, perDay });

  it('counts per identity and refuses over the per-minute limit', async () => {
    const t = Date.parse('2026-10-02T10:00:00Z');
    for (let i = 0; i < 3; i++) expect((await quota.take('c', [rule('ip:1')], t)).ok).toBe(true);
    const v = await quota.take('c', [rule('ip:1')], t + 10_000);
    expect(v).toMatchObject({ ok: false, reason: 'minute' });
    expect((await quota.take('c', [rule('ip:2')], t)).ok).toBe(true);
  });

  it('opens again after the minute', async () => {
    const t = Date.parse('2026-10-02T10:00:00Z');
    for (let i = 0; i < 3; i++) await quota.take('c', [rule('ip:1')], t);
    expect((await quota.take('c', [rule('ip:1')], t + 61_000)).ok).toBe(true);
  });

  it('refuses over the daily limit with the time until it resets', async () => {
    const base = Date.now();
    for (let i = 0; i < 5; i++) await quota.take('c', [rule('ip:1', 100, 5)], base + i * 61_000);
    const v = await quota.take('c', [rule('ip:1', 100, 5)], base + 6 * 61_000);
    expect(v).toMatchObject({ ok: false, reason: 'day' });
    if (!v.ok) expect(v.retryAfterSec).toBeGreaterThan(0);
  });

  it('counts nothing when any rule refuses, so a shared address is not charged for a refused visitor', async () => {
    const t = Date.now();
    for (let i = 0; i < 3; i++) await quota.take('c', [rule('dev:a')], t);
    expect((await quota.take('c', [rule('ip:shared', 10, 10), rule('dev:a')], t)).ok).toBe(false);
    expect(await quota.sentToday('c', 'ip:shared', t)).toBe(0);
  });

  it('keeps scopes apart', async () => {
    const t = Date.now();
    for (let i = 0; i < 3; i++) await quota.take('captain', [rule('user:1')], t);
    expect((await quota.take('captain', [rule('user:1')], t)).ok).toBe(false);
    expect((await quota.take('owner', [rule('user:1')], t)).ok).toBe(true);
  });

  it('starts from what an earlier run of the server already counted today', async () => {
    const t = Date.now();
    const findUnique = jest.fn().mockResolvedValue({ count: 4 });
    const executeRaw = jest.fn().mockResolvedValue(1);
    const stored = new AiCounterStore({ aiCounterDaily: { findUnique }, $executeRaw: executeRaw } as never);
    const q = new AiQuotaService(stored);
    try {
      expect((await q.take('c', [rule('user:7', 10, 5)], t)).ok).toBe(true); // 5th of 5
      expect(await q.take('c', [rule('user:7', 10, 5)], t)).toMatchObject({ ok: false, reason: 'day' });
      await stored.flush();
      expect(executeRaw).toHaveBeenCalledTimes(1);
    } finally {
      q.onModuleDestroy();
      await stored.onModuleDestroy();
    }
  });

  it('never locks anyone out because the table cannot be read', async () => {
    const t = Date.now();
    const stored = new AiCounterStore({
      aiCounterDaily: { findUnique: jest.fn().mockRejectedValue(new Error('db down')) },
      $executeRaw: jest.fn().mockRejectedValue(new Error('db down')),
    } as never);
    const q = new AiQuotaService(stored);
    try {
      expect((await q.take('c', [rule('user:8', 10, 5)], t)).ok).toBe(true);
    } finally {
      q.onModuleDestroy();
      await stored.onModuleDestroy();
    }
  });

  it('never stores an address or a device id as written', async () => {
    const t = Date.now();
    const executeRaw = jest.fn().mockResolvedValue(1);
    const stored = new AiCounterStore({
      aiCounterDaily: { findUnique: jest.fn().mockResolvedValue(null) },
      $executeRaw: executeRaw,
    } as never);
    const q = new AiQuotaService(stored);
    try {
      await q.take('c', [rule('ip:41.130.9.77'), rule('dev:device-secret-1')], t);
      await stored.flush();
      const written = JSON.stringify(executeRaw.mock.calls);
      expect(written).not.toContain('41.130.9.77');
      expect(written).not.toContain('device-secret-1');
    } finally {
      q.onModuleDestroy();
      await stored.onModuleDestroy();
    }
  });
});
