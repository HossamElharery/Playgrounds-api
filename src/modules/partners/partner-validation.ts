import {
  isValidHhmm,
  validateWeeklyHours,
} from '../../common/utils/weekly-hours.util';
import { validateRegistrationGamingPlan } from './registration-gaming-setup';
import { PartnerApplicationPayload, SLOT_DURATIONS } from './partner.types';

const MAX_NAME = 120;
const MAX_DESC = 2000;
const MAX_ADDRESS = 240;
const MAX_RULES = 2000;
const MAX_COURTS = 20;

function trimmed(value?: string | null): string {
  return (value ?? '').trim();
}

function looksLikeE164(phone: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(phone);
}

/** Draft saves are partial. Submission re-runs this gate. */
export function validatePartnerSubmission(
  payload: PartnerApplicationPayload,
): string[] {
  const errors: string[] = [];
  const nameEn = trimmed(payload.publicNameEn);
  const nameAr = trimmed(payload.publicNameAr);
  if (!nameEn) errors.push('Public English name is required');
  if (!nameAr) errors.push('Public Arabic name is required');
  if (nameEn.length > MAX_NAME) errors.push('English name is too long');
  if (nameAr.length > MAX_NAME) errors.push('Arabic name is too long');

  const phone = trimmed(payload.contactPhone);
  if (phone && !looksLikeE164(phone)) {
    errors.push('Booking contact must be a valid E.164 phone');
  }

  if (!trimmed(payload.governorateId)) errors.push('Governorate is required');
  if (!trimmed(payload.districtId)) errors.push('District is required');
  if (
    !trimmed(payload.address) ||
    trimmed(payload.address).length > MAX_ADDRESS
  ) {
    errors.push('Street address is required');
  }

  if (payload.locationConfirmed !== true) {
    errors.push('Map pin must be confirmed');
  }
  if (
    payload.lat == null ||
    payload.lng == null ||
    !Number.isFinite(payload.lat) ||
    !Number.isFinite(payload.lng) ||
    (payload.lat === 0 && payload.lng === 0)
  ) {
    errors.push('A confirmed map location is required');
  }

  if (trimmed(payload.descriptionEn).length > MAX_DESC) {
    errors.push('English description is too long');
  }
  if (trimmed(payload.descriptionAr).length > MAX_DESC) {
    errors.push('Arabic description is too long');
  }
  if (trimmed(payload.houseRules).length > MAX_RULES) {
    errors.push('House rules are too long');
  }

  errors.push(...validateWeeklyHours(payload.weeklyHours));

  const courts = payload.courts ?? [];
  if (courts.length < 1) errors.push('At least one court is required');
  if (courts.length > (payload.gamingSetup ? 120 : MAX_COURTS))
    errors.push('Too many venue units');
  if (payload.gamingSetup) {
    try {
      validateRegistrationGamingPlan(payload.gamingSetup);
      const inventory = courts.filter((c) =>
        ['playstation', 'billiards', 'table-tennis'].includes(
          (c.sportId ?? '').replace(/^sport-/, ''),
        ),
      );
      // IDs can be UUIDs: resolved sports are checked again during approval.
      if (inventory.length) {
        if (courts.length - inventory.length > 20)
          errors.push('Too many sports courts');
        for (const g of payload.gamingSetup.groups) {
          const count = inventory.filter((c) => {
            const sport = (c.sportId ?? '').replace(/^sport-/, '');
            return (
              (sport === 'playstation' ? c.spec?.consoleType : sport) ===
              g.assetKey
            );
          }).length;
          if (count !== g.count)
            errors.push('Gaming inventory does not match quick setup');
        }
        if (
          inventory.length !==
          payload.gamingSetup.groups.reduce((n, g) => n + g.count, 0)
        )
          errors.push('Gaming inventory does not match quick setup');
      }
    } catch {
      errors.push('Quick gaming setup is invalid');
    }
  }
  courts.forEach((court, index) => {
    const label = `Court ${index + 1}`;
    if (!trimmed(court.name)) errors.push(`${label}: name is required`);
    if (!trimmed(court.sportId)) errors.push(`${label}: sport is required`);
    if (
      !court.slotDurationMins ||
      !SLOT_DURATIONS.includes(
        court.slotDurationMins as (typeof SLOT_DURATIONS)[number],
      )
    ) {
      errors.push(
        `${label}: duration must be 30, 45, 60, 90, 120 or 180 minutes`,
      );
    }
    if (!court.basePriceAmount || court.basePriceAmount < 1) {
      errors.push(`${label}: base price must be a positive amount`);
    }
    if (
      court.peakPriceAmount != null &&
      court.peakPriceAmount < (court.basePriceAmount ?? 0)
    ) {
      errors.push(`${label}: peak price cannot be below base price`);
    }
  });

  const photos = (payload.photos ?? []).filter((p) => trimmed(p.url));
  if (photos.length < 1) errors.push('At least one gallery photo is required');
  if (photos.length > 8)
    errors.push('A venue may have at most 8 gallery photos');

  if (payload.consent !== true) {
    errors.push('Accuracy and authorization consent is required');
  }

  const preset = payload.cancellationPreset;
  if (preset === 'custom' && !trimmed(payload.cancellationPolicy)) {
    errors.push('Custom cancellation policy text is required');
  }

  if (payload.weeklyHours) {
    for (const day of Object.values(payload.weeklyHours)) {
      if (!day.closed && (!isValidHhmm(day.open) || !isValidHhmm(day.close))) {
        errors.push('Opening hours must use 15-minute steps');
        break;
      }
    }
  }

  return errors;
}

export function sanitizePayload(
  payload: PartnerApplicationPayload,
): PartnerApplicationPayload {
  if (payload.gamingSetup) validateRegistrationGamingPlan(payload.gamingSetup);
  return {
    ...payload,
    publicNameEn: trimmed(payload.publicNameEn),
    publicNameAr: trimmed(payload.publicNameAr),
    contactPhone: trimmed(payload.contactPhone),
    descriptionEn: trimmed(payload.descriptionEn) || undefined,
    descriptionAr: trimmed(payload.descriptionAr) || undefined,
    legalBusinessName: trimmed(payload.legalBusinessName) || undefined,
    registrationNumber: trimmed(payload.registrationNumber) || undefined,
    address: trimmed(payload.address) || undefined,
    houseRules: trimmed(payload.houseRules) || undefined,
    courts: (payload.courts ?? []).slice(
      0,
      payload.gamingSetup ? 120 : MAX_COURTS,
    ),
    photos: (payload.photos ?? []).filter((p) => trimmed(p.url)).slice(0, 8),
  };
}
