import { AiSettingsService, validateSettingsPatch } from './ai-settings.service';

const config = (env: Record<string, string> = {}) => ({ get: (k: string) => env[k] }) as never;

describe('validateSettingsPatch', () => {
  it('accepts values inside their bounds and null (back to default)', () => {
    expect(validateSettingsPatch({ captainGuestPerDay: 20, publicBudgetUsd: 2.5, captainGuestsEnabled: false, ownerPerDay: null })).toEqual({});
  });

  it('refuses unknown keys, wrong types, fractions of whole numbers and out-of-range values', () => {
    const errors = validateSettingsPatch({
      nope: 1,
      captainGuestPerDay: 1.5,
      captainUserPerDay: 0,
      ownerPerMinute: 9999,
      publicBudgetUsd: 'lots',
      captainGuestsEnabled: 'yes',
      questionRetentionDays: 10,
    });
    expect(Object.keys(errors).sort()).toEqual(['captainGuestPerDay', 'captainGuestsEnabled', 'captainUserPerDay', 'nope', 'ownerPerMinute', 'publicBudgetUsd', 'questionRetentionDays']);
  });

  it('allows zero guest messages (that is how visitors are turned off for a day) but never zero budget', () => {
    expect(validateSettingsPatch({ captainGuestPerDay: 0 })).toEqual({});
    expect(validateSettingsPatch({ ownerBudgetUsd: 0 })).toHaveProperty('ownerBudgetUsd');
  });
});

describe('AiSettingsService', () => {
  it('reads default, then environment, then the admin override, in that order', async () => {
    const rows: { key: string; value: unknown }[] = [];
    const prisma = { aiSetting: { findMany: jest.fn().mockImplementation(async () => rows) } };
    const s = new AiSettingsService(config({ CAPTAIN_GUEST_PER_DAY: '9' }), prisma as never);
    await s.refresh();
    expect(s.number('captainGuestPerMinute')).toBe(5); // default
    expect(s.number('captainGuestPerDay')).toBe(9); // env
    rows.push({ key: 'captainGuestPerDay', value: 30 });
    await s.refresh();
    expect(s.number('captainGuestPerDay')).toBe(30); // override wins
    expect(s.describe().find((x) => x.key === 'captainGuestPerDay')).toMatchObject({ source: 'override', value: 30 });
    expect(s.number('captainGuestIpPerDay')).toBeNull(); // derived by the caller
  });

  it('ignores a stored value of the wrong type instead of trusting it', async () => {
    const prisma = { aiSetting: { findMany: jest.fn().mockResolvedValue([{ key: 'captainGuestPerDay', value: 'oops' }, { key: 'removed_setting', value: 1 }]) } };
    const s = new AiSettingsService(config(), prisma as never);
    await s.refresh();
    expect(s.number('captainGuestPerDay')).toBe(15);
  });

  it('keeps the last known values when the table cannot be read', async () => {
    const findMany = jest.fn().mockResolvedValueOnce([{ key: 'ownerPerDay', value: 700 }]).mockRejectedValue(new Error('db down'));
    const s = new AiSettingsService(config(), { aiSetting: { findMany } } as never);
    await s.refresh();
    await s.refresh();
    expect(s.number('ownerPerDay')).toBe(700);
  });

  it('works with no database at all', () => {
    const s = new AiSettingsService(config({ AI_PUBLIC_DAILY_BUDGET_USD: '3' }));
    expect(s.number('publicBudgetUsd')).toBe(3);
    expect(s.flag('captainGuestsEnabled')).toBe(true);
  });
});
