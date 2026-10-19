import { bookings, disconnect, futureSlot, makeUser, makeVenue, prisma, roomEvents, emitter, seedWorld } from './helpers/booking-harness';
import { SlotChangeRelay, slotsRoom } from '../src/modules/realtime/slot-change-relay.service';

jest.setTimeout(120_000);

describe('live availability (real Postgres)', () => {
  let sportId: string;
  const relay = new SlotChangeRelay(prisma, emitter as never);

  beforeAll(async () => {
    ({ sportId } = await seedWorld());
    await relay.tick(); // sets the cursor: only what happens from now on is news
  });
  afterAll(disconnect);

  async function world(courts = 1) {
    const owner = await makeUser('owner', ['owner']);
    return makeVenue(owner.row.id, sportId, courts).then((w) => ({ owner, ...w }));
  }
  const drain = async () => {
    roomEvents.length = 0;
    await relay.tick();
    return [...roomEvents];
  };
  const forVenue = (events: typeof roomEvents, venueId: string) => events.filter((e) => e.room === slotsRoom(venueId));

  it('announces a hold, a confirmation and a cancellation to players watching that venue', async () => {
    const { venue, courts } = await world();
    const p = await makeUser('p');
    await drain();
    const slot = futureSlot(1);

    const held = await bookings.holdSlot(p.row.id, { courtId: courts[0].id, slotStart: slot.toISOString() });
    let events = forVenue(await drain(), venue.id);
    expect(events).toHaveLength(1);
    expect(events[0].event).toMatchObject({
      type: 'booking.slots.changed', venueId: venue.id, courtId: courts[0].id,
      from: slot.toISOString(), to: new Date(slot.getTime() + 3_600_000).toISOString(),
    });

    await bookings.confirmBooking(p.row.id, held.id, { paymentMethod: 'cash' });
    events = forVenue(await drain(), venue.id);
    expect(events.map((e) => e.event.type)).toEqual(['booking.slots.changed']);

    await bookings.cancel(p.row.id, held.id, 'changed plans');
    events = forVenue(await drain(), venue.id);
    expect(events.map((e) => e.event.type)).toEqual(['booking.slots.changed']);
  });

  it('does not tell watchers of another venue', async () => {
    const a = await world();
    const b = await world();
    const p = await makeUser('p');
    await drain();
    await bookings.holdSlot(p.row.id, { courtId: a.courts[0].id, slotStart: futureSlot(2).toISOString() });
    const events = await drain();
    expect(forVenue(events, a.venue.id)).toHaveLength(1);
    expect(forVenue(events, b.venue.id)).toHaveLength(0);
  });

  it('announces a hold that expired and was swept, so the slot reopens on every screen', async () => {
    const { venue, courts } = await world();
    const p = await makeUser('p');
    const held = await bookings.holdSlot(p.row.id, { courtId: courts[0].id, slotStart: futureSlot(3).toISOString() });
    await drain();
    // what the 10-second expiry job does
    await prisma.booking.update({ where: { id: held.id }, data: { status: 'cancelled', holdExpiresAt: null } });
    expect(forVenue(await drain(), venue.id)).toHaveLength(1);
  });

  it('announces owner-side changes too: a walk-in row and a calendar block', async () => {
    const { owner, venue, courts } = await world();
    const walkIn = await makeUser('guest');
    await drain();
    const start = futureSlot(4);
    await prisma.booking.create({
      data: {
        courtId: courts[0].id, venueId: venue.id, userId: walkIn.row.id, code: `W-${Date.now()}`, slotStart: start,
        slotEnd: new Date(start.getTime() + 3_600_000), baseAmount: 1, totalAmount: 1, status: 'confirmed', source: 'manual',
      },
    });
    expect(forVenue(await drain(), venue.id)).toHaveLength(1);
    await prisma.calendarBlock.create({
      data: { venueId: venue.id, courtId: null, kind: 'maintenance', startsAt: futureSlot(8), endsAt: futureSlot(10), createdById: owner.row.id },
    });
    const events = forVenue(await drain(), venue.id);
    expect(events).toHaveLength(1);
    expect(events[0].event['courtId']).toBeNull();
  });

  it('announces a venue becoming hidden, suspended or paused, once each', async () => {
    const { venue } = await world();
    await drain();
    for (const patch of [{ ownerListingEnabled: false }, { adminHidden: true }, { status: 'suspended' as const }, { instantBook: false }]) {
      await prisma.venue.update({ where: { id: venue.id }, data: patch });
      const events = forVenue(await drain(), venue.id);
      expect(events.map((e) => e.event.type)).toEqual(['venue.visibility.changed']);
    }
    // an edit that changes nothing a player can see is not news
    await prisma.venue.update({ where: { id: venue.id }, data: { contactPhone: '+201000000000' } });
    expect(forVenue(await drain(), venue.id)).toHaveLength(0);
  });

  it('folds a burst into one event per court', async () => {
    const { venue, courts } = await world(2);
    const players = await Promise.all([makeUser('p'), makeUser('p'), makeUser('p')]);
    await drain();
    await Promise.all([
      bookings.holdSlot(players[0].row.id, { courtId: courts[0].id, slotStart: futureSlot(5).toISOString() }),
      bookings.holdSlot(players[1].row.id, { courtId: courts[0].id, slotStart: futureSlot(6).toISOString() }),
      bookings.holdSlot(players[2].row.id, { courtId: courts[1].id, slotStart: futureSlot(5).toISOString() }),
    ]);
    const events = forVenue(await drain(), venue.id);
    expect(events.map((e) => e.event['courtId']).sort()).toEqual([courts[0].id, courts[1].id].sort());
    const c0 = events.find((e) => e.event['courtId'] === courts[0].id)!;
    expect(c0.event['from']).toBe(futureSlot(5).toISOString());
    expect(c0.event['to']).toBe(new Date(futureSlot(6).getTime() + 3_600_000).toISOString());
  });

  it('a failed hold (lost the race) changes nothing and announces nothing', async () => {
    const { venue, courts } = await world();
    const [a, b] = await Promise.all([makeUser('p'), makeUser('p')]);
    const slot = futureSlot(7);
    await bookings.holdSlot(a.row.id, { courtId: courts[0].id, slotStart: slot.toISOString() });
    await drain();
    await expect(bookings.holdSlot(b.row.id, { courtId: courts[0].id, slotStart: slot.toISOString() })).rejects.toBeDefined();
    expect(forVenue(await drain(), venue.id)).toHaveLength(0);
  });
});
