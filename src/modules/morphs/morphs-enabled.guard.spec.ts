import { MorphsEnabledGuard } from './morphs-enabled.guard';
import { lobbyMorphsEnabled } from './morphs-flag';

const config = (v?: string): any => ({ get: () => v });

describe('Lobby Morphs feature flag', () => {
  it('is on only for exactly "true"', () => {
    expect(lobbyMorphsEnabled(config('true'))).toBe(true);
    expect(lobbyMorphsEnabled(config(' true '))).toBe(true);
    for (const v of [undefined, '', 'false', 'TRUE', '1', 'yes']) {
      expect(lobbyMorphsEnabled(config(v))).toBe(false);
    }
  });

  it('guard 404s with MORPHS_DISABLED while off', () => {
    const err: any = (() => {
      try {
        new MorphsEnabledGuard(config(undefined)).canActivate();
      } catch (e) {
        return e;
      }
    })();
    expect(err.getStatus()).toBe(404);
    expect(err.getResponse().code).toBe('MORPHS_DISABLED');
  });

  it('guard passes while on', () => {
    expect(new MorphsEnabledGuard(config('true')).canActivate()).toBe(true);
  });
});
