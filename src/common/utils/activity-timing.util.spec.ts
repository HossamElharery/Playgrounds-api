import { assertActivityDuration } from './activity-timing.util';
import { quoteDurationPrice } from './price-quote.util';
import { manualBookingHash } from '../../modules/owner/offline/offline-policy';
describe('gaming minute booking precision', () => {
  it.each(['gaming-station', 'table-game'])('accepts 1/6/7 minutes for %s', kind => { for (const n of [1,6,7,720]) expect(() => assertActivityDuration(n,kind)).not.toThrow(); });
  it.each(['field-sport','racket-court',null])('preserves sports 15-minute validation for %s', kind => { expect(() => assertActivityDuration(7,kind)).toThrow(); expect(() => assertActivityDuration(30,kind)).not.toThrow(); });
  it.each([0,-1,1.5,721,NaN,Infinity])('rejects invalid gaming duration %s', n => expect(() => assertActivityDuration(n,'gaming-station')).toThrow());
  it('quotes a 7-minute booking at the actual local minute and rounds the entire amount once', () => {
    const rules = [{ daysOfWeek: [], startTime: '00:00', endTime: '23:59', priceAmount: 100, currency: 'EGP', priority: 0 }];
    const start = new Date('2026-10-05T15:07:00Z');
    const quote = quoteDurationPrice(rules,start,7,'Africa/Cairo',true);
    expect(quote.priceAmount).toBe(12); expect(quote.breakdown[0].from).toBe(start.toISOString()); expect(quote.breakdown.reduce((n,s) => n + s.amount,0)).toBe(12);
  });
  it('pricing windows split on the actual minute boundary when starting with seconds', () => {
    const rules = [
      { daysOfWeek: [], startTime: '00:00', endTime: '00:01', priceAmount: 12000, currency: 'EGP', priority: 0 },
      { daysOfWeek: [], startTime: '00:01', endTime: '23:59', priceAmount: 24000, currency: 'EGP', priority: 0 },
    ];
    expect(quoteDurationPrice(rules,new Date('2026-10-05T00:00:30Z'),1,'UTC',true).priceAmount).toBe(300);
  });
  it('Now idempotency ignores the client clock while manual request hashing remains stable', () => {
    const dto = { venueId: 'v1', courtId: 'c1', durationMinutes: 7, priceAmount: 1400, startsAt: '2026-10-05T15:07:30Z' };
    expect(manualBookingHash({ ...dto, startMode: 'now' })).toBe(manualBookingHash({ ...dto, startMode: 'now', startsAt: 'fake-client-clock' }));
    expect(manualBookingHash(dto)).toBe(manualBookingHash({ ...dto, startMode: 'manual' }));
  });
});
