import { unpaidReminderSlot } from './unpaid-reminder';

describe('unpaidReminderSlot', () => {
  it('waits three minutes before the first reminder', () => {
    expect(unpaidReminderSlot(0)).toBeNull();
    expect(unpaidReminderSlot(2.9)).toBeNull();
    expect(unpaidReminderSlot(3)).toBe(0);
  });
  it('repeats every five minutes for the first half hour', () => {
    expect(unpaidReminderSlot(7.9)).toBe(0);
    expect(unpaidReminderSlot(8)).toBe(1);
    expect(unpaidReminderSlot(29.9)).toBe(5);
  });
  it('then every half hour', () => {
    expect(unpaidReminderSlot(30)).toBe(6);
    expect(unpaidReminderSlot(59.9)).toBe(6);
    expect(unpaidReminderSlot(60)).toBe(7);
  });
  it('ignores nonsense', () => {
    expect(unpaidReminderSlot(Number.NaN)).toBeNull();
  });
});
