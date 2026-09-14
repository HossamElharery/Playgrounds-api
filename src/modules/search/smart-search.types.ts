export interface ParsedSearchIntent {
  sport: string | null;
  district: string | null;
  nearMe: boolean;
  cheap: boolean;
  timeHint: 'now' | 'tonight' | null;
}

export interface SmartSearchVenue {
  slug: string;
  nameAr: string;
  nameEn: string;
}

export interface SmartSearchChoice extends SmartSearchVenue {
  reasonAr: string;
  reasonEn: string;
}

export type SmartSearchResult =
  | { mode: 'redirect'; venue: SmartSearchVenue }
  | { mode: 'choices'; items: SmartSearchChoice[] }
  | { mode: 'empty'; filters: ParsedSearchIntent; broadenedFilters: Partial<ParsedSearchIntent> }
  | { mode: 'unavailable' };
