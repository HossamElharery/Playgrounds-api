import { AssistantNluService } from './assistant-nlu.service';

const courts = [
  { id: 'c1', name: 'ملعب 1' },
  { id: 'c2', name: 'ملعب 2' },
];

function serviceReturning(payload: Record<string, unknown>) {
  const provider = {
    enabled: true,
    getStructuredIntent: jest
      .fn()
      .mockResolvedValue({ raw: JSON.stringify(payload), provider: 'gemini' }),
  };
  const context = { buildPlatformContext: jest.fn().mockResolvedValue('') };
  return {
    service: new AssistantNluService(provider as never, context as never),
    provider,
  };
}

const base = {
  intent: 'book',
  courtIds: ['c1'],
  allCourts: false,
  date: '2026-09-29',
  reason: '',
  confidence: 0.9,
};

describe('AssistantNluService', () => {
  it('passes a well-formed reading through', async () => {
    const { service } = serviceReturning({
      ...base,
      fromMins: 780,
      toMins: 900,
      durationMinutes: 120,
      customerName: 'محمد',
      totalAmount: 400,
      paidAmount: 200,
      remainingAmount: 200,
      sourceKey: 'whatsapp',
      paymentMethod: 'cash',
    });
    const reading = await service.read('...', courts, '2026-09-28');
    expect(reading).toMatchObject({
      intent: 'book',
      courtIds: ['c1'],
      customerName: 'محمد',
      totalAmount: 400,
      paidAmount: 200,
      remainingAmount: 200,
      sourceKey: 'whatsapp',
    });
  });

  it('drops court ids the venue does not own', async () => {
    const { service } = serviceReturning({
      ...base,
      courtIds: ['c1', 'not-mine'],
    });
    expect((await service.read('...', courts, '2026-09-28'))?.courtIds).toEqual(
      ['c1'],
    );
  });

  it('refuses to invent a court when the model names none it recognises', async () => {
    const { service } = serviceReturning({
      ...base,
      courtIds: ['ghost'],
      allCourts: false,
    });
    expect((await service.read('...', courts, '2026-09-28'))?.courtIds).toEqual(
      [],
    );
  });

  it('strips anything but a name out of the customer field', async () => {
    const { service } = serviceReturning({
      ...base,
      customerName: "محمد'; DROP TABLE <b>",
    });
    expect(
      (await service.read('...', courts, '2026-09-28'))?.customerName,
    ).toBe('محمد DROP TABLE b');
  });

  it('rejects impossible amounts instead of writing them', async () => {
    const { service } = serviceReturning({
      ...base,
      totalAmount: -50,
      paidAmount: 99_999_999,
    });
    const reading = await service.read('...', courts, '2026-09-28');
    expect(reading?.totalAmount).toBeNull();
    expect(reading?.paidAmount).toBeNull();
  });

  it('keeps piastres on a half-pound price', async () => {
    const { service } = serviceReturning({ ...base, totalAmount: 12.5 });
    expect((await service.read('...', courts, '2026-09-28'))?.totalAmount).toBe(
      12.5,
    );
  });

  it('drops a backwards time range rather than guessing which end is wrong', async () => {
    const { service } = serviceReturning({
      ...base,
      fromMins: 1080,
      toMins: 600,
    });
    const reading = await service.read('...', courts, '2026-09-28');
    expect(reading?.fromMins).toBe(1080);
    expect(reading?.toMins).toBeNull();
  });

  it('falls back to today when the model returns an unusable date', async () => {
    const { service } = serviceReturning({ ...base, date: 'بكرة' });
    expect((await service.read('...', courts, '2026-09-28'))?.date).toBe(
      '2026-09-28',
    );
  });

  it('downgrades an intent it does not know to unknown', async () => {
    const { service } = serviceReturning({
      ...base,
      intent: 'delete_everything',
    });
    expect((await service.read('...', courts, '2026-09-28'))?.intent).toBe(
      'unknown',
    );
  });

  it('ignores an enum value outside the catalogue', async () => {
    const { service } = serviceReturning({
      ...base,
      sourceKey: 'telepathy',
      expenseCategory: 'bribes',
    });
    const reading = await service.read('...', courts, '2026-09-28');
    expect(reading?.sourceKey).toBeNull();
    expect(reading?.expenseCategory).toBeNull();
  });

  it('returns null when the model does not answer with JSON', async () => {
    const { service } = serviceReturning({});
    (
      service as never as { aiProvider: { getStructuredIntent: jest.Mock } }
    ).aiProvider = {
      getStructuredIntent: jest
        .fn()
        .mockResolvedValue({ raw: 'not json', provider: 'gemini' }),
    } as never;
    expect(await service.read('...', courts, '2026-09-28')).toBeNull();
  });

  it("sends the day's open balances so a bare first name can be resolved", async () => {
    const { service, provider } = serviceReturning(base);
    await service.read('محمد دفع الباقي', courts, '2026-09-28', [
      { name: 'محمد', courtName: 'ملعب 1', time: '19:00', outstanding: 200 },
    ]);
    const [request] = provider.getStructuredIntent.mock.calls[0] as [
      { userPrompt: string },
    ];
    expect(request.userPrompt).toContain('محمد');
  });
});
