export type SocialGame = 'cards' | 'truth';
export type SocialMode = 'light' | 'stories' | 'closer';
export type SocialChoice = 'truth' | 'fabrication';
export type SocialVote = SocialChoice | 'unsure';
export type SocialPhase = 'preparing' | 'choosing_target' | 'revealing' | 'answering' |
  'secret_choice' | 'storytelling' | 'questions' | 'voting' | 'reveal' | 'discussion' |
  'between_rounds' | 'paused_insufficient_players' | 'no_eligible_content' | 'ended';

export interface SocialMember {
  userId: string;
  role: 'player' | 'listener';
  joinedAt: number;
  eligibleFromRound: number;
  lastSeen: number;
  disconnectedAt?: number | null;
  viewing: boolean;
  turns: number;
  cycleTurns?: number;
  targets: number;
  closerConsent: boolean;
}
export interface SocialQuestion {
  id: string;
  familyId: string;
  version: number;
  mode: SocialMode;
  text: string;
  tags: string[];
  locale: 'ar-EG';
  status: 'draft' | 'published';
  reviewedAt: string | null;
}
export interface SocialOutcome {
  choice: SocialChoice;
  votes: { userId: string; choice: SocialVote | null; result: 'correct' | 'incorrect' | 'abstained' | 'no_response' }[];
  correct: number;
  fooled: number;
  guesses: number;
  abstained: number;
  noResponse: number;
}
/** Stored only on the server. Never serialize this object to a socket. */
export interface SocialState {
  id: string;
  squadId: string;
  game: SocialGame;
  mode: SocialMode;
  phase: SocialPhase;
  revision: number;
  hostId: string | null;
  members: SocialMember[];
  roundId: string | null;
  roundIndex: number;
  actorId: string | null;
  targetId: string | null;
  cardRound?: SocialCardRound;
  lastTargetId: string | null;
  pairs: Record<string, number>;
  usedFamilies: string[];
  question: SocialQuestion | null;
  revealAt: number | null;
  startedAt: number;
  phaseAt: number;
  voteDeadline: number | null;
  originalVoteDeadline: number | null;
  voterIds: string[];
  storyPlayerIds: string[];
  secret: SocialChoice | null;
  votes: Record<string, SocialVote>;
  outcome: SocialOutcome | null;
  replayAllowed: boolean;
  completed: number;
  message: string | null;
  proposedGame: SocialGame | null;
  confirmedIds: string[];
  receipts: { key: string; at: number }[];
  cooldowns: Record<string, number>;
  lastTags: string[];
  reaction: { userId: string; text: string; at: number } | null;
  reactions?: { userId: string; text: string; at: number }[];
  nudgeAt: number | null;
  exposedUsers?: string[];
}
export interface SocialCardRound {
  order: string[];
  responses: Record<string, 'answered' | 'passed'>;
}
export interface SocialSnapshot {
  enabled: boolean;
  serverNow: number;
  squadId: string;
  session: null | {
    id: string; game: SocialGame; mode: SocialMode; phase: SocialPhase; revision: number;
    hostId: string | null; roundId: string | null; roundIndex: number;
    actorId: string | null; targetId: string | null;
    cardRound?: SocialCardRound;
    members: { userId: string; role: 'player' | 'listener'; connected: boolean; waiting: boolean }[];
    question: Pick<SocialQuestion, 'id' | 'text' | 'mode'> | null;
    revealAt: number | null; voteDeadline: number | null; phaseAt: number;
    voterIds: string[]; submittedIds: string[]; outcome: SocialOutcome | null;
    completed: number; message: string | null; proposedGame: SocialGame | null; confirmedIds: string[];
    reaction: SocialState['reaction']; reactions?: NonNullable<SocialState['reactions']>; nudgeAt: number | null; cycleComplete: boolean;
  };
  personal: { choice: SocialChoice | null; vote: SocialVote | null; allowed: string[]; targetIds: string[] };
}
export interface SocialCommand {
  squadId: string;
  sessionId?: string;
  expectedVersion?: number;
  requestId: string;
  action: string;
  game?: SocialGame;
  mode?: SocialMode;
  targetId?: string;
  choice?: SocialVote;
  role?: 'player' | 'listener';
  consent?: boolean;
  replayAllowed?: boolean;
  text?: string;
  viewing?: boolean;
  roundId?: string;
  questionId?: string;
}
export interface Exposure { userId: string; familyId: string; count: number }
