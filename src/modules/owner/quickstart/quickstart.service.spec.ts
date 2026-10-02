import { QuickstartService } from './quickstart.service';

function build(over: { courts?: any[]; staff?: number; booking?: any; venue?: any; photos?: number; imports?: number } = {}) {
  const prisma: any = {
    court: { findMany: jest.fn(async () => over.courts ?? []) },
    staffMember: { count: jest.fn(async () => over.staff ?? 0) },
    booking: { findFirst: jest.fn(async () => over.booking ?? null) },
    venue: { findUnique: jest.fn(async () => over.venue ?? { descriptionAr: null, descriptionEn: null, address: null, lat: 0, lng: 0, cancellationPolicy: null, contactPhone: null }) },
    venuePhoto: { count: jest.fn(async () => over.photos ?? 0) },
    venueImportBatch: { count: jest.fn(async () => over.imports ?? 0) },
  };
  return new QuickstartService(prisma);
}

const open = { '0': { open: '10:00', close: '23:00' } } as any;

describe('QuickstartService', () => {
  it('a brand-new venue has nothing done and is not complete', async () => {
    const out = await build().compute('v1', 'o1', null);
    expect(out.steps.map((s) => [s.key, s.done])).toEqual([
      ['hours', false], ['courts', false], ['prices', false], ['team', false], ['firstBooking', false], ['import', false],
    ]);
    expect(out.complete).toBe(false);
  });

  it('every step is derived from data: hours, courts, a price on EVERY court, a booking', async () => {
    const svc = build({ courts: [{ id: 'c1', _count: { pricingRules: 2 } }, { id: 'c2', _count: { pricingRules: 0 } }], booking: { id: 'b' } });
    const out = await svc.compute('v1', 'o1', open);
    const done = Object.fromEntries(out.steps.map((s) => [s.key, s.done]));
    expect(done).toEqual({ hours: true, courts: true, prices: false, team: false, firstBooking: true, import: false });
    expect(out.complete).toBe(false);
  });

  it('is complete without a team member (optional) and closed-only hours do not count', async () => {
    const full = build({ courts: [{ id: 'c1', _count: { pricingRules: 1 } }], booking: { id: 'b' } });
    expect((await full.compute('v1', 'o1', open)).complete).toBe(true);
    expect((await full.compute('v1', 'o1', { '0': { closed: true } } as any)).complete).toBe(false);
  });

  it('venue readiness: a published page needs photos, a description, an address, a phone — and says so', async () => {
    const empty = (await build().compute('v1', 'o1', open)).readiness;
    expect(empty.items.filter((i) => !i.done).map((i) => i.key)).toEqual(['photos', 'description', 'address', 'phone', 'cancellation']);
    expect(empty.score).toBe(0);
    expect(empty.complete).toBe(false);

    const ready = (
      await build({
        photos: 4,
        venue: { descriptionAr: 'ملعب خماسي نجيلة صناعية بإضاءة ممتازة', descriptionEn: null, address: '12 شارع النصر', lat: 30.1, lng: 31.2, cancellationPolicy: 'إلغاء قبل 24 ساعة', contactPhone: '+201000000000' },
      }).compute('v1', 'o1', open)
    ).readiness;
    expect(ready.complete).toBe(true);
    expect(ready.score).toBe(100);

    // One photo is "not empty" but still short of the three that make a page look real.
    const onePhoto = (await build({ photos: 1, venue: { descriptionAr: 'x'.repeat(30), address: 'a', lat: 1, lng: 1, cancellationPolicy: 'p', contactPhone: '1' } }).compute('v1', 'o1', open)).readiness;
    expect(onePhoto.items.find((i) => i.key === 'photos')).toMatchObject({ done: true, have: 1, want: 3 });
    expect(onePhoto.complete).toBe(false);
  });

  it('importing the old notebook is an optional step that ticks itself', async () => {
    const out = await build({ imports: 1 }).compute('v1', 'o1', open);
    expect(out.steps.find((s) => s.key === 'import')).toMatchObject({ done: true, optional: true });
  });
});
