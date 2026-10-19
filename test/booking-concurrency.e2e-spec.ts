import {
  bookings, disconnect, futureSlot, makeUser, makeVenue, notifications, notifier, prisma, pushes, seedWorld,
} from './helpers/booking-harness';
import { OwnerService } from '../src/modules/owner/owner.service';
import { BookingNoticeReconciler } from '../src/modules/bookings/booking-notice-reconciler.service';

jest.setTimeout(180_000);

const code = (error: unknown) => {
  const body = (error as { getResponse?: () => unknown })?.getResponse?.();
  if (typeof body === 'string') return body;
  return (body as { code?: string; message?: string } | undefined)?.code ?? (body as { message?: string })?.message;
};
const settle = <T>(promises: Array<PromiseLike<T>>) => Promise.allSettled(promises);
const ok = <T>(r: Array<PromiseSettledResult<T>>) => r.filter((x): x is PromiseFulfilledResult<T> => x.status === 'fulfilled');
const failed = (r: Array<PromiseSettledResult<unknown>>) => r.filter((x): x is PromiseRejectedResult => x.status === 'rejected');

describe('booking integrity under concurrency (real Postgres)', () => {
  let sportId: string;

  beforeAll(async () => {
    ({ sportId } = await seedWorld());
  });
  afterAll(disconnect);

  async function world(courts = 2) {
    const owner = await makeUser('owner', ['owner']);
    const { venue, courts: list } = await makeVenue(owner.row.id, sportId, courts);
    return { owner, venue, courts: list };
  }
  const hold = (userId: string, courtId: string, slot: Date, extra: Record<string, unknown> = {}) =>
    bookings.holdSlot(userId, { courtId, slotStart: slot.toISOString(), ...extra });

  describe('database guarantees', () => {
    it('has the exclusion constraints that protect courts and players', async () => {
      const rows = await prisma.$queryRaw<{ conname: string; def: string }[]>`
        SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = '"Booking"'::regclass AND contype = 'x' ORDER BY conname`;
      const names = rows.map((r) => r.conname);
      expect(names).toEqual(expect.arrayContaining(['Booking_court_slot_range_excl', 'Booking_user_slot_range_excl']));
      for (const row of rows) {
        expect(row.def).toContain("status = ANY (ARRAY['held'::\"BookingStatus\", 'confirmed'::\"BookingStatus\"])");
        expect(row.def).toContain('&&');
      }
      const idx = await prisma.$queryRaw<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes WHERE tablename = 'Booking' AND indexname = 'Booking_court_slot_live_unique'`;
      expect(idx).toHaveLength(1);
    });

    it('rejects a booking that starts 30 minutes into another on the same court, even bypassing the app', async () => {
      const { venue, courts } = await world();
      const player = await makeUser('p');
      const other = await makeUser('p');
      const start = futureSlot();
      const row = (userId: string, s: Date, e: Date, status: 'held' | 'confirmed' | 'cancelled' = 'confirmed') => ({
        courtId: courts[0].id, venueId: venue.id, userId, code: `IT-${Math.random().toString(36).slice(2, 10)}`,
        slotStart: s, slotEnd: e, baseAmount: 1, totalAmount: 1, status,
      });
      const hour = 3_600_000;
      await prisma.booking.create({ data: row(player.row.id, start, new Date(start.getTime() + hour)) });
      await expect(
        prisma.booking.create({ data: row(other.row.id, new Date(start.getTime() + hour / 2), new Date(start.getTime() + 1.5 * hour)) }),
      ).rejects.toThrow(/Booking_court_slot_range_excl|23P01/);
      // [start, end) semantics: a booking that starts exactly when the other ends is fine.
      await expect(
        prisma.booking.create({ data: row(other.row.id, new Date(start.getTime() + hour), new Date(start.getTime() + 2 * hour)) }),
      ).resolves.toBeDefined();
      // A cancelled booking blocks nothing.
      await prisma.booking.create({ data: row(other.row.id, start, new Date(start.getTime() + hour), 'cancelled') });
    });

    it('lets a different court take the same time', async () => {
      const { courts } = await world();
      const a = await makeUser('p');
      const b = await makeUser('p');
      const slot = futureSlot(1);
      await expect(hold(a.row.id, courts[0].id, slot)).resolves.toBeDefined();
      await expect(hold(b.row.id, courts[1].id, slot)).resolves.toBeDefined();
    });
  });

  describe('holds', () => {
    it('lets exactly one of ten simultaneous requests for the same court and slot win; the rest get 409 SLOT_ALREADY_HELD', async () => {
      const { courts } = await world(1);
      const players = await Promise.all(Array.from({ length: 10 }, () => makeUser('racer')));
      const slot = futureSlot(2);
      const results = await settle(players.map((p) => hold(p.row.id, courts[0].id, slot)));
      expect(ok(results)).toHaveLength(1);
      const losers = failed(results);
      expect(losers).toHaveLength(9);
      for (const loser of losers) {
        expect((loser.reason as { getStatus(): number }).getStatus()).toBe(409);
        expect(code(loser.reason)).toBe('SLOT_ALREADY_HELD');
      }
      const live = await prisma.booking.count({ where: { courtId: courts[0].id, slotStart: slot, status: { in: ['held', 'confirmed'] } } });
      expect(live).toBe(1);
    });

    it('lets many players hold DIFFERENT free slots at the very same moment (no false "taken")', async () => {
      const { courts } = await world(1);
      const players = await Promise.all(Array.from({ length: 8 }, () => makeUser('p')));
      const results = await settle(players.map((p, i) => hold(p.row.id, courts[0].id, futureSlot(60 + i))));
      expect(failed(results).map((r) => code(r.reason))).toEqual([]);
      expect(ok(results)).toHaveLength(8);
    });

    it('never lets a calendar block and a player hold take the same time (block vs hold race)', async () => {
      const owners = new OwnerService(prisma, bookings, {} as never);
      for (let i = 0; i < 6; i += 1) {
        const { owner, venue, courts } = await world(1);
        const p = await makeUser('p');
        const slot = futureSlot(80 + i);
        const results = await settle<unknown>([
          hold(p.row.id, courts[0].id, slot),
          owners.createCalendarBlock(owner.auth, {
            venueId: venue.id, courtId: courts[0].id, kind: 'maintenance',
            startsAt: slot.toISOString(), endsAt: new Date(slot.getTime() + 3_600_000).toISOString(),
          } as never),
        ]);
        expect(ok(results)).toHaveLength(1); // exactly one of them gets the time
        expect(['SLOT_BLOCKED', 'BLOCK_OVERLAPS_BOOKING']).toContain(code(failed(results)[0].reason));
        const live = await prisma.booking.count({ where: { courtId: courts[0].id, status: { in: ['held', 'confirmed'] } } });
        const blocks = await prisma.calendarBlock.count({ where: { courtId: courts[0].id } });
        expect(live + blocks).toBe(1);
      }
    });

    it('blocks overlapping ranges that start at different times (a 2-hour hold vs a booking at +1h)', async () => {
      const { courts } = await world(1);
      const [a, b] = await Promise.all([makeUser('p'), makeUser('p')]);
      const slot = futureSlot(3);
      const results = await settle([
        hold(a.row.id, courts[0].id, slot, { units: 2 }),
        hold(b.row.id, courts[0].id, futureSlot(4)),
      ]);
      expect(ok(results)).toHaveLength(1);
      expect(code(failed(results)[0].reason)).toBe('SLOT_ALREADY_HELD');
    });

    it('stops one player from holding two overlapping slots at different venues', async () => {
      const [w1, w2, player] = [await world(1), await world(1), await makeUser('p')];
      const slot = futureSlot(5);
      const results = await settle([
        hold(player.row.id, w1.courts[0].id, slot),
        hold(player.row.id, w2.courts[0].id, slot),
      ]);
      expect(ok(results)).toHaveLength(1);
      expect(code(failed(results)[0].reason)).toBe('USER_TIME_CONFLICT');
    });

    it('treats a double-click as one hold: both requests return the same booking', async () => {
      const { courts } = await world(1);
      const player = await makeUser('p');
      const slot = futureSlot(6);
      const results = await settle([hold(player.row.id, courts[0].id, slot), hold(player.row.id, courts[0].id, slot)]);
      expect(failed(results)).toHaveLength(0);
      const ids = new Set(ok(results).map((r) => r.value.id));
      expect(ids.size).toBe(1);
      expect(await prisma.booking.count({ where: { userId: player.row.id } })).toBe(1);
      // and a later retry still returns the same hold
      expect((await hold(player.row.id, courts[0].id, slot)).id).toBe([...ids][0]);
    });

    it('frees an expired hold at once so another player can book without waiting for the sweep', async () => {
      const { courts } = await world(1);
      const [a, b] = await Promise.all([makeUser('p'), makeUser('p')]);
      const slot = futureSlot(7);
      const first = await hold(a.row.id, courts[0].id, slot);
      await prisma.booking.update({ where: { id: first.id }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
      const second = await hold(b.row.id, courts[0].id, slot);
      expect(second.userId).toBe(b.row.id);
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('cancelled');
    });

    it('gives reserved coins back when an expired hold is released', async () => {
      const { courts } = await world(1);
      const [a, b] = await Promise.all([makeUser('p'), makeUser('p')]);
      await prisma.user.update({ where: { id: a.row.id }, data: { coinsBalance: 500 } });
      const slot = futureSlot(8);
      const first = await hold(a.row.id, courts[0].id, slot, { coinsToRedeem: 100 });
      expect(first.coinsRedeemed).toBeGreaterThan(0);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: a.row.id } })).coinsBalance).toBe(500 - first.coinsRedeemed);
      await prisma.booking.update({ where: { id: first.id }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
      await hold(b.row.id, courts[0].id, slot);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: a.row.id } })).coinsBalance).toBe(500);
    });

    it('refuses a suspended player and a past slot with stable codes', async () => {
      const { courts } = await world(1);
      const banned = await makeUser('p');
      await prisma.user.update({ where: { id: banned.row.id }, data: { status: 'suspended' } });
      await expect(hold(banned.row.id, courts[0].id, futureSlot(9))).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'ACCOUNT_RESTRICTED' }),
      });
      const p = await makeUser('p');
      await expect(hold(p.row.id, courts[0].id, new Date(Date.now() - 3_600_000))).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'SLOT_IN_PAST' }),
      });
    });
  });

  describe('confirm, cancel and expiry races', () => {
    it('never both confirms and expires the same hold', async () => {
      for (let i = 0; i < 6; i += 1) {
        const { courts } = await world(1);
        const p = await makeUser('p');
        const held = await hold(p.row.id, courts[0].id, futureSlot(10 + i));
        await prisma.booking.update({ where: { id: held.id }, data: { holdExpiresAt: new Date(Date.now() + 40) } });
        await new Promise((r) => setTimeout(r, 30));
        const [confirm] = await settle<unknown>([
          bookings.confirmBooking(p.row.id, held.id, { paymentMethod: 'cash' }),
          prisma.booking.updateMany({
            where: { id: held.id, status: 'held', holdExpiresAt: { lt: new Date(Date.now() + 25) } },
            data: { status: 'cancelled', holdExpiresAt: null },
          }),
        ]);
        const final = await prisma.booking.findUniqueOrThrow({ where: { id: held.id } });
        expect(['confirmed', 'cancelled']).toContain(final.status);
        if (final.status === 'confirmed') expect(confirm.status).toBe('fulfilled');
        else expect(confirm.status).toBe('rejected');
      }
    });

    it('confirm after the hold ran out fails with 409 HOLD_EXPIRED and releases the slot', async () => {
      const { courts } = await world(1);
      const p = await makeUser('p');
      const held = await hold(p.row.id, courts[0].id, futureSlot(20));
      await prisma.booking.update({ where: { id: held.id }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
      await expect(bookings.confirmBooking(p.row.id, held.id, {})).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'HOLD_EXPIRED' }),
      });
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: held.id } })).status).toBe('cancelled');
    });

    it('cancel racing confirm leaves one consistent outcome and no half-refund', async () => {
      for (let i = 0; i < 6; i += 1) {
        const { courts } = await world(1);
        const p = await makeUser('p');
        const held = await hold(p.row.id, courts[0].id, futureSlot(21 + i));
        const [c, x] = await settle<unknown>([
          bookings.confirmBooking(p.row.id, held.id, { paymentMethod: 'cash' }),
          bookings.cancel(p.row.id, held.id, 'changed my mind'),
        ]);
        const final = await prisma.booking.findUniqueOrThrow({ where: { id: held.id } });
        const refunds = await prisma.payment.count({ where: { bookingId: held.id, status: 'refunded' } });
        expect(refunds).toBe(0); // an at-venue booking was never paid, so nothing is refunded
        if (final.status === 'cancelled') {
          expect(x.status).toBe('fulfilled');
        } else {
          expect(final.status).toBe('confirmed');
          expect(c.status).toBe('fulfilled');
          expect(x.status).toBe('rejected');
        }
        // either way the slot is consistent: at most one live booking holds it
        expect(await prisma.booking.count({ where: { courtId: courts[0].id, status: { in: ['held', 'confirmed'] } } })).toBeLessThanOrEqual(1);
      }
    });

    it('confirming twice (double-submit) confirms once and creates one record of everything', async () => {
      const { courts } = await world(1);
      const p = await makeUser('p');
      const held = await hold(p.row.id, courts[0].id, futureSlot(30));
      const results = await settle([
        bookings.confirmBooking(p.row.id, held.id, { paymentMethod: 'cash' }),
        bookings.confirmBooking(p.row.id, held.id, { paymentMethod: 'cash' }),
      ]);
      expect(ok(results)).toHaveLength(1);
      expect(failed(results)).toHaveLength(1);
    });

    it('refuses to confirm somebody else’s hold', async () => {
      const { courts } = await world(1);
      const [a, b] = await Promise.all([makeUser('p'), makeUser('p')]);
      const held = await hold(a.row.id, courts[0].id, futureSlot(31));
      await expect(bookings.confirmBooking(b.row.id, held.id, {})).rejects.toMatchObject({ status: 403 });
      await expect(bookings.cancel(b.row.id, held.id)).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('the venue changes between Hold and Confirm', () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['hidden by the owner', { ownerListingEnabled: false }, 'VENUE_UNAVAILABLE'],
      ['hidden by the platform', { adminHidden: true }, 'VENUE_UNAVAILABLE'],
      ['suspended by an admin during payment', { status: 'suspended' }, 'VENUE_UNAVAILABLE'],
      ['paused for new bookings', { instantBook: false }, 'VENUE_BOOKING_DISABLED'],
    ];
    it.each(cases)('is refused when the venue is %s, and the hold is released', async (_label, patch, expected) => {
      const { venue, courts } = await world(1);
      const p = await makeUser('p');
      const held = await hold(p.row.id, courts[0].id, futureSlot(40));
      await prisma.venue.update({ where: { id: venue.id }, data: patch });
      await expect(bookings.confirmBooking(p.row.id, held.id, { paymentMethod: 'cash' })).rejects.toMatchObject({
        response: expect.objectContaining({ code: expected }),
      });
      const after = await prisma.booking.findUniqueOrThrow({ where: { id: held.id } });
      expect(after.status).toBe('cancelled');
    });

    it.each(cases)('stops new holds and empties the slot grid when the venue is %s', async (_label, patch, expected) => {
      const { venue, courts } = await world(1);
      await prisma.venue.update({ where: { id: venue.id }, data: patch });
      const p = await makeUser('p');
      await expect(hold(p.row.id, courts[0].id, futureSlot(41))).rejects.toMatchObject({
        response: expect.objectContaining({ code: expected }),
      });
      const day = futureSlot(41).toISOString().slice(0, 10);
      await expect(bookings.getSlotGrid(courts[0].id, day)).resolves.toEqual([]);
    });
  });

  describe('owner notification', () => {
    it('tells the owner once, for the right venue and booking, separately from the player', async () => {
      const { owner, venue, courts } = await world(1);
      const p = await makeUser('p');
      const slot = futureSlot(50);
      const held = await hold(p.row.id, courts[0].id, slot);
      const confirmed = await bookings.confirmBooking(p.row.id, held.id, { paymentMethod: 'cash' });
      // Retries, a replayed job and the reconciler must not add a second one.
      await notifier.notifyVenueSide(confirmed.id, 'booking_confirmed');
      await notifier.notifyVenueSide(confirmed.id, 'booking_confirmed');
      await new BookingNoticeReconciler(prisma, notifier).reconcile(new Date(Date.now() + 120_000));

      const ownerRows = await prisma.notification.findMany({ where: { userId: owner.row.id } });
      expect(ownerRows).toHaveLength(1);
      expect(ownerRows[0]).toMatchObject({
        category: 'bookings',
        dedupKey: `booking-confirmed-owner:${confirmed.id}:${owner.row.id}`,
        deepLink: `/owner/bookings?venue=${venue.id}&booking=${confirmed.id}`,
      });
      expect(ownerRows[0].payload).toMatchObject({
        kind: 'booking_confirmed', bookingId: confirmed.id, venueId: venue.id, courtId: courts[0].id,
        code: confirmed.code, totalAmount: confirmed.totalAmount, currency: 'EGP',
      });
      expect(ownerRows[0].titleEn).toContain(venue.nameEn);
      expect(ownerRows[0].bodyEn).toContain(confirmed.code);
      expect(ownerRows[0].bodyAr).toContain(confirmed.code);

      const playerRows = await prisma.notification.findMany({ where: { userId: p.row.id } });
      expect(playerRows).toHaveLength(1);
      expect(playerRows[0].dedupKey).toBe(`booking-confirmed-player:${confirmed.id}:${p.row.id}`);
      expect(pushes.filter((x) => x.userId === owner.row.id)).toHaveLength(1);
    });

    it('also reaches staff with bookings.view on this venue, and hides money from staff without a finance permission', async () => {
      const { owner, venue, courts } = await world(1);
      const other = await makeVenue(owner.row.id, sportId, 1);
      const mk = async (permissions: string[], venueIds: string[]) => {
        const u = await makeUser('staff', ['staff']);
        await prisma.staffMember.create({ data: { userId: u.row.id, ownerId: owner.row.id, permissions, venueIds, createdById: owner.row.id } });
        return u;
      };
      const desk = await mk(['bookings.view'], [venue.id]);
      const accountant = await mk(['bookings.view', 'account.view'], [venue.id]);
      const elsewhere = await mk(['bookings.view'], [other.venue.id]);
      const noView = await mk(['customers.view'], [venue.id]);
      const p = await makeUser('p');
      const held = await hold(p.row.id, courts[0].id, futureSlot(51));
      const confirmed = await bookings.confirmBooking(p.row.id, held.id, { paymentMethod: 'cash' });

      const payloadOf = async (userId: string) => (await prisma.notification.findMany({ where: { userId } }))[0]?.payload as Record<string, unknown> | undefined;
      expect((await payloadOf(owner.row.id))?.['totalAmount']).toBe(confirmed.totalAmount);
      expect((await payloadOf(accountant.row.id))?.['totalAmount']).toBe(confirmed.totalAmount);
      const deskPayload = await payloadOf(desk.row.id);
      expect(deskPayload?.['bookingId']).toBe(confirmed.id);
      expect(deskPayload).not.toHaveProperty('totalAmount');
      expect((await prisma.notification.findMany({ where: { userId: desk.row.id } }))[0].bodyEn).not.toMatch(/EGP/);
      expect(await payloadOf(elsewhere.row.id)).toBeUndefined();
      expect(await payloadOf(noView.row.id)).toBeUndefined();
    });

    it('names the venue when one owner runs several', async () => {
      const owner = await makeUser('owner', ['owner']);
      const a = await makeVenue(owner.row.id, sportId, 1);
      await makeVenue(owner.row.id, sportId, 1);
      const p = await makeUser('p');
      const held = await hold(p.row.id, a.courts[0].id, futureSlot(52));
      await bookings.confirmBooking(p.row.id, held.id, { paymentMethod: 'cash' });
      const row = (await prisma.notification.findMany({ where: { userId: owner.row.id } }))[0];
      expect(row.titleEn).toContain(a.venue.nameEn);
      expect(row.titleAr).toContain(a.venue.nameAr);
    });

    it('respects the owner’s notification preferences but never blocks the booking', async () => {
      const { owner, courts } = await world(1);
      await prisma.user.update({ where: { id: owner.row.id }, data: { notificationPrefs: { bookings: false } } });
      const p = await makeUser('p');
      const held = await hold(p.row.id, courts[0].id, futureSlot(53));
      await expect(bookings.confirmBooking(p.row.id, held.id, { paymentMethod: 'cash' })).resolves.toMatchObject({ status: 'confirmed' });
      expect(await prisma.notification.count({ where: { userId: owner.row.id } })).toBe(0);
    });

    it('a failing notification service never fails a confirmed booking', async () => {
      const { courts } = await world(1);
      const p = await makeUser('p');
      const held = await hold(p.row.id, courts[0].id, futureSlot(54));
      const boom = jest.spyOn(notifications, 'create').mockRejectedValue(new Error('db blip'));
      notifier.retryDelaysMs = [1, 1, 1];
      try {
        await expect(bookings.confirmBooking(p.row.id, held.id, { paymentMethod: 'cash' })).resolves.toMatchObject({ status: 'confirmed' });
        expect(boom.mock.calls.length).toBeGreaterThanOrEqual(4); // 1 try + 3 retries for the owner notice
      } finally {
        boom.mockRestore();
        notifier.retryDelaysMs = [250, 1_000, 3_000];
      }
    });
  });
});
