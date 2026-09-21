import { QuickstartService } from './quickstart.service';

function build(over: { courts?: any[]; staff?: number; booking?: any } = {}) {
  const prisma: any = {
    court: { findMany: jest.fn(async () => over.courts ?? []) },
    staffMember: { count: jest.fn(async () => over.staff ?? 0) },
    booking: { findFirst: jest.fn(async () => over.booking ?? null) },
  };
  return new QuickstartService(prisma);
}

const open = { '0': { open: '10:00', close: '23:00' } } as any;

describe('QuickstartService', () => {
  it('a brand-new venue has nothing done and is not complete', async () => {
    const out = await build().compute('v1', 'o1', null);
    expect(out.steps.map((s) => [s.key, s.done])).toEqual([
      ['hours', false], ['courts', false], ['prices', false], ['team', false], ['firstBooking', false],
    ]);
    expect(out.complete).toBe(false);
  });

  it('every step is derived from data: hours, courts, a price on EVERY court, a booking', async () => {
    const svc = build({ courts: [{ id: 'c1', _count: { pricingRules: 2 } }, { id: 'c2', _count: { pricingRules: 0 } }], booking: { id: 'b' } });
    const out = await svc.compute('v1', 'o1', open);
    const done = Object.fromEntries(out.steps.map((s) => [s.key, s.done]));
    expect(done).toEqual({ hours: true, courts: true, prices: false, team: false, firstBooking: true });
    expect(out.complete).toBe(false);
  });

  it('is complete without a team member (optional) and closed-only hours do not count', async () => {
    const full = build({ courts: [{ id: 'c1', _count: { pricingRules: 1 } }], booking: { id: 'b' } });
    expect((await full.compute('v1', 'o1', open)).complete).toBe(true);
    expect((await full.compute('v1', 'o1', { '0': { closed: true } } as any)).complete).toBe(false);
  });
});
