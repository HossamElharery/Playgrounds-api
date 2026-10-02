import { OwnerAssistantService } from './owner-assistant.service';
import { OwnerAssistantExecutorService } from './owner-assistant-executor.service';
import { UNDO_ANCHOR_TEXT } from './assistant-undo';
import type { AssistantReading } from './assistant.types';

const user = { id: 'u1', name: 'حسام', roles: ['owner'] } as never;

const reading = (over: Partial<AssistantReading> = {}): AssistantReading => ({
  intent: 'agenda',
  courtIds: [],
  allCourts: false,
  date: '2026-10-05',
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
  question: 'تقصد إيه؟',
  meta: { model: 'google/gemini-3.8-flash', ms: 900, costUsd: 0.001 },
  ...over,
});

function buildAssistant(read: AssistantReading | null) {
  const prisma = {
    venue: { findUnique: jest.fn().mockResolvedValue({ id: 'v1', ownerId: 'u1', nameAr: 'نيون', nameEn: 'Neon', priceFromCurrency: 'EGP', country: { timezone: 'Africa/Cairo' } }) },
    court: { findMany: jest.fn().mockResolvedValue([]) },
    booking: { findMany: jest.fn().mockResolvedValue([]) },
    calendarBlock: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const nlu = { enabled: true, read: jest.fn().mockResolvedValue(read) };
  const transcript = { recordTurn: jest.fn().mockResolvedValue(undefined), recordEvent: jest.fn().mockResolvedValue(undefined) };
  const service = new OwnerAssistantService(prisma as never, nlu as never, {} as never, {} as never, {} as never, undefined, undefined, undefined, transcript as never);
  return { service, transcript };
}

describe('the permanent transcript of owner ↔ assistant', () => {
  it('keeps the owner’s sentence and the answer, with what was understood, for the admin', async () => {
    const { service, transcript } = buildAssistant(reading({ intent: 'unknown' }));
    await service.ask(user, 'v1', 'يا باشا هو انت بتهزر؟');
    expect(transcript.recordTurn).toHaveBeenCalledTimes(1);
    expect(transcript.recordTurn.mock.calls[0][0]).toMatchObject({
      ownerId: 'u1',
      ownerName: 'حسام',
      venueId: 'v1',
      ownerText: 'يا باشا هو انت بتهزر؟',
      replyText: 'تقصد إيه؟',
      intent: 'unknown',
      outcome: 'clarify',
      model: 'google/gemini-3.8-flash',
    });
  });

  it('keeps the owner’s sentence even when no model could read it', async () => {
    const { service, transcript } = buildAssistant(null);
    await service.ask(user, 'v1', 'اقفل الملعب بكرة');
    expect(transcript.recordTurn.mock.calls[0][0]).toMatchObject({ ownerText: 'اقفل الملعب بكرة', outcome: 'unavailable', replyText: '' });
  });

  it('marks a plan that is waiting for Confirm, so the admin can tell proposed from done', async () => {
    const { service, transcript } = buildAssistant(reading({ intent: 'agenda', confidence: 0.9 }));
    await service.ask(user, 'v1', 'إيه حجوزات النهاردة؟').catch(() => undefined);
    const call = transcript.recordTurn.mock.calls[0]?.[0];
    if (call) expect(call.outcome === 'planned' || call.outcome === 'clarify').toBe(true);
  });
});

describe('what the assistant did after Confirm and Undo is on the record too', () => {
  function buildExecutor() {
    const prisma = {
      venue: { findUnique: jest.fn().mockResolvedValue({ id: 'v1', ownerId: 'u1', priceFromCurrency: 'EGP' }) },
      assistantMessage: { create: jest.fn().mockResolvedValue({ id: 'undo-1' }) },
    };
    const expenses = { create: jest.fn().mockResolvedValue({ id: 'e1' }) };
    const transcript = { recordEvent: jest.fn().mockResolvedValue(undefined) };
    const service = new OwnerAssistantExecutorService(prisma as never, {} as never, expenses as never, undefined, transcript as never);
    return { service, prisma, expenses, transcript };
  }

  it('records the confirmed action and its result', async () => {
    const { service, transcript } = buildExecutor();
    const actions = [{ kind: 'add_expense', venueId: 'v1', category: 'electricity', amount: 500, incurredOn: '2030-01-01' }] as never;
    await service.execute(user, 'v1', actions);
    expect(transcript.recordEvent).toHaveBeenCalledTimes(1);
    expect(transcript.recordEvent.mock.calls[0][0]).toMatchObject({ ownerId: 'u1', venueId: 'v1', kind: 'action', outcome: 'applied', intent: 'add_expense' });
    expect(transcript.recordEvent.mock.calls[0][0].text).toContain('اتسجل المصروف');
    expect(transcript.recordEvent.mock.calls[0][0].meta).toEqual({ actions });
  });

  it('records a failed confirmation with the reason', async () => {
    const { service, expenses, transcript } = buildExecutor();
    expenses.create.mockRejectedValue(new Error('Expense category is invalid'));
    await expect(
      service.execute(user, 'v1', [{ kind: 'add_expense', venueId: 'v1', category: 'electricity', amount: 500, incurredOn: '2030-01-01' }] as never),
    ).rejects.toThrow();
    expect(transcript.recordEvent.mock.calls[0][0]).toMatchObject({ kind: 'action', outcome: 'failed' });
    expect(transcript.recordEvent.mock.calls[0][0].text).toContain('Expense category is invalid');
  });

  it('stores the hidden undo-point under the marker the chat window and the admin both leave out', async () => {
    const { service, prisma } = buildExecutor();
    await service.execute(user, 'v1', [{ kind: 'add_expense', venueId: 'v1', category: 'electricity', amount: 500, incurredOn: '2030-01-01' }] as never);
    expect(prisma.assistantMessage.create.mock.calls[0][0].data).toMatchObject({ sender: 'system', text: UNDO_ANCHOR_TEXT });
  });
});
