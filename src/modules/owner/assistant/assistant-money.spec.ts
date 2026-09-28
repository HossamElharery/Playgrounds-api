import { reconcileBookingMoney, toMinor } from './assistant-money';

const EGP = 'EGP';
const stated = (
  total: number | null,
  paid: number | null,
  remaining: number | null,
) => ({
  total: total === null ? null : toMinor(total),
  paid: paid === null ? null : toMinor(paid),
  remaining: remaining === null ? null : toMinor(remaining),
});

describe('reconcileBookingMoney', () => {
  it('records a fully paid booking at the price the owner said', () => {
    const { money, issues } = reconcileBookingMoney(
      stated(400, 400, null),
      toMinor(400),
      EGP,
    );
    expect(money).toEqual({
      total: 40_000,
      paid: 40_000,
      outstanding: 0,
      status: 'paid',
    });
    expect(issues).toEqual([]);
  });

  it('treats a booking with no payment talk as paid at the counter', () => {
    const { money } = reconcileBookingMoney(
      stated(400, null, null),
      toMinor(400),
      EGP,
    );
    expect(money?.status).toBe('paid');
    expect(money?.outstanding).toBe(0);
  });

  it('derives the total from a deposit plus what is still owed', () => {
    const { money } = reconcileBookingMoney(stated(null, 200, 400), null, EGP);
    expect(money).toEqual({
      total: 60_000,
      paid: 20_000,
      outstanding: 40_000,
      status: 'partial',
    });
  });

  it('derives what was paid from the total and the balance', () => {
    const { money } = reconcileBookingMoney(stated(600, null, 400), null, EGP);
    expect(money?.paid).toBe(20_000);
    expect(money?.status).toBe('partial');
  });

  it('refuses three numbers that do not add up, and says where the gap is', () => {
    const { money, issues } = reconcileBookingMoney(
      stated(1200, 200, 400),
      toMinor(1200),
      EGP,
    );
    expect(money).toBeNull();
    expect(issues[0].code).toBe('MATH_MISMATCH');
    expect(issues[0].blocking).toBe(true);
    expect(issues[0].message.ar).toContain('600'); // 200 + 400, the sum that is wrong
    expect(issues[0].message.ar).toContain('1,200');
  });

  it('refuses a payment larger than the whole booking', () => {
    const { money, issues } = reconcileBookingMoney(
      stated(400, 600, null),
      toMinor(400),
      EGP,
    );
    expect(money).toBeNull();
    expect(issues[0].code).toBe('PAID_OVER_TOTAL');
  });

  it('allows a discount but never silently', () => {
    const { money, issues } = reconcileBookingMoney(
      stated(600, 200, 400),
      toMinor(1200),
      EGP,
    );
    expect(money?.total).toBe(60_000);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('PRICE_BELOW_TARIFF');
    expect(issues[0].blocking).toBe(false);
    expect(issues[0].message.ar).toContain('1,200');
    expect(issues[0].message.ar).toContain('600');
  });

  it('flags a price above the tariff too', () => {
    const { issues } = reconcileBookingMoney(
      stated(1500, null, null),
      toMinor(1200),
      EGP,
    );
    expect(issues[0].code).toBe('PRICE_ABOVE_TARIFF');
  });

  it('asks for a price when neither the owner nor the tariff has one', () => {
    const { money, issues } = reconcileBookingMoney(
      stated(null, null, null),
      null,
      EGP,
    );
    expect(money).toBeNull();
    expect(issues[0].code).toBe('NO_PRICE');
  });

  it('falls back to the tariff when the owner only named a balance', () => {
    const { money } = reconcileBookingMoney(
      stated(null, null, 400),
      toMinor(1200),
      EGP,
    );
    expect(money?.total).toBe(120_000);
    expect(money?.paid).toBe(80_000);
    expect(money?.status).toBe('partial');
  });

  it('marks a booking unpaid when nothing was collected', () => {
    const { money } = reconcileBookingMoney(
      stated(400, 0, 400),
      toMinor(400),
      EGP,
    );
    expect(money?.status).toBe('unpaid');
    expect(money?.outstanding).toBe(40_000);
  });

  it('keeps piastre precision on half-pound pricing', () => {
    const { money } = reconcileBookingMoney(
      stated(12.5, null, null),
      null,
      EGP,
    );
    expect(money?.total).toBe(1250);
  });
});
