export type KioskVote = 'yes' | 'no';
export type ProposalStatus = 'open' | 'passed' | 'failed' | 'cancelled';

export interface Proposal {
  id: string;
  squadId: string;
  proposerId: string;
  venueId: string;
  venueSlug: string;
  venueName: string;
  venueNameEn?: string;
  venuePhoto?: string;
  courtId: string | null;
  date: string;
  startTime: string;
  durationMin: number;
  priceFrom?: number;
  playersNeeded?: number;
  votes: Record<string, KioskVote>;
  createdAt: number;
  expiresAt: number;
  status: ProposalStatus;
}

export interface NextMatch {
  venueName: string;
  venueSlug: string;
  startsAt: string;
  bookingId?: string;
  bookerId?: string;
}

export interface KioskShortlistItem {
  venueId: string;
  userId: string;
}

export interface KioskPresence {
  userId: string;
  venueId?: string;
  center?: { lat: number; lng: number; zoom: number };
}

export interface KioskSquadState {
  proposal: Proposal | null;
  busy: string[];
  nextMatch: NextMatch | null;
  shortlist: KioskShortlistItem[];
  presence: KioskPresence[];
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
