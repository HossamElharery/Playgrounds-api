import { OwnerAssistantService } from './owner-assistant.service';
import type { AssistantReading } from './assistant.types';

const owner = { id: 'u1', roles: ['owner'] } as never;
const staff = { id: 's1', roles: ['staff'] } as never;
const admin = { id: 'a1', roles: ['admin'] } as never;

const reading = (): AssistantReading =>
  ({
    intent: 'unknown',
    courtIds: [],
    allCourts: false,
    date: '2026-11-10',
    fromMins: null,
    toMins: null,
    durationMinutes: null,
    customerName: '',
    customerPhone: '',
    totalAmount: null,
    paidAmount: null,
    remainingAmount: null,
    paymentMethod: null,
    sourceKey: null,
    expenseCategory: null,
    rangeKey: null,
    reason: '',
    confidence: 0.2,
    newDate: null,
    newFromMins: null,
    newCourtId: null,
    question: '',
    meta: { model: 'google/gemini-3.8-flash', ms: 900, costUsd: 0.004 },
  }) as AssistantReading;

const view = (over: Record<string, unknown> = {}) => ({
  venueId: 'v1',
  enabled: true,
  trial: false,
  source: 'plan',
  allowanceUsd: 4,
  paused: false,
  usedUsd: 0,
  topUpUsd: 0,
  balanceUsd: 4,
  cycleStartedAt: new Date('2026-11-01T00:00:00Z'),
  cycleEndsAt: new Date('2026-12-01T00:00:00Z'),
  roomMicros: 4_000_000,
  ...over,
});

function build(verdict: unknown) {
  const prisma = {
    venue: { findUnique: jest.fn().mockResolvedValue({ id: 'v1', ownerId: 'u1', nameAr: 'نيون', nameEn: 'Neon', currency: 'EGP', country: { timezone: 'Africa/Cairo' } }) },
    court: { findMany: jest.fn().mockResolvedValue([]) },
    booking: { findMany: jest.fn().mockResolvedValue([]) },
    staffMember: { findUnique: jest.fn().mockResolvedValue({ id: 'sm1', ownerId: 'u1', permissions: ['bookings.view'], venueIds: ['v1'], title: null }) },
  };
  const nlu = {
    enabled: true,
    read: jest.fn().mockImplementation(async (_t: unknown, _c: unknown, _d: unknown, _k: unknown, extra: { onCost?: (usd: number) => void }) => {
      extra.onCost?.(0.004);
      return reading();
    }),
  };
  const logs = { logOwnerEvent: jest.fn() };
  const credit = { check: jest.fn().mockResolvedValue(verdict), charge: jest.fn().mockResolvedValue(undefined) };
  const service = new OwnerAssistantService(
    prisma as never, nlu as never, {} as never, {} as never, {} as never,
    undefined, undefined, logs as never, undefined, credit as never,
  );
  return { service, nlu, logs, credit };
}

describe('owner assistant venue credit', () => {
  it('charges the venue the real cost of the call', async () => {
    const v = view();
    const { service, credit } = build({ ok: true, view: v });
    await service.ask(owner, 'v1', 'إيه الأخبار؟');
    expect(credit.check).toHaveBeenCalledWith('v1');
    expect(credit.charge).toHaveBeenCalledWith('v1', v, 0.004);
  });

  it('does not charge the venue for a platform admin looking in', async () => {
    const { service, credit } = build({ ok: true, view: view() });
    await service.ask(admin, 'v1', 'إيه الأخبار؟');
    expect(credit.charge).not.toHaveBeenCalled();
  });

  it('when switched off, refuses the owner before any model call and points to support', async () => {
    const { service, nlu, logs } = build({ ok: false, reason: 'disabled', view: view({ enabled: false }) });
    const plan = await service.ask(owner, 'v1', 'إيه الأخبار؟');
    expect(nlu.read).not.toHaveBeenCalled();
    expect(plan.available).toBe(true);
    expect(plan.reply.en).toContain('switched off');
    expect(plan.reply.en).toContain('contact Matchena support');
    expect(plan.reply.ar).toContain('دعم ماتشنا');
    expect(logs.logOwnerEvent.mock.calls[0][0]).toMatchObject({ outcome: 'limited', detail: 'credit_disabled' });
  });

  it('when switched off, refuses staff the same way and sends them to the owner', async () => {
    const { service, nlu } = build({ ok: false, reason: 'disabled', view: view({ enabled: false }) });
    const plan = await service.ask(staff, 'v1', 'إيه الأخبار؟');
    expect(nlu.read).not.toHaveBeenCalled();
    expect(plan.reply.en).toContain('ask the venue owner');
  });

  it('when the credit is used up, says so plainly (not the silent platform brake) and asks to contact support', async () => {
    const { service, nlu, logs } = build({ ok: false, reason: 'exhausted', view: view({ balanceUsd: 0, usedUsd: 4 }) });
    const plan = await service.ask(owner, 'v1', 'إيه الأخبار؟');
    expect(nlu.read).not.toHaveBeenCalled();
    expect(plan.available).toBe(true);
    expect(plan.reply.en).toContain('credit is used up');
    expect(plan.reply.en).toContain('contact Matchena support');
    expect(plan.reply.en).not.toMatch(/pay now/i);
    expect(plan.reply.en).toContain('renews on 1 December');
    expect(logs.logOwnerEvent.mock.calls[0][0]).toMatchObject({ outcome: 'limited', detail: 'credit_exhausted' });
  });

  it('does not promise a renewal date on a trial', async () => {
    const { service } = build({ ok: false, reason: 'exhausted', view: view({ trial: true, balanceUsd: 0 }) });
    const plan = await service.ask(owner, 'v1', 'إيه الأخبار؟');
    expect(plan.reply.en).not.toContain('renews');
  });
});
