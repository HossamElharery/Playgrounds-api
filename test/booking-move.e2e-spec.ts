import { randomUUID } from 'crypto';
import {
  bookings,
  disconnect,
  futureSlot,
  makeUser,
  makeVenue,
  notifications,
  prisma,
  seedWorld,
} from './helpers/booking-harness';
import { BookingMoveService } from '../src/modules/owner/booking-move/booking-move.service';
import { OwnerBookingsService } from '../src/modules/owner/owner-bookings.service';
import { CommissionService } from '../src/modules/finance/commission.service';
import { LedgerService } from '../src/modules/finance/ledger.service';

jest.setTimeout(180_000);

const HOUR = 3_600_000;
const flags: Record<string, string> = {};
const commission = new CommissionService(prisma, {} as never);
const ledger = new LedgerService(prisma, commission);
const ownerBookings = new OwnerBookingsService(
  prisma,
  ledger,
  commission,
  notifications,
);
const moves = new BookingMoveService(
  prisma,
  ownerBookings,
  ledger,
  notifications,
  { get: (k: string) => flags[k] } as never,
);

const codeOf = (error: unknown): string | undefined => {
  const body = (error as { getResponse?: () => unknown })?.getResponse?.();
  if (typeof body === 'string') return body;
  return (
    (body as { code?: string; message?: string } | undefined)?.code ??
    (body as { message?: string })?.message
  );
};
const statusOf = (error: unknown): number | undefined =>
  (error as { getStatus?: () => number })?.getStatus?.();
const rejection = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (error) {
    return { code: codeOf(error), status: statusOf(error) };
  }
  throw new Error('expected the call to be refused');
};

describe('moving a booking (real Postgres)', () => {
  let sportId: string;
  let gamingSportId: string;

  beforeAll(async () => {
    ({ sportId } = await seedWorld());
    gamingSportId = (
      await prisma.sportCategory.upsert({
        where: { slug: 'it-gaming-move' },
        update: {},
        create: {
          slug: 'it-gaming-move',
          nameEn: 'PS',
          nameAr: 'بلايستيشن',
          icon: 'gamepad',
          activityKind: 'gaming-station',
        },
      })
    ).id;
  });
  afterAll(disconnect);
  beforeEach(() => {
    for (const k of Object.keys(flags)) delete flags[k];
  });

  async function world(courts = 3) {
    const owner = await makeUser('owner', ['owner']);
    const { venue, courts: list } = await makeVenue(
      owner.row.id,
      sportId,
      courts,
    );
    return { owner, venue, courts: list };
  }
  const price = (courtId: string, priceAmount: number) =>
    prisma.pricingRule.updateMany({
      where: { courtId },
      data: { priceAmount },
    });

  let seq = 0;
  async function manual(
    venueId: string,
    courtId: string,
    ownerId: string,
    start: Date,
    patch: Record<string, unknown> = {},
    hours = 1,
  ) {
    seq += 1;
    return prisma.booking.create({
      data: {
        code: `MV-${Date.now().toString(36)}${seq}`,
        courtId,
        venueId,
        userId: ownerId,
        slotStart: start,
        slotEnd: new Date(start.getTime() + hours * HOUR),
        baseAmount: 40000,
        totalAmount: 40000,
        currency: 'EGP',
        status: 'confirmed',
        source: 'manual',
        paymentStatus: 'pending',
        guestName: 'Walk-in',
        ...patch,
      },
    });
  }
  async function platform(
    venueId: string,
    courtId: string,
    playerId: string,
    start: Date,
    patch: Record<string, unknown> = {},
  ) {
    seq += 1;
    const b = await prisma.booking.create({
      data: {
        code: `PL-${Date.now().toString(36)}${seq}`,
        courtId,
        venueId,
        userId: playerId,
        slotStart: start,
        slotEnd: new Date(start.getTime() + HOUR),
        baseAmount: 40000,
        feeAmount: 2000,
        totalAmount: 42000,
        currency: 'EGP',
        status: 'confirmed',
        source: 'platform',
        paymentStatus: 'paid',
        paymentModeSnapshot: 'online',
        commissionBps: 1000,
        commissionAmount: 4000,
        ownerNetAmount: 36000,
        ...patch,
      },
    });
    await prisma.$transaction((tx) => ledger.syncBookingLedger(tx, b.id));
    return b;
  }
  const dto = (
    b: { courtId: string; slotStart: Date },
    courtId: string,
    startsAt: Date,
    extra: Record<string, unknown> = {},
  ) => ({
    requestKey: randomUUID(),
    fromCourtId: b.courtId,
    fromStartsAt: b.slotStart.toISOString(),
    courtId,
    startsAt: startsAt.toISOString(),
    ...extra,
  });
  const snapshot = async (bookingId: string) => {
    const [b, payments, entries] = await Promise.all([
      prisma.booking.findUniqueOrThrow({ where: { id: bookingId } }),
      prisma.payment.findMany({
        where: { bookingId },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.venueLedgerEntry.findMany({
        where: { bookingId },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    return { b, payments, entries };
  };

  describe('manual bookings', () => {
    it('moves to another time on the same unit and touches no money', async () => {
      const { owner, venue, courts } = await world();
      const b = await manual(
        venue.id,
        courts[0].id,
        owner.row.id,
        futureSlot(0),
        { paymentStatus: 'partial' },
      );
      await prisma.payment.create({
        data: {
          bookingId: b.id,
          amount: 15000,
          currency: 'EGP',
          method: 'cash',
          status: 'paid',
          recordedByUserId: owner.row.id,
        },
      });
      const before = await snapshot(b.id);
      const target = futureSlot(4);
      const res = await moves.move(
        owner.auth,
        b.id,
        dto(b, courts[0].id, target),
      );
      expect(res.replayed).toBe(false);
      const after = await snapshot(b.id);
      expect(after.b.slotStart.toISOString()).toBe(target.toISOString());
      expect(after.b.slotEnd.toISOString()).toBe(
        new Date(target.getTime() + HOUR).toISOString(),
      );
      expect(after.b.courtId).toBe(courts[0].id);
      expect(after.b.totalAmount).toBe(40000);
      expect(after.b.paymentStatus).toBe('partial');
      expect(after.payments).toEqual(before.payments);
      expect(after.entries).toEqual(before.entries);
      const audit = await prisma.auditLogEntry.findMany({
        where: { targetId: b.id, action: 'owner.booking.moved' },
      });
      expect(audit).toHaveLength(1);
    });

    it('moves to another unit at the same time, and the old unit becomes free for others', async () => {
      const { owner, venue, courts } = await world();
      const start = futureSlot(1);
      const b = await manual(venue.id, courts[0].id, owner.row.id, start);
      await moves.move(owner.auth, b.id, dto(b, courts[1].id, start));
      expect(
        (await prisma.booking.findUniqueOrThrow({ where: { id: b.id } }))
          .courtId,
      ).toBe(courts[1].id);
      const next = await manual(venue.id, courts[0].id, owner.row.id, start);
      expect(next.courtId).toBe(courts[0].id);
    });

    it('announces both the old and the new place to the live availability feed', async () => {
      const { owner, venue, courts } = await world();
      const b = await manual(
        venue.id,
        courts[0].id,
        owner.row.id,
        futureSlot(2),
      );
      const mark =
        (await prisma.slotChange.findFirst({ orderBy: { id: 'desc' } }))?.id ??
        0n;
      await moves.move(owner.auth, b.id, dto(b, courts[1].id, futureSlot(5)));
      const rows = await prisma.slotChange.findMany({
        where: { id: { gt: mark }, venueId: venue.id },
      });
      expect(new Set(rows.map((r) => r.courtId))).toEqual(
        new Set([courts[0].id, courts[1].id]),
      );
    });

    it('the same request key twice moves once and returns the first result', async () => {
      const { owner, venue, courts } = await world();
      const b = await manual(
        venue.id,
        courts[0].id,
        owner.row.id,
        futureSlot(0),
      );
      const d = dto(b, courts[1].id, futureSlot(6));
      const first = await moves.move(owner.auth, b.id, d);
      const second = await moves.move(owner.auth, b.id, d);
      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
      expect(
        await prisma.auditLogEntry.count({
          where: { targetId: b.id, action: 'owner.booking.moved' },
        }),
      ).toBe(1);
      const r = await rejection(
        moves.move(owner.auth, b.id, {
          ...d,
          startsAt: futureSlot(7).toISOString(),
        }),
      );
      expect(r).toEqual({ code: 'OPERATION_KEY_REUSED', status: 409 });
    });

    it('someone else cannot reuse the key of another person', async () => {
      const { owner, venue, courts } = await world();
      const admin = await makeUser('admin', ['admin']);
      admin.auth.adminEdit = true;
      const b = await manual(
        venue.id,
        courts[0].id,
        owner.row.id,
        futureSlot(0),
      );
      const d = dto(b, courts[1].id, futureSlot(6));
      await moves.move(owner.auth, b.id, d);
      expect((await rejection(moves.move(admin.auth, b.id, d))).code).toBe(
        'OPERATION_KEY_REUSED',
      );
    });

    it('a stale screen is refused', async () => {
      const { owner, venue, courts } = await world();
      const b = await manual(
        venue.id,
        courts[0].id,
        owner.row.id,
        futureSlot(0),
      );
      const stale = dto(
        { courtId: courts[0].id, slotStart: futureSlot(1) },
        courts[1].id,
        futureSlot(6),
      );
      expect((await rejection(moves.move(owner.auth, b.id, stale))).code).toBe(
        'BOOKING_CHANGED',
      );
      const wrongCourt = dto(
        { courtId: courts[2].id, slotStart: b.slotStart },
        courts[1].id,
        futureSlot(6),
      );
      expect(
        (await rejection(moves.move(owner.auth, b.id, wrongCourt))).code,
      ).toBe('BOOKING_CHANGED');
    });

    it('refuses a taken, blocked or overlapping destination and leaves the booking alone', async () => {
      const { owner, venue, courts } = await world();
      const b = await manual(
        venue.id,
        courts[0].id,
        owner.row.id,
        futureSlot(0),
      );
      await manual(venue.id, courts[1].id, owner.row.id, futureSlot(5));
      expect(
        (
          await rejection(
            moves.move(owner.auth, b.id, dto(b, courts[1].id, futureSlot(5))),
          )
        ).code,
      ).toBe('SLOT_ALREADY_HELD');
      expect(
        (
          await rejection(
            moves.move(
              owner.auth,
              b.id,
              dto(
                b,
                courts[1].id,
                new Date(futureSlot(5).getTime() + 30 * 60_000),
              ),
            ),
          )
        ).code,
      ).toBe('SLOT_ALREADY_HELD');
      await prisma.calendarBlock.create({
        data: {
          venueId: venue.id,
          courtId: courts[2].id,
          kind: 'maintenance',
          startsAt: futureSlot(8),
          endsAt: new Date(futureSlot(8).getTime() + 2 * HOUR),
          createdById: owner.row.id,
        },
      });
      expect(
        (
          await rejection(
            moves.move(owner.auth, b.id, dto(b, courts[2].id, futureSlot(9))),
          )
        ).code,
      ).toBe('SLOT_BLOCKED');
      await prisma.calendarBlock.create({
        data: {
          venueId: venue.id,
          courtId: null,
          kind: 'maintenance',
          startsAt: futureSlot(11),
          endsAt: new Date(futureSlot(11).getTime() + HOUR),
          createdById: owner.row.id,
        },
      });
      expect(
        (
          await rejection(
            moves.move(owner.auth, b.id, dto(b, courts[1].id, futureSlot(11))),
          )
        ).code,
      ).toBe('SLOT_BLOCKED');
      const after = await prisma.booking.findUniqueOrThrow({
        where: { id: b.id },
      });
      expect(after.slotStart.toISOString()).toBe(b.slotStart.toISOString());
      expect(after.courtId).toBe(courts[0].id);
    });

    it('moving to its own current place is "nothing to move"; moving into overlap with itself is allowed', async () => {
      const { owner, venue, courts } = await world();
      const b = await manual(
        venue.id,
        courts[0].id,
        owner.row.id,
        futureSlot(0),
      );
      expect(
        (
          await rejection(
            moves.move(owner.auth, b.id, dto(b, courts[0].id, b.slotStart)),
          )
        ).code,
      ).toBe('NOTHING_TO_MOVE');
      await moves.move(
        owner.auth,
        b.id,
        dto(b, courts[0].id, new Date(b.slotStart.getTime() + 30 * 60_000)),
      );
    });

    it('two bookings racing for the same free slot: exactly one wins, no overlap is ever stored', async () => {
      const { owner, venue, courts } = await world();
      const a = await manual(
        venue.id,
        courts[0].id,
        owner.row.id,
        futureSlot(0),
      );
      const c = await manual(
        venue.id,
        courts[1].id,
        owner.row.id,
        futureSlot(0),
      );
      const target = futureSlot(7);
      const results = await Promise.allSettled([
        moves.move(owner.auth, a.id, dto(a, courts[2].id, target)),
        moves.move(owner.auth, c.id, dto(c, courts[2].id, target)),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const loser = results.find(
        (r) => r.status === 'rejected',
      ) as PromiseRejectedResult;
      expect(['SLOT_ALREADY_HELD', 'CONCURRENT_CHANGE']).toContain(
        codeOf(loser.reason),
      );
      expect(statusOf(loser.reason)).toBe(409);
      const onTarget = await prisma.booking.count({
        where: {
          courtId: courts[2].id,
          slotStart: target,
          status: 'confirmed',
        },
      });
      expect(onTarget).toBe(1);
    });

    it('a move racing a player hold for the same slot: one winner, never two', async () => {
      const { owner, venue, courts } = await world();
      const player = await makeUser('p');
      const m = await manual(
        venue.id,
        courts[0].id,
        owner.row.id,
        futureSlot(0),
      );
      const target = futureSlot(9);
      const results = await Promise.allSettled([
        moves.move(owner.auth, m.id, dto(m, courts[1].id, target)),
        bookings.holdSlot(player.row.id, {
          courtId: courts[1].id,
          slotStart: target.toISOString(),
        }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        await prisma.booking.count({
          where: {
            courtId: courts[1].id,
            slotStart: target,
            status: { in: ['held', 'confirmed'] },
          },
        }),
      ).toBe(1);
    });

    it('the same request fired twice at once still moves once', async () => {
      const { owner, venue, courts } = await world();
      const b = await manual(
        venue.id,
        courts[0].id,
        owner.row.id,
        futureSlot(0),
      );
      const d = dto(b, courts[1].id, futureSlot(6));
      const results = await Promise.allSettled([
        moves.move(owner.auth, b.id, d),
        moves.move(owner.auth, b.id, d),
      ]);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      expect(
        await prisma.auditLogEntry.count({
          where: { targetId: b.id, action: 'owner.booking.moved' },
        }),
      ).toBe(1);
    });

    it('refuses cancelled, completed, no-show, attended and held bookings', async () => {
      const { owner, venue, courts } = await world();
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ status: 'cancelled' }, 'BOOKING_NOT_MOVABLE_STATUS'],
        [{ status: 'completed' }, 'BOOKING_NOT_MOVABLE_STATUS'],
        [{ status: 'no_show' }, 'BOOKING_NOT_MOVABLE_STATUS'],
        [{ checkedInAt: new Date() }, 'BOOKING_CHECKED_IN'],
        [
          { status: 'held', holdExpiresAt: new Date(Date.now() + 60_000) },
          'BOOKING_NOT_MOVABLE_STATUS',
        ],
      ];
      let offset = 0;
      for (const [patch, expected] of cases) {
        const b = await manual(
          venue.id,
          courts[0].id,
          owner.row.id,
          futureSlot(offset),
          patch,
        );
        offset += 2;
        expect(
          (
            await rejection(
              moves.move(
                owner.auth,
                b.id,
                dto(b, courts[1].id, futureSlot(20)),
              ),
            )
          ).code,
        ).toBe(expected);
      }
    });

    it('refuses a booking that already started, a past or too-distant target, and a time off the minute', async () => {
      const { owner, venue, courts } = await world();
      const started = await manual(
        venue.id,
        courts[0].id,
        owner.row.id,
        new Date(Date.now() - HOUR),
      );
      expect(
        (
          await rejection(
            moves.move(
              owner.auth,
              started.id,
              dto(started, courts[1].id, futureSlot(3)),
            ),
          )
        ).code,
      ).toBe('BOOKING_STARTED');
      const b = await manual(
        venue.id,
        courts[0].id,
        owner.row.id,
        futureSlot(0),
      );
      expect(
        (
          await rejection(
            moves.move(
              owner.auth,
              b.id,
              dto(
                b,
                courts[1].id,
                new Date(Math.floor((Date.now() - 2 * HOUR) / 60_000) * 60_000),
              ),
            ),
          )
        ).code,
      ).toBe('SLOT_IN_PAST');
      expect(
        (
          await rejection(
            moves.move(
              owner.auth,
              b.id,
              dto(
                b,
                courts[1].id,
                new Date(
                  Math.floor((Date.now() + 120 * 86_400_000) / 60_000) * 60_000,
                ),
              ),
            ),
          )
        ).code,
      ).toBe('BOOKING_TOO_FAR_AHEAD');
      expect(
        (
          await rejection(
            moves.move(
              owner.auth,
              b.id,
              dto(b, courts[1].id, new Date(futureSlot(4).getTime() + 30_000)),
            ),
          )
        ).code,
      ).toBe('INVALID_SLOT_START');
    });

    it('refuses a time outside the opening hours', async () => {
      const owner = await makeUser('owner', ['owner']);
      const hours = Object.fromEntries(
        [0, 1, 2, 3, 4, 5, 6].map((d) => [
          String(d),
          { closed: false, open: '12:00', close: '20:00' },
        ]),
      );
      const { venue, courts } = await makeVenue(owner.row.id, sportId, 2, {
        weeklyHours: hours,
      });
      const b = await manual(
        venue.id,
        courts[0].id,
        owner.row.id,
        futureSlot(0),
      );
      const lateNight = futureSlot(0, 6);
      lateNight.setUTCHours(21); // 23:00 in Cairo
      expect(
        (
          await rejection(
            moves.move(owner.auth, b.id, dto(b, courts[1].id, lateNight)),
          )
        ).code,
      ).toBe('OUTSIDE_HOURS');
    });

    it('refuses a unit of another venue (and says nothing about it) and another sport', async () => {
      const { owner, venue, courts } = await world();
      const other = await world(1);
      const b = await manual(
        venue.id,
        courts[0].id,
        owner.row.id,
        futureSlot(0),
      );
      expect(
        (
          await rejection(
            moves.move(
              owner.auth,
              b.id,
              dto(b, other.courts[0].id, futureSlot(5)),
            ),
          )
        ).code,
      ).toBe('UNIT_NOT_COMPATIBLE');
      const ps = await prisma.court.create({
        data: {
          venueId: venue.id,
          sportId: gamingSportId,
          name: 'PS 1',
          slotDurationMins: 60,
        },
      });
      expect(
        (
          await rejection(
            moves.move(owner.auth, b.id, dto(b, ps.id, futureSlot(5))),
          )
        ).code,
      ).toBe('UNIT_NOT_COMPATIBLE');
    });

    it('cannot touch a booking of another venue, or write as a read-only admin', async () => {
      const { venue, courts } = await world();
      const stranger = await makeUser('owner', ['owner']);
      const owner = await prisma.user.findUniqueOrThrow({
        where: { id: venue.ownerId },
      });
      const b = await manual(venue.id, courts[0].id, owner.id, futureSlot(0));
      const r = await rejection(
        moves.move(stranger.auth, b.id, dto(b, courts[1].id, futureSlot(5))),
      );
      expect(r.status).toBe(403);
      const admin = await makeUser('admin', ['admin']);
      admin.auth.adminEdit = false;
      expect(
        (
          await rejection(
            moves.move(admin.auth, b.id, dto(b, courts[1].id, futureSlot(5))),
          )
        ).code,
      ).toBe('ADMIN_READ_ONLY');
      expect((await moves.preview(admin.auth, b.id, {})).canMove).toBe(true);
    });

    it('staff need the bookings.edit permission', async () => {
      const { owner, venue, courts } = await world();
      const staff = await makeUser('staff', ['staff']);
      await prisma.staffMember.create({
        data: {
          userId: staff.row.id,
          ownerId: owner.row.id,
          permissions: ['bookings.view'],
          venueIds: [venue.id],
          createdById: owner.row.id,
        },
      });
      const b = await manual(
        venue.id,
        courts[0].id,
        owner.row.id,
        futureSlot(0),
      );
      expect(
        (
          await rejection(
            moves.move(staff.auth, b.id, dto(b, courts[1].id, futureSlot(5))),
          )
        ).code,
      ).toBe('INSUFFICIENT_PERMISSION');
      await prisma.staffMember.update({
        where: { userId: staff.row.id },
        data: { permissions: ['bookings.view', 'bookings.edit'] },
      });
      await moves.move(staff.auth, b.id, dto(b, courts[1].id, futureSlot(5)));
    });

    it('re-pricing: only when allowed, never below what was received, and the status follows the money', async () => {
      const { owner, venue, courts } = await world();
      await price(courts[1].id, 60000);
      const b = await manual(
        venue.id,
        courts[0].id,
        owner.row.id,
        futureSlot(0),
        { paymentStatus: 'partial' },
      );
      await prisma.payment.create({
        data: {
          bookingId: b.id,
          amount: 30000,
          currency: 'EGP',
          method: 'cash',
          status: 'paid',
          recordedByUserId: owner.row.id,
        },
      });
      const res = await moves.move(
        owner.auth,
        b.id,
        dto(b, courts[1].id, futureSlot(5), { priceMode: 'reprice' }),
      );
      expect(res.moved.priceChanged).toBe(true);
      const after = await snapshot(b.id);
      expect(after.b.totalAmount).toBe(60000);
      expect(after.b.baseAmount).toBe(60000);
      expect(after.b.paymentStatus).toBe('partial');
      expect(after.payments).toHaveLength(1);
      // Cheaper than what was already received: re-pricing is not offered.
      await price(courts[2].id, 20000);
      const again = await prisma.booking.findUniqueOrThrow({
        where: { id: b.id },
      });
      expect(
        (
          await rejection(
            moves.move(
              owner.auth,
              b.id,
              dto(again, courts[2].id, futureSlot(8), { priceMode: 'reprice' }),
            ),
          )
        ).code,
      ).toBe('PRICE_MODE_NOT_ALLOWED');
      // ...but keeping the price is always fine.
      await moves.move(
        owner.auth,
        b.id,
        dto(again, courts[2].id, futureSlot(8)),
      );
      expect(
        (await prisma.booking.findUniqueOrThrow({ where: { id: b.id } }))
          .totalAmount,
      ).toBe(60000);
    });

    it('re-pricing to a fully covered amount marks it paid', async () => {
      const { owner, venue, courts } = await world();
      await price(courts[1].id, 20000);
      const b = await manual(
        venue.id,
        courts[0].id,
        owner.row.id,
        futureSlot(0),
        { paymentStatus: 'partial' },
      );
      await prisma.payment.create({
        data: {
          bookingId: b.id,
          amount: 20000,
          currency: 'EGP',
          method: 'cash',
          status: 'paid',
          recordedByUserId: owner.row.id,
        },
      });
      await moves.move(
        owner.auth,
        b.id,
        dto(b, courts[1].id, futureSlot(5), { priceMode: 'reprice' }),
      );
      expect(
        (await prisma.booking.findUniqueOrThrow({ where: { id: b.id } }))
          .paymentStatus,
      ).toBe('paid');
    });

    it('lets the collection reminders fire again for the new time', async () => {
      const { owner, venue, courts } = await world();
      const b = await manual(
        venue.id,
        courts[0].id,
        owner.row.id,
        futureSlot(0),
      );
      const old = await prisma.notification.create({
        data: {
          userId: owner.row.id,
          category: 'system',
          titleEn: 't',
          titleAr: 't',
          payload: { paymentReminderFor: b.id, venueId: venue.id },
        },
      });
      await moves.move(owner.auth, b.id, dto(b, courts[1].id, futureSlot(5)));
      const row = await prisma.notification.findUniqueOrThrow({
        where: { id: old.id },
      });
      expect(
        (row.payload as Record<string, string>).paymentReminderFor,
      ).not.toBe(b.id);
      expect(
        await prisma.notification.count({
          where: {
            userId: owner.row.id,
            payload: { path: ['paymentReminderFor'], equals: b.id },
          },
        }),
      ).toBe(0);
    });

    it('the old edit route can no longer move an attended or closed booking, but still extends it', async () => {
      const { owner, venue, courts } = await world();
      const done = await manual(
        venue.id,
        courts[0].id,
        owner.row.id,
        futureSlot(0),
        { status: 'completed' },
      );
      const r = await rejection(
        ownerBookings.updateManualBooking(owner.auth, done.id, {
          startsAt: futureSlot(6).toISOString(),
        }),
      );
      expect(r.code).toBe('BOOKING_NOT_MOVABLE_STATUS');
      const attended = await manual(
        venue.id,
        courts[1].id,
        owner.row.id,
        futureSlot(0),
        { checkedInAt: new Date() },
      );
      expect(
        (
          await rejection(
            ownerBookings.updateManualBooking(owner.auth, attended.id, {
              courtId: courts[2].id,
            }),
          )
        ).code,
      ).toBe('BOOKING_NOT_MOVABLE_STATUS');
      await ownerBookings.updateManualBooking(owner.auth, attended.id, {
        durationMinutes: 90,
      });
    });
  });

  describe('Matchena (platform) bookings', () => {
    it('are refused while the switch is off, and the booking is untouched', async () => {
      const { owner, venue, courts } = await world();
      const player = await makeUser('p');
      const b = await platform(
        venue.id,
        courts[0].id,
        player.row.id,
        futureSlot(0),
      );
      expect(
        (
          await rejection(
            moves.move(owner.auth, b.id, dto(b, courts[1].id, futureSlot(5))),
          )
        ).code,
      ).toBe('PLATFORM_MOVE_DISABLED');
      const p = await moves.preview(owner.auth, b.id, {});
      expect(p.canMove).toBe(false);
      expect(p.blocker).toBe('PLATFORM_MOVE_DISABLED');
    });

    it('move at the same price: money, commission and the venue ledger do not change; the player is told once', async () => {
      flags['BOOKING_MOVE_PLATFORM_ENABLED'] = 'true';
      const { owner, venue, courts } = await world();
      const player = await makeUser('p');
      const b = await platform(
        venue.id,
        courts[0].id,
        player.row.id,
        futureSlot(0),
      );
      const before = await snapshot(b.id);
      expect(before.entries.length).toBe(1);
      const reminder = await prisma.notification.create({
        data: {
          userId: player.row.id,
          category: 'bookings',
          titleEn: 'r',
          titleAr: 'r',
          dedupKey: `booking-reminder-player:${b.id}`,
        },
      });
      const d = dto(b, courts[1].id, futureSlot(5));
      await moves.move(owner.auth, b.id, d);
      await moves.move(owner.auth, b.id, d);
      expect(
        (
          await prisma.notification.findUniqueOrThrow({
            where: { id: reminder.id },
          })
        ).dedupKey,
      ).not.toBe(`booking-reminder-player:${b.id}`);
      const after = await snapshot(b.id);
      expect(after.b.slotStart.toISOString()).toBe(futureSlot(5).toISOString());
      for (const f of [
        'baseAmount',
        'feeAmount',
        'totalAmount',
        'discountAmount',
        'commissionBps',
        'commissionAmount',
        'ownerNetAmount',
        'paymentStatus',
      ] as const) {
        expect(after.b[f]).toEqual(before.b[f]);
      }
      expect(after.entries).toEqual(before.entries);
      expect(after.payments).toEqual(before.payments);
      const notes = await prisma.notification.findMany({
        where: {
          userId: player.row.id,
          dedupKey: { startsWith: 'booking-moved:' },
        },
      });
      expect(notes).toHaveLength(1);
      expect(notes[0].deepLink).toBe('/app/bookings');
      expect(notes[0].dedupKey).toBe(`booking-moved:${b.id}:${d.requestKey}`);
    });

    it('a dearer destination needs the owner to say the player keeps the price; the price never changes', async () => {
      flags['BOOKING_MOVE_PLATFORM_ENABLED'] = 'true';
      const { owner, venue, courts } = await world();
      await price(courts[1].id, 55000);
      const player = await makeUser('p');
      const b = await platform(
        venue.id,
        courts[0].id,
        player.row.id,
        futureSlot(0),
      );
      expect(
        (
          await rejection(
            moves.move(owner.auth, b.id, dto(b, courts[1].id, futureSlot(5))),
          )
        ).code,
      ).toBe('PRICE_HIGHER_NEEDS_APPROVAL');
      const staff = await makeUser('staff', ['staff']);
      await prisma.staffMember.create({
        data: {
          userId: staff.row.id,
          ownerId: owner.row.id,
          permissions: ['bookings.view', 'bookings.edit'],
          venueIds: [venue.id],
          createdById: owner.row.id,
        },
      });
      expect(
        (
          await rejection(
            moves.move(
              staff.auth,
              b.id,
              dto(b, courts[1].id, futureSlot(5), { honorOriginalPrice: true }),
            ),
          )
        ).code,
      ).toBe('INSUFFICIENT_PERMISSION');
      const before = await snapshot(b.id);
      await moves.move(
        owner.auth,
        b.id,
        dto(b, courts[1].id, futureSlot(5), { honorOriginalPrice: true }),
      );
      const after = await snapshot(b.id);
      expect(after.b.totalAmount).toBe(42000);
      expect(after.b.baseAmount).toBe(40000);
      expect(after.entries).toEqual(before.entries);
      const log = await prisma.auditLogEntry.findFirstOrThrow({
        where: { targetId: b.id, action: 'owner.booking.moved' },
      });
      expect((log.metadata as Record<string, unknown>).honorOriginalPrice).toBe(
        true,
      );
    });

    it('a cheaper destination is a refund, not a move', async () => {
      flags['BOOKING_MOVE_PLATFORM_ENABLED'] = 'true';
      const { owner, venue, courts } = await world();
      await price(courts[1].id, 30000);
      const player = await makeUser('p');
      const b = await platform(
        venue.id,
        courts[0].id,
        player.row.id,
        futureSlot(0),
      );
      expect(
        (
          await rejection(
            moves.move(
              owner.auth,
              b.id,
              dto(b, courts[1].id, futureSlot(5), { honorOriginalPrice: true }),
            ),
          )
        ).code,
      ).toBe('PRICE_LOWER_USE_REFUND');
    });

    it('never re-prices a Matchena booking', async () => {
      flags['BOOKING_MOVE_PLATFORM_ENABLED'] = 'true';
      const { owner, venue, courts } = await world();
      const player = await makeUser('p');
      const b = await platform(
        venue.id,
        courts[0].id,
        player.row.id,
        futureSlot(0),
      );
      expect(
        (
          await rejection(
            moves.move(
              owner.auth,
              b.id,
              dto(b, courts[1].id, futureSlot(5), { priceMode: 'reprice' }),
            ),
          )
        ).code,
      ).toBe('PRICE_MODE_NOT_ALLOWED');
    });

    it('keeps to the court slot grid and length, like a new booking would', async () => {
      flags['BOOKING_MOVE_PLATFORM_ENABLED'] = 'true';
      const { owner, venue, courts } = await world();
      const player = await makeUser('p');
      const b = await platform(
        venue.id,
        courts[0].id,
        player.row.id,
        futureSlot(0),
      );
      expect(
        (
          await rejection(
            moves.move(
              owner.auth,
              b.id,
              dto(
                b,
                courts[1].id,
                new Date(futureSlot(5).getTime() + 30 * 60_000),
              ),
            ),
          )
        ).code,
      ).toBe('INVALID_SLOT_START');
      await prisma.court.update({
        where: { id: courts[2].id },
        data: { slotDurationMins: 90 },
      });
      expect(
        (
          await rejection(
            moves.move(owner.auth, b.id, dto(b, courts[2].id, futureSlot(5))),
          )
        ).code,
      ).toBeDefined();
    });

    it('the player cannot end up with two places at once; the database error becomes a clear 409', async () => {
      flags['BOOKING_MOVE_PLATFORM_ENABLED'] = 'true';
      const { owner, venue, courts } = await world();
      const player = await makeUser('p');
      const b = await platform(
        venue.id,
        courts[0].id,
        player.row.id,
        futureSlot(0),
      );
      await platform(venue.id, courts[2].id, player.row.id, futureSlot(5));
      const r = await rejection(
        moves.move(owner.auth, b.id, dto(b, courts[1].id, futureSlot(5))),
      );
      expect(r).toEqual({ code: 'USER_TIME_CONFLICT', status: 409 });
    });

    it('is refused while a card checkout is open, split shares are unpaid, or it belongs to a package / series / offer', async () => {
      flags['BOOKING_MOVE_PLATFORM_ENABLED'] = 'true';
      const { owner, venue, courts } = await world();
      const player = await makeUser('p');
      const a = await platform(
        venue.id,
        courts[0].id,
        player.row.id,
        futureSlot(0),
      );
      await prisma.paymentIntent.create({
        data: {
          bookingId: a.id,
          userId: player.row.id,
          provider: 'test',
          amount: a.totalAmount,
          currency: 'EGP',
          status: 'pending',
          expiresAt: new Date(Date.now() + 600_000),
        },
      });
      expect(
        (
          await rejection(
            moves.move(owner.auth, a.id, dto(a, courts[1].id, futureSlot(5))),
          )
        ).code,
      ).toBe('BOOKING_PAYMENT_PENDING');

      const p2 = await makeUser('p');
      const s = await platform(
        venue.id,
        courts[0].id,
        p2.row.id,
        futureSlot(8),
        { isSplitPayment: true, paymentStatus: 'partial' },
      );
      await prisma.bookingSplitShare.create({
        data: {
          bookingId: s.id,
          amount: 21000,
          currency: 'EGP',
          status: 'pending',
        },
      });
      expect(
        (
          await rejection(
            moves.move(owner.auth, s.id, dto(s, courts[1].id, futureSlot(12))),
          )
        ).code,
      ).toBe('BOOKING_SPLIT_PENDING');
    });
  });

  describe('preview', () => {
    it('lists free times on the same unit and free units at the same time, and changes nothing', async () => {
      const { owner, venue, courts } = await world();
      const start = futureSlot(0);
      const b = await manual(venue.id, courts[0].id, owner.row.id, start);
      await manual(venue.id, courts[1].id, owner.row.id, start); // court 2 is busy at the same time
      await manual(
        venue.id,
        courts[0].id,
        owner.row.id,
        new Date(start.getTime() + HOUR),
      ); // the next hour on its own court is busy
      const p = await moves.preview(owner.auth, b.id, {});
      expect(p.canMove).toBe(true);
      expect(p.otherUnits.map((u) => u.courtId)).toEqual([courts[2].id]);
      const same = p.sameUnit.map((u) => u.startsAt);
      expect(same).not.toContain(
        new Date(start.getTime() + HOUR).toISOString(),
      );
      expect(same).not.toContain(start.toISOString());
      expect(same.length).toBeGreaterThan(0);
      expect(p.sameUnit.every((u) => u.ok)).toBe(true);
      const after = await prisma.booking.findUniqueOrThrow({
        where: { id: b.id },
      });
      expect(after.slotStart.toISOString()).toBe(start.toISOString());
      expect(
        await prisma.auditLogEntry.count({ where: { targetId: b.id } }),
      ).toBe(0);
    });

    it('evaluates a chosen target with reasons, and an unusable booking explains why', async () => {
      const { owner, venue, courts } = await world();
      const start = futureSlot(0);
      const b = await manual(venue.id, courts[0].id, owner.row.id, start);
      await manual(venue.id, courts[1].id, owner.row.id, futureSlot(6));
      const busy = await moves.preview(owner.auth, b.id, {
        courtId: courts[1].id,
        startsAt: futureSlot(6).toISOString(),
      });
      expect(busy.target?.ok).toBe(false);
      expect(busy.target?.reasons).toContain('SLOT_ALREADY_HELD');
      const free = await moves.preview(owner.auth, b.id, {
        courtId: courts[1].id,
        startsAt: futureSlot(8).toISOString(),
      });
      expect(free.target?.ok).toBe(true);
      expect(free.target?.price?.modes).toEqual(['keep']);
      const done = await manual(
        venue.id,
        courts[0].id,
        owner.row.id,
        futureSlot(2),
        { checkedInAt: new Date() },
      );
      const p = await moves.preview(owner.auth, done.id, {});
      expect(p).toMatchObject({
        canMove: false,
        blocker: 'BOOKING_CHECKED_IN',
        sameUnit: [],
        otherUnits: [],
      });
    });

    it('rejects malformed input as 400, never 500', async () => {
      const { owner, venue, courts } = await world();
      const b = await manual(
        venue.id,
        courts[0].id,
        owner.row.id,
        futureSlot(0),
      );
      expect(
        (
          await rejection(
            moves.preview(owner.auth, b.id, { date: '2026-13-45' }),
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await rejection(
            moves.preview(owner.auth, b.id, { date: '2026-02-31' }),
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await rejection(
            moves.preview(owner.auth, b.id, { courtId: courts[1].id }),
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await rejection(
            moves.preview(owner.auth, b.id, {
              courtId: courts[1].id,
              startsAt: '2026-13-45T10:00:00Z',
            }),
          )
        ).status,
      ).toBe(400);
      expect(
        (await rejection(moves.preview(owner.auth, randomUUID(), {}))).status,
      ).toBe(404);
    });

    it("a booking of someone else's venue cannot be previewed", async () => {
      const { venue, courts } = await world();
      const stranger = await makeUser('owner', ['owner']);
      const b = await manual(
        venue.id,
        courts[0].id,
        venue.ownerId,
        futureSlot(0),
      );
      expect(
        (await rejection(moves.preview(stranger.auth, b.id, {}))).status,
      ).toBe(403);
    });
  });

  describe('gaming units (minute timing)', () => {
    it('moves a PlayStation booking to another console and refuses a football pitch', async () => {
      const owner = await makeUser('owner', ['owner']);
      const { venue, courts } = await makeVenue(owner.row.id, sportId, 1);
      const ps = await Promise.all(
        [1, 2].map(async (i) => {
          const c = await prisma.court.create({
            data: {
              venueId: venue.id,
              sportId: gamingSportId,
              name: `PS${i}`,
              slotDurationMins: 60,
            },
          });
          await prisma.pricingRule.create({
            data: {
              courtId: c.id,
              label: 'base',
              daysOfWeek: [],
              startTime: '00:00',
              endTime: '24:00',
              priceAmount: 12000,
              currency: 'EGP',
              kind: 'base',
            },
          });
          return c;
        }),
      );
      const start = futureSlot(0);
      const b = await manual(venue.id, ps[0].id, owner.row.id, start, {}, 1.5);
      const target = new Date(start.getTime() + 7 * 60_000 + 3 * HOUR);
      await moves.move(owner.auth, b.id, dto(b, ps[1].id, target));
      const after = await prisma.booking.findUniqueOrThrow({
        where: { id: b.id },
      });
      expect(after.courtId).toBe(ps[1].id);
      expect(after.slotEnd.getTime() - after.slotStart.getTime()).toBe(
        90 * 60_000,
      );
      const fresh = await prisma.booking.findUniqueOrThrow({
        where: { id: b.id },
      });
      expect(
        (
          await rejection(
            moves.move(
              owner.auth,
              b.id,
              dto(fresh, courts[0].id, futureSlot(9)),
            ),
          )
        ).code,
      ).toBe('UNIT_NOT_COMPATIBLE');
    });

    it('a running session on the unit blocks the destination, and the booking stays where it was', async () => {
      const owner = await makeUser('owner', ['owner']);
      const { venue } = await makeVenue(owner.row.id, sportId, 1);
      const ps = await Promise.all(
        [1, 2].map((i) =>
          prisma.court.create({
            data: {
              venueId: venue.id,
              sportId: gamingSportId,
              name: `PS${i}`,
              slotDurationMins: 60,
            },
          }),
        ),
      );
      const start = futureSlot(0);
      const b = await manual(venue.id, ps[0].id, owner.row.id, start);
      // A block on the target console stands in for a running session (both live in ResourceOccupancy).
      await prisma.calendarBlock.create({
        data: {
          venueId: venue.id,
          courtId: ps[1].id,
          kind: 'maintenance',
          startsAt: start,
          endsAt: new Date(start.getTime() + 4 * HOUR),
          createdById: owner.row.id,
        },
      });
      expect(
        (
          await rejection(
            moves.move(
              owner.auth,
              b.id,
              dto(b, ps[1].id, new Date(start.getTime() + HOUR)),
            ),
          )
        ).code,
      ).toBe('SLOT_BLOCKED');
      expect(
        (await prisma.booking.findUniqueOrThrow({ where: { id: b.id } }))
          .courtId,
      ).toBe(ps[0].id);
    });
  });
});
