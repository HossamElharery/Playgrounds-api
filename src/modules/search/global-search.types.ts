export interface GlobalSearchVenueHit {
  kind: 'venue';
  id: string;
  slug: string;
  nameAr: string;
  nameEn: string;
  districtAr: string | null;
  districtEn: string | null;
  photo: string | null;
  ratingAvg: number;
  instantBook: boolean;
}

export interface GlobalSearchPlayerHit {
  kind: 'player';
  id: string;
  name: string;
  avatarUrl: string | null;
  reputation: number;
  matchesPlayed: number;
}

export interface GlobalSearchTeamHit {
  kind: 'team';
  id: string;
  name: string;
  logoUrl: string | null;
  sportAr: string | null;
  sportEn: string | null;
  memberCount: number;
}

export interface GlobalSearchMatchHit {
  kind: 'match';
  id: string;
  notes: string | null;
  sportAr: string;
  sportEn: string;
  districtAr: string | null;
  districtEn: string | null;
  dateTime: string;
  status: string;
  playersNeeded: number;
}

export interface GlobalSearchTournamentHit {
  kind: 'tournament';
  id: string;
  nameAr: string;
  nameEn: string;
  status: string;
  startsAt: string;
}

export interface GlobalSearchResult {
  venues: GlobalSearchVenueHit[];
  players: GlobalSearchPlayerHit[];
  teams: GlobalSearchTeamHit[];
  matches: GlobalSearchMatchHit[];
  tournaments: GlobalSearchTournamentHit[];
}
