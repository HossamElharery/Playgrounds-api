import { coalesceSlotChanges, slotsRoom, type SlotChangeRow } from './slot-change-relay.service';

const row = (over: Partial<SlotChangeRow>): SlotChangeRow => ({
  id: 1, venueId: 'v1', courtId: 'c1', startsAt: new Date('2026-10-21T18:00:00Z'), endsAt: new Date('2026-10-21T19:00:00Z'), kind: 'booking', ...over,
});

describe('slot change relay', () => {
  it('folds a burst on one court into one event spanning the whole range', () => {
    const events = coalesceSlotChanges([
      row({ id: 1 }),
      row({ id: 2, startsAt: new Date('2026-10-21T17:00:00Z'), endsAt: new Date('2026-10-21T18:00:00Z') }),
      row({ id: 3, startsAt: new Date('2026-10-21T20:00:00Z'), endsAt: new Date('2026-10-21T21:00:00Z') }),
    ]);
    expect(events).toEqual([
      {
        room: slotsRoom('v1'),
        event: { type: 'booking.slots.changed', venueId: 'v1', courtId: 'c1', from: '2026-10-21T17:00:00.000Z', to: '2026-10-21T21:00:00.000Z' },
      },
    ]);
  });

  it('keeps courts and venues apart so players only hear about the venue they watch', () => {
    const events = coalesceSlotChanges([row({ id: 1 }), row({ id: 2, courtId: 'c2' }), row({ id: 3, venueId: 'v2' })]);
    expect(events.map((e) => [e.room, e.event['courtId']])).toEqual([
      [slotsRoom('v1'), 'c1'],
      [slotsRoom('v1'), 'c2'],
      [slotsRoom('v2'), 'c1'],
    ]);
  });

  it('turns a venue-wide block into a court-less event', () => {
    const [event] = coalesceSlotChanges([row({ courtId: null, kind: 'block' })]);
    expect(event.event).toEqual(jasmineLike({ type: 'booking.slots.changed', courtId: null }));
  });

  it('announces a visibility change once per venue, however many columns changed', () => {
    const events = coalesceSlotChanges([
      row({ id: 1, kind: 'venue', courtId: null, startsAt: null, endsAt: null }),
      row({ id: 2, kind: 'venue', courtId: null, startsAt: null, endsAt: null }),
    ]);
    expect(events).toEqual([{ room: slotsRoom('v1'), event: { type: 'venue.visibility.changed', venueId: 'v1' } }]);
  });

  it('returns nothing for nothing', () => {
    expect(coalesceSlotChanges([])).toEqual([]);
  });
});

function jasmineLike(partial: Record<string, unknown>) {
  return expect.objectContaining(partial);
}
