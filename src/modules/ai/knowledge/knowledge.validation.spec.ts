import { KNOWLEDGE } from './default-knowledge';
import { checkKnowledge, isSafeCtaTarget, topicOverlap } from './knowledge.validation';

const good = {
  id: 'new_entry',
  topicAr: 'سؤال جديد عن الحجز',
  topicEn: 'A new question about booking',
  ar: 'إجابة عربية قصيرة.',
  en: 'A short English answer.',
};

describe('checkKnowledge', () => {
  it('accepts every entry of the built-in pack, so seeding can never produce something the editor would refuse', () => {
    for (const e of KNOWLEDGE) {
      const r = checkKnowledge(
        { ...e, ctaTarget: e.cta?.target, ctaLabelAr: e.cta?.labelAr, ctaLabelEn: e.cta?.labelEn, flag: e.when },
        { requireId: true },
      );
      expect({ id: e.id, errors: r.errors }).toEqual({ id: e.id, errors: {} });
    }
  });

  it('needs a lower-case snake_case id, both languages and both topics', () => {
    expect(checkKnowledge({ ...good, id: 'Bad-Id' }, { requireId: true }).errors).toHaveProperty('id', 'invalid_id');
    expect(checkKnowledge({ ...good, id: '1abc' }, { requireId: true }).errors).toHaveProperty('id');
    expect(checkKnowledge({ ...good, en: '' }, { requireId: true }).errors).toHaveProperty('en', 'required');
    expect(checkKnowledge({ ...good, topicAr: '' }, { requireId: true }).errors).toHaveProperty('topicAr', 'required');
  });

  it('rejects a duplicate id', () => {
    const r = checkKnowledge(good, { requireId: true, others: [{ id: 'new_entry', topicAr: 'x', topicEn: 'y' }] });
    expect(r.errors).toHaveProperty('id', 'duplicate_id');
  });

  it('caps each language at 600 characters', () => {
    expect(checkKnowledge({ ...good, ar: 'ا'.repeat(601) }, { requireId: true }).errors).toHaveProperty('ar', 'too_long');
    expect(checkKnowledge({ ...good, ar: 'ا'.repeat(600) }, { requireId: true }).errors).toEqual({});
  });

  it('forbids links and markup in anything shown to a player', () => {
    expect(checkKnowledge({ ...good, en: 'Visit https://example.com now' }, { requireId: true }).errors).toHaveProperty('en', 'no_links');
    expect(checkKnowledge({ ...good, ar: 'اضغط <a href="x">هنا</a>' }, { requireId: true }).errors).toHaveProperty('ar', 'no_links');
    expect(checkKnowledge({ ...good, en: 'Write to support@matchena.com' }, { requireId: true }).errors).toEqual({});
  });

  it('allows only named destinations or safe in-app paths as a button, and needs both labels', () => {
    for (const ok of ['explore', 'help', 'app/bookings', 'partners']) expect(isSafeCtaTarget(ok)).toBe(true);
    for (const bad of ['https://evil.com', '//evil.com', 'javascript:alert(1)', 'mailto:a@b.c', 'a/../b', 'http:evil']) expect(isSafeCtaTarget(bad)).toBe(false);
    const r = checkKnowledge({ ...good, ctaTarget: 'https://evil.com', ctaLabelAr: 'ا', ctaLabelEn: 'a' }, { requireId: true });
    expect(r.errors).toHaveProperty('ctaTarget', 'unsafe_target');
    expect(checkKnowledge({ ...good, ctaTarget: 'explore' }, { requireId: true }).errors).toMatchObject({ ctaLabelAr: 'required', ctaLabelEn: 'required' });
    expect(checkKnowledge({ ...good, ctaTarget: 'explore', ctaLabelAr: 'استكشف', ctaLabelEn: 'Explore' }, { requireId: true }).value?.ctaTarget).toBe('explore');
  });

  it('rejects a feature flag it does not know', () => {
    expect(checkKnowledge({ ...good, flag: 'teleport' }, { requireId: true }).errors).toHaveProperty('flag', 'invalid_flag');
    expect(checkKnowledge({ ...good, flag: 'morphs' }, { requireId: true }).value?.flag).toBe('morphs');
  });

  it('warns — without blocking — about words that promise something', () => {
    const r = checkKnowledge({ ...good, ar: 'الاسترداد مضمون دايمًا.', en: 'Refunds are guaranteed.' }, { requireId: true });
    expect(r.errors).toEqual({});
    expect(r.warnings.filter((w) => w.code === 'promise_word').map((w) => 'field' in w && w.field).sort()).toEqual(['ar', 'en']);
    expect(checkKnowledge(good, { requireId: true }).warnings).toEqual([]);
  });

  it('warns when another entry has a topic the model could not tell apart', () => {
    const r = checkKnowledge(
      { ...good, topicEn: 'Cancellation policy and refund window', topicAr: 'سياسة الإلغاء وميعاد الاسترداد' },
      { requireId: true, others: [{ id: 'cancel_policy', topicAr: 'سياسة الإلغاء وميعاد الإلغاء المجاني', topicEn: 'Cancellation policy and the free-cancellation window' }, { id: 'payment_methods', topicAr: 'طرق الدفع', topicEn: 'Payment methods' }] },
    );
    const overlaps = r.warnings.filter((w) => w.code === 'topic_overlap');
    expect(overlaps.map((w) => ('with' in w ? w.with : ''))).toEqual(['cancel_policy']);
  });
});

describe('topicOverlap', () => {
  it('is 0 for unrelated topics and 1 for the same one', () => {
    expect(topicOverlap('طرق الدفع', 'اللوبي')).toBe(0);
    expect(topicOverlap('Payment methods', 'payment methods')).toBe(1);
  });
});
