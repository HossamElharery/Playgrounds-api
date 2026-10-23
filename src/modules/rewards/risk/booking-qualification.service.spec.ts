import { BookingQualificationService } from './booking-qualification.service';

const H = 3_600_000;
const slotStart = new Date(Date.now() - 2 * H);

function make(over: { booking?: Record<string, any>; staff?: boolean; linked?: string[]; paid?: boolean } = {}) {
  const booking = {
    id: 'b1',
    userId: 'p1',
    venueId: 'v1',
    source: 'platform',
    status: 'completed',
    totalAmount: 20000,
    createdAt: new Date(slotStart.getTime() - 5 * H),
    slotStart,
    slotEnd: new Date(slotStart.getTime() + H),
    checkedInAt: new Date(slotStart.getTime() + 5 * 60_000),
    checkedInByUserId: 'staff1',
    user: { roles: ['player'], status: 'active', phone: '+201000000001', email: 'p@x.com', rewardsBlockedAt: null },
    venue: {
      ownerId: 'owner1',
      status: 'active',
      approvedAt: new Date(Date.now() - 60 * 24 * H),
      rewardsFrozenAt: null,
      contactPhone: '+201111111111',
      owner: { phone: '+201222222222', email: 'o@x.com' },
    },
    ...over.booking,
  };
  const prisma: any = {
    booking: { findUnique: jest.fn(async () => booking) },
    staffMember: { findFirst: jest.fn(async () => (over.staff ? { id: 's' } : null)) },
    paymentIntent: { findFirst: jest.fn(async () => (over.paid ? { id: 'pi' } : null)) },
  };
  const links = { linkedIds: jest.fn(async () => new Set(over.linked ?? [])) };
  return { svc: new BookingQualificationService(prisma, links as any), prisma };
}

describe('BookingQualificationService', () => {
  it('accepts an ordinary booking: made ahead, checked in during the slot, plain player, established venue', async () => {
    expect(await make().svc.assess('b1')).toEqual({ ok: true, moneyVerified: false, venueId: 'v1', userId: 'p1' });
  });

  it.each([
    ['a missing booking', undefined, 'not_found'],
  ])('rejects %s', async () => {
    const { svc, prisma } = make();
    prisma.booking.findUnique.mockResolvedValue(null);
    expect(await svc.assess('x')).toEqual({ ok: false, reason: 'not_found' });
  });

  const rejects: [string, Record<string, any>, string][] = [
    ['an owner-entered (manual) booking', { source: 'manual' }, 'not_completed_platform_booking'],
    ['a booking that was never checked in', { checkedInAt: null }, 'not_completed_platform_booking'],
    ['a small booking', { totalAmount: 1000 }, 'too_small'],
    ['an owner account playing', { user: { roles: ['player', 'owner'], status: 'active', phone: null, email: null, rewardsBlockedAt: null } }, 'not_a_player'],
    ['a staff account playing', { user: { roles: ['staff'], status: 'active', phone: null, email: null, rewardsBlockedAt: null } }, 'not_a_player'],
    ['a blocked player', { user: { roles: ['player'], status: 'active', phone: null, email: null, rewardsBlockedAt: new Date() } }, 'rewards_blocked'],
    ['the venue owner booking their own venue', { userId: 'owner1' }, 'venue_insider'],
    ['a player with the owner\'s phone number', { user: { roles: ['player'], status: 'active', phone: '+201222222222', email: null, rewardsBlockedAt: null } }, 'venue_insider'],
    ['a player with the venue\'s contact number', { user: { roles: ['player'], status: 'active', phone: '+201111111111', email: null, rewardsBlockedAt: null } }, 'venue_insider'],
    ['a player with the owner\'s email', { user: { roles: ['player'], status: 'active', phone: null, email: 'O@x.com', rewardsBlockedAt: null } }, 'venue_insider'],
    ['a player checked in by themselves', { checkedInByUserId: 'p1' }, 'venue_insider'],
    ['a booking made right before it started (instant book and check-in)', { createdAt: new Date(slotStart.getTime() - 10 * 60_000) }, 'last_minute'],
    ['a check-in long before the slot', { checkedInAt: new Date(slotStart.getTime() - 3 * H) }, 'outside_slot_window'],
    ['a check-in long after the slot', { checkedInAt: new Date(slotStart.getTime() + 4 * H) }, 'outside_slot_window'],
    ['a venue approved yesterday', { venue: { ownerId: 'owner1', status: 'active', approvedAt: new Date(Date.now() - 24 * H), rewardsFrozenAt: null, contactPhone: null, owner: { phone: null, email: null } } }, 'venue_not_eligible'],
    ['a frozen venue', { venue: { ownerId: 'owner1', status: 'active', approvedAt: new Date(Date.now() - 90 * 24 * H), rewardsFrozenAt: new Date(), contactPhone: null, owner: { phone: null, email: null } } }, 'venue_not_eligible'],
    ['a suspended venue', { venue: { ownerId: 'owner1', status: 'suspended', approvedAt: new Date(Date.now() - 90 * 24 * H), rewardsFrozenAt: null, contactPhone: null, owner: { phone: null, email: null } } }, 'venue_not_eligible'],
  ];
  it.each(rejects)('rejects %s', async (_name, booking, reason) => {
    expect(await make({ booking }).svc.assess('b1')).toEqual({ ok: false, reason });
  });

  it('rejects a venue\'s own staff member', async () => {
    expect(await make({ staff: true }).svc.assess('b1')).toEqual({ ok: false, reason: 'venue_insider' });
  });

  it('rejects a player who shares a device with the owner or with whoever checked them in', async () => {
    expect(await make({ linked: ['owner1'] }).svc.assess('b1')).toEqual({ ok: false, reason: 'venue_insider' });
    expect(await make({ linked: ['staff1'] }).svc.assess('b1')).toEqual({ ok: false, reason: 'venue_insider' });
  });

  it('a payment really taken through the gateway is trusted even at a new venue', async () => {
    const fresh = { venue: { ownerId: 'owner1', status: 'active', approvedAt: new Date(Date.now() - 24 * H), rewardsFrozenAt: null, contactPhone: null, owner: { phone: null, email: null } } };
    expect(await make({ booking: fresh, paid: true }).svc.assess('b1')).toEqual(expect.objectContaining({ ok: true, moneyVerified: true }));
  });

  it('but real money does not excuse an owner playing their own venue', async () => {
    expect(await make({ booking: { userId: 'owner1' }, paid: true }).svc.assess('b1')).toEqual({ ok: false, reason: 'venue_insider' });
  });

  it('in strict mode (online payment live) a venue\'s check-in alone is not enough', async () => {
    process.env.REWARDS_REQUIRE_VERIFIED_MONEY = 'true';
    try {
      expect(await make().svc.assess('b1')).toEqual({ ok: false, reason: 'venue_not_eligible' });
      expect(await make({ paid: true }).svc.assess('b1')).toEqual(expect.objectContaining({ ok: true, moneyVerified: true }));
    } finally {
      delete process.env.REWARDS_REQUIRE_VERIFIED_MONEY;
    }
  });
});
