import { completeReading } from './owner-assistant.service';
import type { AssistantReading } from './assistant.types';

const courts = [
  { id: 'r1', name: 'PS5 Room 1', details: 'ps5' },
  { id: 'vip', name: 'VIP Big-Screen Room', details: 'ps5 vip-big-screen' },
];

const reading = (over: Partial<AssistantReading>): AssistantReading => ({
  intent: 'book',
  courtIds: [],
  allCourts: false,
  date: '2026-09-30',
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
  confidence: 0.8,
  newDate: null,
  newFromMins: null,
  newCourtId: null,
  question: '',
  ...over,
});

describe('completeReading', () => {
  it('finishes a booking whose court was asked for last turn', () => {
    const draft = reading({ fromMins: 540, customerName: 'محمد' });
    const out = completeReading(
      reading({ intent: 'unknown', confidence: 0.1 }),
      draft,
      'PS5 Room 1',
      courts,
    );
    expect(out).toMatchObject({
      intent: 'book',
      courtIds: ['r1'],
      fromMins: 540,
      customerName: 'محمد',
    });
  });

  it('fills blanks from the draft when the model kept the same intent', () => {
    const out = completeReading(
      reading({ courtIds: ['vip'] }),
      reading({ fromMins: 600, durationMinutes: 120 }),
      'الـ VIP',
      courts,
    );
    expect(out).toMatchObject({ courtIds: ['vip'], fromMins: 600, durationMinutes: 120 });
  });

  it('resolves the court from the words when the model returned none', () => {
    const out = completeReading(
      reading({ fromMins: 540 }),
      null,
      'هيحجز بي اس 5 برو 1 الساعة 9:00 صباحا',
      courts,
    );
    expect(out.courtIds).toEqual(['r1']);
  });

  it('does not resurrect a draft for an unrelated message', () => {
    const out = completeReading(
      reading({ intent: 'unknown', confidence: 0.1 }),
      reading({ fromMins: 540 }),
      'شكرا',
      courts,
    );
    expect(out.intent).toBe('unknown');
  });
});
