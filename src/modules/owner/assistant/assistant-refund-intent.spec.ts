import { refundIntent } from './assistant-reading';

describe('cancelling a paid booking by voice or text: refund, keep, or ask', () => {
  it.each([
    'الغي حجز محمد ورجّع الفلوس',
    'الغي حجز محمد واسترد المبلغ',
    'cancel Ahmed and refund him',
    'الغي الحجز و رد المبلغ للعميل',
  ])('"%s" hands the money back', (text) => expect(refundIntent(text)).toBe('refund'));

  it.each([
    'الغي حجز محمد واحتفظ بالعربون',
    'الغي الحجز وخليه عربون',
    'cancel it and keep the deposit',
    'الغي الحجز مفيش استرداد',
  ])('"%s" keeps it', (text) => expect(refundIntent(text)).toBe('keep'));

  it.each([
    'الغي حجز محمد',
    'cancel Ahmed',
    // Both words in one sentence is a contradiction, not a decision.
    'رجّع الفلوس واحتفظ بالعربون',
  ])('"%s" is not an answer — the assistant must ask', (text) => expect(refundIntent(text)).toBe('ask'));
});
