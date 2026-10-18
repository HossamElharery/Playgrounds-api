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

export interface CaptainFilters {
  sport: string | null;
  district: string | null;
  nearMe: boolean;
  cheap: boolean;
  priceMax: number | null;
  minRating: number | null;
  instantOnly: boolean;
  sort: 'rating' | 'price' | 'distance' | null;
  timeHint: 'now' | 'tonight' | 'tomorrow' | null;
}

export interface CaptainReading extends CaptainFilters {
  intent: CaptainIntent;
  followUp: boolean;
  topic: string;
  factIds: string[];
  reply: string;
  question: string;
  confidence: number;
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
  target?: string;
}

export interface CaptainVenueCard {
  slug: string;
  nameAr: string;
  nameEn: string;
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
  reply: string;
  venues: CaptainVenueCard[];
  bookings: CaptainBookingRef[];
  cta: CaptainCta | null;
  suggestions: string[];
  context: CaptainFilters | null;
  needsLocation: boolean;
  relaxed: Array<'price' | 'rating' | 'district' | 'instant'>;
  needsChallenge?: boolean;
  logId?: string | null;
}
