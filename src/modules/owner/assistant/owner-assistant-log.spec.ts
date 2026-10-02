import { OwnerAssistantService } from './owner-assistant.service';
import type { AssistantReading } from './assistant.types';

const user = { id: 'u1', roles: ['owner'] } as never;
const SECRET_TEXT = 'احجز بلايستيشن 1 بكرة 7 لمحمد عبد الرحمن 01012345678 ودفع 450';

const reading = (over: Partial<AssistantReading> = {}): AssistantReading => ({
  intent: 'agenda',
  courtIds: [],
  allCourts: false,
  date: '2026-10-05',
  fromMins: null,
  toMins: null,
  durationMinutes: null,
  customerName: 'محمد عبد الرحمن',
  customerPhone: '01012345678',
  totalAmount: 450,
  paidAmount: 450,
  remainingAmount: null,
  paymentMethod: null,
  sourceKey: null,
  expenseCategory: null,
  rangeKey: null,
  reason: 'محمد عبد الرحمن',
  confidence: 0.9,
  newDate: null,
  newFromMins: null,
  newCourtId: null,
  question: '',
  meta: { model: 'google/gemini-3.8-flash', ms: 1234, costUsd: 0.002 },
  ...over,
});

function build(opts: { read?: AssistantReading | null; quota?: unknown; enabled?: boolean } = {}) {
  const prisma = {
    venue: { findUnique: jest.fn().mockResolvedValue({ id: 'v1', ownerId: 'u1', nameAr: 'نيون', nameEn: 'Neon', priceFromCurrency: 'EGP', country: { timezone: 'Africa/Cairo' } }) },
    court: { findMany: jest.fn().mockResolvedValue([]) },
    booking: { findMany: jest.fn().mockResolvedValue([]) },
    calendarBlock: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const nlu = { enabled: opts.enabled ?? true, read: jest.fn().mockResolvedValue(opts.read === undefined ? reading() : opts.read) };
  const logs = { logOwnerEvent: jest.fn() };
  const summary = { dayAgenda: jest.fn().mockResolvedValue({ items: [] }) };
  const service = new OwnerAssistantService(prisma as never, nlu as never, {} as never, summary as never, {} as never, opts.quota as never, undefined, logs as never);
  return { service, logs };
}

describe('owner assistant telemetry', () => {
  it('records intent, outcome, model, time and cost — and no part of what the owner typed or the customer is called', async () => {
    const { service, logs } = build({ read: reading({ intent: 'unknown', confidence: 0.2 }) });
    await service.ask(user, 'v1', SECRET_TEXT);
    expect(logs.logOwnerEvent).toHaveBeenCalledTimes(1);
    const event = logs.logOwnerEvent.mock.calls[0][0];
    expect(event).toMatchObject({ venueId: 'v1', userId: 'u1', event: 'ask', intent: 'unknown', outcome: 'clarify', model: 'google/gemini-3.8-flash', ms: 1234, costUsd: 0.002 });
    const serialised = JSON.stringify(event);
    for (const secret of ['محمد', '01012345678', '450', 'بلايستيشن', 'احجز']) expect(serialised).not.toContain(secret);
  });

  it('records a refused-by-limit request as limited, without the text', async () => {
    const quota = { take: jest.fn().mockResolvedValue({ ok: false, reason: 'day', retryAfterSec: 100, key: 'user:u1' }) };
    const { service, logs } = build({ quota });
    await service.ask(user, 'v1', SECRET_TEXT);
    expect(logs.logOwnerEvent.mock.calls[0][0]).toMatchObject({ outcome: 'limited' });
    expect(JSON.stringify(logs.logOwnerEvent.mock.calls)).not.toContain('محمد');
  });

  it('records "unavailable" when no model could read the sentence', async () => {
    const { service, logs } = build({ read: null });
    await service.ask(user, 'v1', SECRET_TEXT);
    expect(logs.logOwnerEvent.mock.calls[0][0]).toMatchObject({ outcome: 'unavailable' });
  });

  it('uses the admin-set per-day and per-minute allowance', async () => {
    const quota = { take: jest.fn().mockResolvedValue({ ok: true }) };
    const settings = { number: jest.fn().mockImplementation((k: string) => (k === 'ownerPerDay' ? 123 : 7)) };
    const prisma = { venue: { findUnique: jest.fn().mockResolvedValue({ id: 'v1', ownerId: 'u1', nameAr: 'نيون', priceFromCurrency: 'EGP', country: { timezone: 'Africa/Cairo' } }) }, court: { findMany: jest.fn().mockResolvedValue([]) }, booking: { findMany: jest.fn().mockResolvedValue([]) } };
    const nlu = { enabled: true, read: jest.fn().mockResolvedValue(reading({ intent: 'unknown' })) };
    const service = new OwnerAssistantService(prisma as never, nlu as never, {} as never, {} as never, {} as never, quota as never, settings as never);
    await service.ask(user, 'v1', 'إيه الحجوزات؟');
    expect(quota.take).toHaveBeenCalledWith('owner', [{ key: 'user:u1', perMinute: 7, perDay: 123 }]);
  });
});
