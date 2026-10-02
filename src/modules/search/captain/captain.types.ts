/**
 * Captain — the player-facing assistant.
 *
 * The model only classifies and extracts (what does the player want, with which
 * filters). Every fact in the answer — venues, prices, bookings, FAQ text —
 * comes from the database, and the sentence around it is composed here, so the
 * assistant can be wrong about what was asked but never invent what exists.
 */
export type CaptainIntent =
  | 'find_venues'
  | 'my_bookings'
  | 'faq'
  | 'players'
  | 'chat'
  | 'community'
  | 'tonight'
  | 'help'
  | 'login'
  | 'explore'
  | 'smalltalk'
  | 'unknown';

export const CAPTAIN_INTENTS: CaptainIntent[] = [
  'find_venues',
  'my_bookings',
  'faq',
  'players',
  'chat',
  'community',
  'tonight',
  'help',
  'login',
  'explore',
  'smalltalk',
  'unknown',
];

/** What the player is filtering by. Echoed by the client so a follow-up ("أرخص من كده") builds on it. */
export interface CaptainFilters {
  sport: string | null;
  district: string | null;
  nearMe: boolean;
  cheap: boolean;
  /** Major units (EGP), as the player says them. */
  priceMax: number | null;
  minRating: number | null;
  instantOnly: boolean;
  sort: 'rating' | 'price' | 'distance' | null;
  timeHint: 'now' | 'tonight' | 'tomorrow' | null;
}

export interface CaptainReading extends CaptainFilters {
  intent: CaptainIntent;
  /** The sentence refines the previous search instead of starting a new one. */
  followUp: boolean;
  /** Keywords for a platform question, matched against the real FAQ. */
  topic: string;
  /** Ids of the knowledge entries that answer a platform question (validated against the real list). */
  factIds: string[];
  /** A short friendly line, used only for small talk / when nothing else applies. */
  reply: string;
  /** One short question when something essential is missing. */
  question: string;
  confidence: number;
  /** Which model answered, how long it took and what it cost. Absent when a keyword pass did the reading. */
  meta?: { model: string; ms: number; costUsd: number };
}

export type CaptainCtaKind =
  | 'players'
  | 'chat'
  | 'community'
  | 'tonight'
  | 'bookings'
  | 'help'
  | 'login'
  | 'explore'
  | 'venue'
  | 'path';

export interface CaptainCta {
  kind: CaptainCtaKind;
  label: string;
  /** venue slug for `venue`; an app path without locale for `path`. */
  target?: string;
}

export interface CaptainVenueCard {
  slug: string;
  nameAr: string;
  nameEn: string;
  /** Built from real data about this venue and the request. */
  reason: string;
  priceFrom: { amount: number; currency: string } | null;
  ratingAvg: number | null;
  ratingCount: number;
  districtAr: string | null;
  districtEn: string | null;
  instantBook: boolean;
  hasOffers: boolean;
  photo: string | null;
}

export interface CaptainBookingRef {
  id: string;
  code: string;
  venueSlug: string;
  venueNameAr: string;
  venueNameEn: string;
  courtName: string;
  startsAt: string;
  status: string;
}

export interface CaptainReply {
  mode: 'answer' | 'venues' | 'bookings' | 'clarify' | 'limited' | 'unavailable' | 'challenge';
  intent: CaptainIntent;
  /** Already in the player's language. */
  reply: string;
  venues: CaptainVenueCard[];
  bookings: CaptainBookingRef[];
  cta: CaptainCta | null;
  /** Up to three follow-ups the player can tap; each is a sentence Captain understands. */
  suggestions: string[];
  /** The filters in force, for the client to echo with the next message. */
  context: CaptainFilters | null;
  /** The search relied on "near me" but no coordinates arrived — ask the browser for them. */
  needsLocation: boolean;
  /** Set when the exact request found nothing and this is what was loosened to show results. */
  relaxed: Array<'price' | 'rating' | 'district' | 'instant'>;
  /** A visitor who looks automated must pass a Cloudflare check; the client shows it and sends the same message again with `challengeToken`. */
  needsChallenge?: boolean;
  /** Id of the stored question, so a 👍/👎 can be attached to it. Null when nothing was stored. */
  logId?: string | null;
}
