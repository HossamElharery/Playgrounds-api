import type { WeeklyHours } from '../../common/utils/weekly-hours.util';

export const SLOT_DURATIONS = [30, 45, 60, 90, 120, 180] as const;

export interface PartnerCourtDraft {
  id?: string;
  name?: string;
  sportId?: string;
  surface?: string;
  indoor?: boolean;
  format?: string;
  slotDurationMins?: number;
  basePriceAmount?: number;
  peakPriceAmount?: number;
  amenityKeys?: string[];
  spec?: Record<string, unknown>;
}

export interface PartnerPhotoDraft {
  url?: string;
  isCover?: boolean;
}

export interface PartnerApplicationPayload {
  publicNameEn?: string;
  publicNameAr?: string;
  contactPhone?: string;
  descriptionEn?: string;
  descriptionAr?: string;
  legalBusinessName?: string;
  registrationNumber?: string;
  countryCode?: string;
  governorateId?: string;
  districtId?: string;
  address?: string;
  lat?: number | null;
  lng?: number | null;
  locationConfirmed?: boolean;
  courts?: PartnerCourtDraft[];
  weeklyHours?: WeeklyHours;
  cancellationPolicy?: string;
  cancellationPreset?: 'flexible_24h' | 'flexible_12h' | 'non_refundable' | 'custom';
  houseRules?: string;
  photos?: PartnerPhotoDraft[];
  verificationDocumentUrl?: string;
  consent?: boolean;
}

export const OWNER_EDITABLE_STATUSES = ['draft', 'changes_requested', 'approved'] as const;
