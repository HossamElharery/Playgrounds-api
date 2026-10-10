import { BadRequestException } from '@nestjs/common';
import { VenuesService } from './venues.service';

/**
 * Regression: opening hours had no update path anywhere in the app (only set once, at
 * partner-application approval) — the new-owner checklist pointed at a settings page that
 * couldn't touch them. `update()` is where the frontend's venue page now sends them.
 */
function build() {
  const venue = { id: 'v1', ownerId: 'o1' };
  const prisma = {
    venue: {
      findUnique: jest.fn(async () => venue),
      update: jest.fn(async ({ data }: any) => ({ ...venue, ...data })),
    },
    $transaction: jest.fn((fn: any) => fn(prisma)),
  };
  return { svc: new VenuesService(prisma as any), prisma };
}

const validHours = {
  '0': { closed: true },
  '1': { closed: false, open: '09:00', close: '23:00' },
  '2': { closed: false, open: '09:00', close: '23:00' },
  '3': { closed: false, open: '09:00', close: '23:00' },
  '4': { closed: false, open: '09:00', close: '23:00' },
  '5': { closed: false, open: '09:00', close: '23:00' },
  '6': { closed: false, open: '09:00', close: '23:00' },
};

describe('VenuesService.update — weekly hours', () => {
  it('persists valid hours', async () => {
    const { svc, prisma } = build();
    await svc.update('v1', 'o1', false, { weeklyHours: validHours } as any);
    expect(prisma.venue.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ weeklyHours: validHours }) }),
    );
  });

  it('rejects hours with no open day', async () => {
    const { svc } = build();
    const allClosed = Object.fromEntries(Object.keys(validHours).map((k) => [k, { closed: true }]));
    await expect(svc.update('v1', 'o1', false, { weeklyHours: allClosed } as any)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an invalid time', async () => {
    const { svc } = build();
    const bad = { ...validHours, '1': { closed: false, open: '9:00', close: '23:00' } };
    await expect(svc.update('v1', 'o1', false, { weeklyHours: bad } as any)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('leaves hours untouched when the field is omitted', async () => {
    const { svc, prisma } = build();
    await svc.update('v1', 'o1', false, { nameEn: 'New name' } as any);
    const data = prisma.venue.update.mock.calls[0][0].data;
    expect(data.weeklyHours).toBeUndefined();
  });

  it("a stranger cannot update another owner's venue", async () => {
    const { svc } = build();
    await expect(svc.update('v1', 'someone-else', false, { weeklyHours: validHours } as any)).rejects.toBeDefined();
  });
});

describe('VenuesService — the owner\'s venue page', () => {
  const hours = (open: string, close: string) =>
    Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), { closed: false, open, close }]));
  const rule = (startTime: string, endTime: string, over: Record<string, unknown> = {}) => ({
    id: `r-${startTime}`, daysOfWeek: [] as number[], startTime, endTime, priceAmount: 12000, currency: 'AED', priority: 0, kind: 'base', ...over,
  });
  function detail(venueOver: Record<string, unknown>) {
    const venue = {
      id: 'v1', ownerId: 'o1', currency: 'AED', lat: 25.2, lng: 55.3, address: 'Marina Walk',
      weeklyHours: hours('09:00', '23:45'),
      courts: [{ id: 'c1', name: 'Court 1', pricingRules: [rule('09:00', '23:00')] }],
      photos: [], amenities: [], sports: [],
      ...venueOver,
    };
    const prisma = { venue: { findUnique: jest.fn(async () => venue) } };
    return new VenuesService(prisma as any);
  }

  it('tells the owner which hours have no price instead of leaving them to find out from players', async () => {
    const d: any = await detail({}).getOwnedDetail('v1', 'o1', false);
    expect(d.readiness.missing).toEqual([]);
    expect(d.readiness.pricingGaps).toHaveLength(1);
    expect(d.readiness.pricingGaps[0]).toEqual(
      expect.objectContaining({ courtId: 'c1', gaps: expect.arrayContaining([{ day: 0, from: '23:00', to: '23:45' }]) }),
    );
  });

  it('lists what blocks booking so the page can say it at the top', async () => {
    const d: any = await detail({ lat: 0, lng: 0, address: '', courts: [] }).getOwnedDetail('v1', 'o1', false);
    expect(d.readiness.missing).toEqual(['courts', 'location']);
  });

  it('refuses a price window that ends before it starts', async () => {
    const court = { id: 'c1', venueId: 'v1', venue: { id: 'v1', ownerId: 'o1', currency: 'AED', country: {} } };
    const prisma = { court: { findUnique: jest.fn(async () => court) }, pricingRule: { create: jest.fn() } };
    const svc = new VenuesService(prisma as any);
    await expect(
      svc.addPricingRule('c1', 'o1', false, { daysOfWeek: [], startTime: '22:00', endTime: '09:00', priceAmount: 100 } as any),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'PRICE_WINDOW_INVALID' }) });
    expect(prisma.pricingRule.create).not.toHaveBeenCalled();
  });

  it('stores the venue\'s own currency and a default label when the owner sends neither', async () => {
    const court = { id: 'c1', venueId: 'v1', venue: { id: 'v1', ownerId: 'o1', currency: 'AED', country: {} } };
    const prisma = {
      court: { findUnique: jest.fn(async () => court) },
      pricingRule: { create: jest.fn(async ({ data }: any) => data), aggregate: jest.fn(async () => ({ _min: { priceAmount: 100 } })) },
      venue: { findUnique: jest.fn(async () => ({ currency: 'AED' })), update: jest.fn() },
    };
    const svc = new VenuesService(prisma as any);
    await svc.addPricingRule('c1', 'o1', false, { daysOfWeek: [5, 6], startTime: '09:00', endTime: '24:00', priceAmount: 22000 } as any);
    expect(prisma.pricingRule.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ currency: 'AED', label: 'base', startTime: '09:00', endTime: '24:00' }),
    });
  });
});

describe('VenuesService.update — activities and single-language text', () => {
  function withSports(current: string[], texts?: any) {
    const venue = { id: 'v1', ownerId: 'o1' };
    const prisma: any = {
      venue: { findUnique: jest.fn(async () => venue), update: jest.fn(async ({ data }: any) => ({ ...venue, ...data })) },
      venueSport: { findMany: jest.fn(async () => current.map((sportId) => ({ sportId }))), deleteMany: jest.fn(), createMany: jest.fn() },
      sportCategory: { count: jest.fn(async (args: any) => args.where.id.in.length) },
      court: { count: jest.fn(async () => 0) },
      $transaction: jest.fn((fn: any) => fn(prisma)),
    };
    return { svc: new VenuesService(prisma, undefined, texts), prisma };
  }

  it('an owner cannot change the venue activities, only an administrator can', async () => {
    const { svc, prisma } = withSports(['sport-playstation']);
    await expect(svc.update('v1', 'o1', false, { sportIds: ['sport-playstation', 'sport-padel'] } as any)).rejects.toMatchObject({ response: { code: 'ACTIVITIES_LOCKED' } });
    expect(prisma.venueSport.deleteMany).not.toHaveBeenCalled();
    await svc.update('v1', 'o1', false, { sportIds: ['sport-playstation'] } as any); // same set is harmless
    await svc.update('v1', 'admin', true, { sportIds: ['sport-playstation', 'sport-padel'] } as any);
    expect(prisma.venueSport.createMany).toHaveBeenCalledTimes(2);
  });

  it('a single name and description fill both languages', async () => {
    const texts = { both: jest.fn(async (t: string, kind: string) => (kind === 'name' ? { ar: t, en: 'Neon Lounge' } : { ar: t, en: 'Cosy place' })) };
    const { svc, prisma } = withSports([], texts);
    await svc.update('v1', 'o1', false, { name: 'صالة نيون', description: 'مكان مريح' } as any);
    expect(prisma.venue.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ nameAr: 'صالة نيون', nameEn: 'Neon Lounge', descriptionAr: 'مكان مريح', descriptionEn: 'Cosy place' }) }));
  });
});
