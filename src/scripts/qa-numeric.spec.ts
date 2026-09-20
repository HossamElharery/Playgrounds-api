import { verifyNumericCases } from '../scripts/qa-numeric-cases';

describe('qa numeric verification (06 §2)', () => {
  it('matches the hand-computed table for scenarios a–g', () => {
    const rows = verifyNumericCases();
    for (const row of rows) {
      expect(row.actual).toEqual(row.expected);
    }
  });
});
