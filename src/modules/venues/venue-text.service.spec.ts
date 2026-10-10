import { VenueTextService } from './venue-text.service';

describe('VenueTextService', () => {
  const ai = (raw: string | Error) => ({ getStructuredIntent: jest.fn(async () => { if (raw instanceof Error) throw raw; return { raw }; }) }) as any;

  it('detects the language the owner wrote in', () => {
    expect(VenueTextService.languageOf('صالة نيون للألعاب')).toBe('ar');
    expect(VenueTextService.languageOf('Neon Arena Lounge')).toBe('en');
    expect(VenueTextService.languageOf('Neon Arena نيون')).toBe('en');
  });

  it('keeps the owner text in its own language and translates into the other', async () => {
    const service = new VenueTextService(ai(JSON.stringify({ translation: 'Neon Gaming Lounge' })));
    expect(await service.both('صالة نيون للألعاب', 'name')).toEqual({ ar: 'صالة نيون للألعاب', en: 'Neon Gaming Lounge' });
    const english = new VenueTextService(ai(JSON.stringify({ translation: 'صالة نيون' })));
    expect(await english.both('Neon Lounge', 'name')).toEqual({ ar: 'صالة نيون', en: 'Neon Lounge' });
  });

  it('shows the original in both languages when no translator answers', async () => {
    for (const service of [new VenueTextService(ai(new Error('down'))), new VenueTextService(ai('not json')), new VenueTextService()]) {
      expect(await service.both('صالة نيون', 'description')).toEqual({ ar: 'صالة نيون', en: 'صالة نيون' });
    }
  });

  it('rejects an absurdly long "translation" and empty input', async () => {
    const service = new VenueTextService(ai(JSON.stringify({ translation: 'x'.repeat(500) })));
    expect(await service.both('نيون', 'name')).toEqual({ ar: 'نيون', en: 'نيون' });
    expect(await service.both('   ', 'name')).toEqual({ ar: '', en: '' });
  });
});
