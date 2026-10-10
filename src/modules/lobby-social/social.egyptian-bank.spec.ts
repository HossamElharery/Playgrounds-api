import { validate } from 'class-validator';
import { SocialQuestionDto } from './social-content.controller';
import { EGYPTIAN_SOCIAL_BANK } from './social.egyptian-bank';

describe('Curated Egyptian bank compatibility', () => {
  it('keeps all authored content valid under the same rules used by the editor', async () => {
    for (const question of EGYPTIAN_SOCIAL_BANK) {
      expect(await validate(Object.assign(new SocialQuestionDto(), question))).toEqual([]);
      expect(question.text).toBe(question.text.trim());
      expect(question.text).toMatch(/[\u0600-\u06ff]/);
      expect(question.text).not.toMatch(/[\u0000-\u001f\u007f]/);
    }
  });
  it('covers seven everyday themes without duplicate question text', () => {
    expect(new Set(EGYPTIAN_SOCIAL_BANK.flatMap(q => q.tags)).size).toBe(7);
    expect(new Set(EGYPTIAN_SOCIAL_BANK.map(q => q.text)).size).toBe(60);
    expect(EGYPTIAN_SOCIAL_BANK.every(q => q.tags.length > 0 && !q.tags.includes('everyday'))).toBe(true);
  });
  it('groups rephrased cross-mode questions into the same non-repeating family', () => {
    const byId = new Map(EGYPTIAN_SOCIAL_BANK.map(q => [q.id, q]));
    expect(byId.get('EG004')!.familyId).toBe(byId.get('EG037')!.familyId);
    expect(byId.get('EG008')!.familyId).toBe(byId.get('EG035')!.familyId);
    expect(new Set(EGYPTIAN_SOCIAL_BANK.map(q => q.familyId)).size).toBe(58);
  });
});
