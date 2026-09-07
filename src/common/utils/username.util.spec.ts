import { isValidUsername, normalizeUsername } from './username.util';

describe('username', () => {
  it('normalizes case and validates the blueprint pattern', () => {
    expect(normalizeUsername('ElMalek')).toBe('elmalek');
    expect(isValidUsername('elmalek')).toBe(true);
    expect(isValidUsername('1bad')).toBe(false);
    expect(isValidUsername('ab')).toBe(false);
  });
});
