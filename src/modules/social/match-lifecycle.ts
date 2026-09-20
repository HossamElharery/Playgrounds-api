/**
 * Kickoff is the hard close. Listings, Pulse rescues and join requests must
 * not treat a MatchPost as live after `dateTime` — the row can sit on `open`
 * until a job catches up, so every read/write path has to consult the clock.
 */
export const LIVE_MATCH_STATUSES = ['open', 'full'] as const;

export function matchHasKickedOff(
  dateTime: Date,
  now = new Date(),
): boolean {
  return dateTime.getTime() <= now.getTime();
}

export function elapsedLiveMatchWhere(now = new Date()) {
  return {
    status: { in: [...LIVE_MATCH_STATUSES] },
    dateTime: { lte: now },
  };
}
