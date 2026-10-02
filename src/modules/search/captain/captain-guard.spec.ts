import { screenMessage } from './captain-guard';

describe('screenMessage', () => {
  it('lets a real sentence through, in Arabic or English', () => {
    expect(screenMessage('عايز ملعب بادل في المعادي').ok).toBe(true);
    expect(screenMessage('padel in maadi').ok).toBe(true);
    expect(screenMessage('حجز 5').ok).toBe(true);
  });

  it('refuses an empty or one-character message', () => {
    expect(screenMessage('  ')).toEqual({ ok: false, reason: 'empty' });
    expect(screenMessage('a')).toEqual({ ok: false, reason: 'empty' });
  });

  it('refuses messages with no letters at all', () => {
    expect(screenMessage('12345678')).toEqual({ ok: false, reason: 'noise' });
    expect(screenMessage('?!?! 😂😂')).toEqual({ ok: false, reason: 'noise' });
  });

  it('refuses one character repeated to fill the message', () => {
    expect(screenMessage('aaaaaaaaaaaaaa').ok).toBe(false);
    expect(screenMessage('هههههههههههههه').ok).toBe(false);
    expect(screenMessage('ههههه عايز بادل').ok).toBe(true);
  });

  it('refuses link spam but not a single link', () => {
    expect(screenMessage('بص http://a.co و http://b.co').ok).toBe(false);
    expect(screenMessage('بص http://a.co').ok).toBe(true);
  });

  it('refuses the same message a third time in a row', () => {
    expect(screenMessage('بادل', ['بادل', 'بادل']).ok).toBe(false);
    expect(screenMessage('بادل', ['بادل', 'كورة']).ok).toBe(true);
    expect(screenMessage('بادل', ['بادل']).ok).toBe(true);
  });
});
