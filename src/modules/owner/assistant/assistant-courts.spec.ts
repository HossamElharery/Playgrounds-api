import { resolveCourtFromText } from './assistant-courts';

const courts = [
  { id: 'r1', name: 'PS5 Room 1', hints: 'ps5 standard' },
  { id: 'r2', name: 'PS5 Room 2', hints: 'ps5 standard' },
  { id: 'vip', name: 'VIP Big-Screen Room', hints: 'ps5 vip-big-screen' },
];

describe('resolveCourtFromText', () => {
  it('matches a spoken console name and number to the venue court', () => {
    expect(resolveCourtFromText('هيحجز بي اس 5 برو 1 الساعة 9:00 صباحا', courts)).toBe('r1');
    expect(resolveCourtFromText('بلايستيشن 5 غرفة 2', courts)).toBe('r2');
  });

  it('matches the exact name, and a bare number as a short answer', () => {
    expect(resolveCourtFromText('PS5 Room 1', courts)).toBe('r1');
    expect(resolveCourtFromText('الغرفة الـ VIP', courts)).toBe('vip');
    expect(resolveCourtFromText('2', courts)).toBe('r2');
  });

  it('does not mistake a clock time or a price for a court number', () => {
    expect(resolveCourtFromText('احجز بكره الساعة 2:00 بـ 400 دفع 200 لمحمد', courts)).toBeNull();
  });

  it('refuses to guess when two courts fit equally well', () => {
    expect(resolveCourtFromText('بلايستيشن 5', courts)).toBeNull();
  });
});
