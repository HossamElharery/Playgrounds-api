import { pulseStatusFromOccupancy } from './pulse-status.util';

describe('pulseStatusFromOccupancy', () => {
  it('returns open when no active claims remain', () => {
    expect(pulseStatusFromOccupancy(4, 0)).toBe('open');
  });

  it('returns held when the opportunity is partially filled', () => {
    expect(pulseStatusFromOccupancy(4, 2)).toBe('held');
  });

  it('returns full at capacity', () => {
    expect(pulseStatusFromOccupancy(4, 4)).toBe('full');
    expect(pulseStatusFromOccupancy(1, 1)).toBe('full');
  });
});
