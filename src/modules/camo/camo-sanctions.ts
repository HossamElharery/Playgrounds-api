/** Section 17a-5: the report ladder as pure numbers, so the thresholds come from the admin settings and are testable. */
export interface LadderSettings {
  warnAfterReports: number;
  voiceRestrictAfterReports: number;
  reportWindowHours: number;
  voiceRestrictHours: number;
  voiceRestrictRepeatDays: number;
  voiceRestrictRepeatHours: number;
  hideNameAfterReports: number;
}

export interface ReportRow {
  id: string;
  reporterId: string | null;
  matchId: string | null;
  /** The reporter's squad/party in that match: a squad reporting in one match is one report. */
  partyKey: string | null;
  reason: string;
  createdAt: number;
}

/** Which reports count: different reporters, different matches (a squad in one match is one), inside the window. */
export function countedReports(rows: ReportRow[], now: number, cfg: LadderSettings): ReportRow[] {
  const from = now - cfg.reportWindowHours * 3_600_000;
  const seenReporter = new Set<string>();
  const seenGroup = new Set<string>();
  const out: ReportRow[] = [];
  for (const r of [...rows].sort((a, b) => a.createdAt - b.createdAt)) {
    if (r.createdAt < from || !r.reporterId) continue;
    if (seenReporter.has(r.reporterId)) continue;
    const group = `${r.matchId ?? 'none'}:${r.partyKey ?? r.reporterId}`;
    if (r.partyKey && seenGroup.has(group)) continue;
    seenReporter.add(r.reporterId);
    if (r.partyKey) seenGroup.add(group);
    out.push(r);
  }
  return out;
}

export type LadderAction =
  | { kind: 'none' }
  | { kind: 'warn' }
  | { kind: 'voice_restrict'; hours: number; adminReview: boolean }
  | { kind: 'name_hidden' };

/** What the automatic ladder does once `counted` reports are in. `priorRestrictAt` are the earlier voice restrictions (ms). */
export function ladder(counted: ReportRow[], priorRestrictAt: number[], now: number, cfg: LadderSettings): LadderAction[] {
  const actions: LadderAction[] = [];
  const nameReports = counted.filter((r) => r.reason === 'offensive_name').length;
  if (nameReports >= cfg.hideNameAfterReports) actions.push({ kind: 'name_hidden' });
  if (counted.length >= cfg.voiceRestrictAfterReports) {
    const repeat = priorRestrictAt.some((t) => now - t < cfg.voiceRestrictRepeatDays * 86_400_000);
    actions.push({ kind: 'voice_restrict', hours: repeat ? cfg.voiceRestrictRepeatHours : cfg.voiceRestrictHours, adminReview: true });
  } else if (counted.length >= cfg.warnAfterReports) actions.push({ kind: 'warn' });
  return actions.length ? actions : [{ kind: 'none' }];
}
