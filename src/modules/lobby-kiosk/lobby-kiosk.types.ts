export type KioskVote = 'yes' | 'no';
export type ProposalStatus = 'open' | 'passed' | 'failed' | 'cancelled';

export interface Proposal {
  id: string;
  squadId: string;
  proposerId: string;
  venueId: string;
  venueSlug: string;
  /** Arabic name (the lobby's first language). */
  venueName: string;
  venueNameEn?: string;
  venuePhoto?: string;
  courtId: string | null;
  /** YYYY-MM-DD in Africa/Cairo. */
  date: string;
  /** HH:mm in Africa/Cairo. */
  startTime: string;
  durationMin: number;
  priceFrom?: number;
  /** Display-only: how many players the sport wants (for example 5v5 → 10). */
  playersNeeded?: number;
  votes: Record<string, KioskVote>;
  createdAt: number;
  expiresAt: number;
  status: ProposalStatus;
}

export interface NextMatch {
  venueName: string;
  venueSlug: string;
  /** ISO start instant. */
  startsAt: string;
  bookingId?: string;
  /** The player who confirmed the booking. */
  bookerId?: string;
}

export interface KioskSquadState {
  proposal: Proposal | null;
  busy: string[];
  nextMatch: NextMatch | null;
}

export interface ProposeInput {
  squadId: string;
  venueId: string;
  courtId?: string | null;
  date: string;
  startTime: string;
  durationMin: number;
  priceFrom?: number;
  playersNeeded?: number;
}

/** yes × 2 > members, or the leader voted yes, passes. no × 2 ≥ members fails. */
export function judgeProposal(
  yes: number,
  no: number,
  members: number,
  leaderYes: boolean,
): 'passed' | 'failed' | 'open' {
  if (members <= 0) return 'open';
  if (yes * 2 > members || leaderYes) return 'passed';
  if (no * 2 >= members) return 'failed';
  return 'open';
}
