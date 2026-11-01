import { cancellationRestriction } from './cancellation-abuse-policy';

describe('cancellationRestriction', () => {
  const now = new Date('2026-11-01T00:00:00.000Z');

  it('warns but does not block after the first or second confirmed cancellation', () => {
    expect(cancellationRestriction(1, 1, now)).toBeNull();
    expect(cancellationRestriction(2, 2, now)).toBeNull();
  });

  it('pauses new bookings for 24 hours on the third cancellation in a day', () => {
    expect(cancellationRestriction(3, 3, now)).toEqual({
      level: 1,
      until: new Date('2026-11-02T00:00:00.000Z'),
    });
  });

  it('escalates a repeated 30-day pattern to seven days', () => {
    expect(cancellationRestriction(3, 5, now)).toEqual({
      level: 2,
      until: new Date('2026-11-08T00:00:00.000Z'),
    });
  });
});
