import { countedReports, ladder, type LadderSettings, type ReportRow } from './camo-sanctions';

const cfg: LadderSettings = { warnAfterReports: 3, voiceRestrictAfterReports: 5, reportWindowHours: 24, voiceRestrictHours: 24, voiceRestrictRepeatDays: 30, voiceRestrictRepeatHours: 168, hideNameAfterReports: 2 };
const H = 3_600_000;
const NOW = 1_000_000_000_000;
const row = (n: number, over: Partial<ReportRow> = {}): ReportRow => ({ id: `r${n}`, reporterId: `u${n}`, matchId: `m${n}`, partyKey: null, reason: 'voice', createdAt: NOW - n * H, ...over });

describe('camo sanction ladder', () => {
  it('counts distinct reporters from distinct matches inside the window only', () => {
    const rows = [row(1), row(2), row(3, { reporterId: 'u1' }), row(4, { createdAt: NOW - 30 * H })];
    expect(countedReports(rows, NOW, cfg).map((r) => r.id)).toEqual(['r3', 'r2']);
  });

  it('a squad reporting in the same match is one report', () => {
    const rows = [row(1, { matchId: 'm', partyKey: 'sq' }), row(2, { matchId: 'm', partyKey: 'sq' }), row(3, { matchId: 'm', partyKey: 'sq' }), row(4)];
    expect(countedReports(rows, NOW, cfg).length).toBe(2);
  });

  it('3 reports warn, 5 restrict the voice for 24 h and queue an admin review, a repeat is 7 days', () => {
    const c = (n: number) => countedReports(Array.from({ length: n }, (_, i) => row(i + 1)), NOW, cfg);
    expect(ladder(c(2), [], NOW, cfg)).toEqual([{ kind: 'none' }]);
    expect(ladder(c(3), [], NOW, cfg)).toEqual([{ kind: 'warn' }]);
    expect(ladder(c(5), [], NOW, cfg)).toEqual([{ kind: 'voice_restrict', hours: 24, adminReview: true }]);
    expect(ladder(c(5), [NOW - 10 * 86_400_000], NOW, cfg)).toEqual([{ kind: 'voice_restrict', hours: 168, adminReview: true }]);
    expect(ladder(c(5), [NOW - 40 * 86_400_000], NOW, cfg)).toEqual([{ kind: 'voice_restrict', hours: 24, adminReview: true }]);
  });

  it('two counted reports about the name hide it until an admin looks', () => {
    const rows = [row(1, { reason: 'offensive_name' }), row(2, { reason: 'offensive_name' })];
    expect(ladder(countedReports(rows, NOW, cfg), [], NOW, cfg)).toContainEqual({ kind: 'name_hidden' });
  });
});
