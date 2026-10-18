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
