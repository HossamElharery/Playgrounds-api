import { GeminiNluService } from './gemini-nlu.service';
import { AiProviderService } from '../ai/ai-provider.service';
import { AiContextService } from '../ai/ai-context.service';
import { AiUnavailableError } from '../ai/ai-provider.types';

const courts = [
  { id: 'c1', name: 'Court 1' },
  { id: 'c2', name: 'Court 2' },
];

function serviceWith(raw: string | Error, enabled = true) {
  const aiProvider = {
    enabled,
    getStructuredIntent: jest.fn().mockImplementation(async () => {
      if (raw instanceof Error) throw raw;
      return { raw, provider: 'gemini' };
    }),
  } as unknown as AiProviderService;
  const aiContext = {
    buildPlatformContext: jest.fn().mockResolvedValue('context'),
  } as unknown as AiContextService;
  return { service: new GeminiNluService(aiProvider, aiContext), aiProvider };
}

describe('GeminiNluService', () => {
  it('is disabled when no provider is configured, and never calls the AI layer', async () => {
    const { service, aiProvider } = serviceWith('', false);
    expect(service.enabled).toBe(false);
    const result = await service.interpret('اقفل ملعب 1', courts, '2026-09-11');
    expect(result).toBeNull();
    expect(aiProvider.getStructuredIntent).not.toHaveBeenCalled();
  });

  it('drops a court id the model invented that is not in this venue', async () => {
    const { service } = serviceWith(
      JSON.stringify({
        intent: 'block', courtIds: ['c1', 'someone-elses-court'], allCourts: false,
        date: '2026-09-12', fromMins: 1020, toMins: 1140, reason: 'x', confidence: 0.9,
      }),
    );
    const result = await service.interpret('x', courts, '2026-09-11');
    expect(result?.courtIds).toEqual(['c1']);
  });

  it('discards a contradictory time range instead of guessing', async () => {
    const { service } = serviceWith(
      JSON.stringify({
        intent: 'block', courtIds: ['c1'], allCourts: false, date: '2026-09-12',
        fromMins: 1200, toMins: 600, reason: '', confidence: 0.8,
      }),
    );
    const result = await service.interpret('x', courts, '2026-09-11');
    expect(result?.fromMins).toBe(1200);
    expect(result?.toMins).toBeNull();
  });

  it('clamps an out-of-range confidence and rejects an unknown intent value', async () => {
    const { service } = serviceWith(
      JSON.stringify({
        intent: 'delete_everything', courtIds: [], allCourts: false, date: '2026-09-12',
        fromMins: null, toMins: null, reason: '', confidence: 5,
      }),
    );
    const result = await service.interpret('x', courts, '2026-09-11');
    expect(result?.intent).toBe('unknown');
    expect(result?.confidence).toBe(1);
  });

  it('returns null for a missing/garbled date rather than defaulting silently', async () => {
    const { service } = serviceWith(
      JSON.stringify({
        intent: 'block', courtIds: ['c1'], allCourts: false, date: 'not-a-date',
        fromMins: null, toMins: null, reason: '', confidence: 0.5,
      }),
    );
    const result = await service.interpret('x', courts, '2026-09-11');
    expect(result).toBeNull();
  });

  it('returns null when the model reply is not valid JSON', async () => {
    const { service } = serviceWith('not json at all');
    const result = await service.interpret('x', courts, '2026-09-11');
    expect(result).toBeNull();
  });

  it('never sets allCourts when specific courts were already matched', async () => {
    const { service } = serviceWith(
      JSON.stringify({
        intent: 'block', courtIds: ['c1'], allCourts: true, date: '2026-09-12',
        fromMins: 1020, toMins: 1140, reason: '', confidence: 0.9,
      }),
    );
    const result = await service.interpret('x', courts, '2026-09-11');
    expect(result?.allCourts).toBe(false);
    expect(result?.courtIds).toEqual(['c1']);
  });

  it('returns null (rather than throwing) when every AI provider is unavailable', async () => {
    const { service } = serviceWith(new AiUnavailableError());
    const result = await service.interpret('x', courts, '2026-09-11');
    expect(result).toBeNull();
  });

  it('sends the live platform context alongside the schedule prompt', async () => {
    const { service, aiProvider } = serviceWith(
      JSON.stringify({
        intent: 'free', courtIds: [], allCourts: true, date: '2026-09-11',
        fromMins: null, toMins: null, reason: '', confidence: 0.7,
      }),
    );
    await service.interpret('x', courts, '2026-09-11');
    const call = (aiProvider.getStructuredIntent as jest.Mock).mock.calls[0][0];
    expect(call.systemPrompt).toContain('context');
    expect(call.responseSchema).toBeDefined();
  });

  it('understands a WhatsApp walk-in style book intent in Arabic', async () => {
    const { service } = serviceWith(
      JSON.stringify({
        intent: 'book', courtIds: ['c1'], allCourts: false, date: '2026-09-12',
        fromMins: 1020, toMins: null, durationMinutes: 90, priceAmount: 400,
        sourceKey: 'whatsapp', paid: true, customerName: 'أحمد', reason: '', confidence: 0.9,
      }),
    );
    const result = await service.interpret('احجز لأحمد واتساب ساعة ونص', courts, '2026-09-11');
    expect(result?.intent).toBe('book');
    expect(result?.sourceKey).toBe('whatsapp');
    expect(result?.durationMinutes).toBe(90);
    expect(result?.priceAmount).toBe(400);
    expect(result?.paid).toBe(true);
    expect(result?.customerName).toBe('أحمد');
  });

  it('maps English source words and keeps only venue courts', async () => {
    const { service } = serviceWith(
      JSON.stringify({
        intent: 'book', courtIds: ['c1', 'not-here'], allCourts: false, date: '2026-09-12',
        fromMins: 1080, toMins: null, durationMinutes: 60, priceAmount: 250,
        sourceKey: 'phone', paid: false, customerName: 'Omar', reason: '', confidence: 0.8,
      }),
    );
    const result = await service.interpret('book Omar on the phone for an hour', courts, '2026-09-11');
    expect(result?.courtIds).toEqual(['c1']);
    expect(result?.sourceKey).toBe('phone');
    expect(result?.paid).toBe(false);
  });

  it('does not guess when the unit name is ambiguous', async () => {
    const { service } = serviceWith(
      JSON.stringify({
        intent: 'book', courtIds: [], allCourts: false, date: '2026-09-12',
        fromMins: 1020, toMins: null, durationMinutes: 60, priceAmount: null,
        sourceKey: 'walk_in', paid: true, customerName: 'Sara', reason: 'which court?', confidence: 0.4,
      }),
    );
    const result = await service.interpret('احجز لسارة على الملعب', [
      { id: 'c1', name: 'Court 1' },
      { id: 'c2', name: 'Court 1 indoor' },
    ], '2026-09-11');
    expect(result?.courtIds).toEqual([]);
    expect(result?.allCourts).toBe(false);
  });

  it('strips injection attempts from customerName', async () => {
    const { service } = serviceWith(
      JSON.stringify({
        intent: 'book', courtIds: ['c1'], allCourts: false, date: '2026-09-12',
        fromMins: 1020, toMins: null, durationMinutes: 60, priceAmount: 100,
        sourceKey: 'walk_in', paid: true,
        customerName: `Ahmed'; DROP TABLE Booking; <script>alert(1)</script>`,
        reason: '', confidence: 0.9,
      }),
    );
    const result = await service.interpret('x', courts, '2026-09-11');
    expect(result?.customerName).not.toContain('<');
    expect(result?.customerName).not.toContain(';');
    expect(result?.customerName).not.toContain("'");
    expect(result?.customerName).toContain('Ahmed');
  });
});
