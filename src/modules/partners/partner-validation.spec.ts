import { validatePartnerSubmission } from './partner-validation';
import { PartnerApplicationPayload } from './partner.types';

function validPayload(): PartnerApplicationPayload {
  return {
    publicNameEn: 'Olaya Padel House',
    publicNameAr: 'بيت بادل العليا',
    contactPhone: '+966500000001',
    governorateId: 'gov-riyadh',
    districtId: 'dist-olaya',
    address: 'Olaya Street',
    lat: 24.7136,
    lng: 46.6753,
    locationConfirmed: true,
    weeklyHours: {
      '0': { closed: true },
      '1': { closed: false, open: '08:00', close: '23:00' },
      '2': { closed: false, open: '08:00', close: '23:00' },
      '3': { closed: false, open: '08:00', close: '23:00' },
      '4': { closed: false, open: '08:00', close: '23:00' },
      '5': { closed: false, open: '08:00', close: '02:00' },
      '6': { closed: false, open: '08:00', close: '23:00' },
    },
    courts: [
      {
        name: 'Court 1',
        sportId: 'sport-padel',
        slotDurationMins: 90,
        basePriceAmount: 15000,
        peakPriceAmount: 18000,
      },
    ],
    photos: [{ url: 'https://cdn.example/photo.webp', isCover: true }],
    consent: true,
    cancellationPreset: 'flexible_24h',
  };
}

describe('validatePartnerSubmission', () => {
  it('accepts a complete one-photo application', () => {
    expect(validatePartnerSubmission(validPayload())).toEqual([]);
  });

  it('rejects missing photos, location, and consent', () => {
    const payload = validPayload();
    payload.photos = [];
    payload.locationConfirmed = false;
    payload.consent = false;
    payload.lat = 0;
    payload.lng = 0;
    const errors = validatePartnerSubmission(payload);
    expect(errors.some((e) => e.includes('photo'))).toBe(true);
    expect(errors.some((e) => e.toLowerCase().includes('consent'))).toBe(true);
    expect(errors.some((e) => e.toLowerCase().includes('location'))).toBe(true);
  });

  it('rejects peak below base and all-closed hours', () => {
    const payload = validPayload();
    payload.courts![0].peakPriceAmount = 100;
    payload.weeklyHours = {
      '0': { closed: true },
      '1': { closed: true },
      '2': { closed: true },
      '3': { closed: true },
      '4': { closed: true },
      '5': { closed: true },
      '6': { closed: true },
    };
    const errors = validatePartnerSubmission(payload);
    expect(errors.some((e) => e.includes('peak'))).toBe(true);
    expect(errors.some((e) => e.includes('open'))).toBe(true);
  });
});
