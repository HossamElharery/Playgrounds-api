export interface PublicActivity {
  matchesPlayed: number;
  mvps: number;
  reputation: number;
  reliabilityPct: number;
  streakCount: number;
  badgeCount: number;
  avgElo: number;
}

/** Mirrors PROJECT_BLUEPRINT §15.11 — public XP from activity, never from coins. */
export function computeXp(p: PublicActivity): number {
  return (
    p.matchesPlayed * 40 +
    p.mvps * 150 +
    p.reputation * 6 +
    p.reliabilityPct * 2 +
    p.streakCount * 15 +
    p.badgeCount * 120 +
    Math.max(0, p.avgElo - 1000) / 2
  );
}

export function playerLevel(xp: number): { level: number; xp: number } {
  return { level: Math.min(50, Math.floor(xp / 250) + 1), xp };
}
