import { PartnersService } from './partners.service';
import { ApiException } from '../../common/errors/api-exception';

describe('PartnersService admin decisions', () => {
  const app = {
    id: 'app-1',
    ownerId: 'owner-1',
    venueId: null,
    status: 'pending',
    version: 1,
    payload: {
      publicNameEn: 'Court One',
      publicNameAr: 'ملعب واحد',
      contactPhone: '+201001234567',
      governorateId: 'gov-cairo',
      districtId: 'dist-maadi',
      address: 'Street 1',
      lat: 29.96,
      lng: 31.25,
      locationConfirmed: true,
      consent: true,
      courts: [
        {
          name: 'Padel 1',
          sportId: 'padel',
          slotDurationMins: 90,
          basePriceAmount: 15000,
        },
      ],
      photos: [{ url: '/uploads/a.webp', isCover: true }],
      weeklyHours: {
        '0': { closed: false, open: '08:00', close: '23:00' },
        '1': { closed: false, open: '08:00', close: '23:00' },
        '2': { closed: false, open: '08:00', close: '23:00' },
        '3': { closed: false, open: '08:00', close: '23:00' },
        '4': { closed: false, open: '08:00', close: '23:00' },
        '5': { closed: false, open: '08:00', close: '23:00' },
        '6': { closed: false, open: '08:00', close: '23:00' },
      },
    },
  };

  function serviceWith(overrides: Record<string, any> = {}) {
    const prisma: any = {
      partnerApplication: {
        findUnique: jest.fn().mockResolvedValue({ ...app, ...overrides.app }),
        update: jest.fn().mockImplementation(({ data, include }) =>
          Promise.resolve({
            ...app,
            ...data,
            owner: { id: 'owner-1', name: 'Partner', email: 'p@t.co', username: 'p' },
            venue: null,
            events: [],
            ...include,
          }),
        ),
      },
      governorate: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'gov-cairo',
          countryCode: 'EG',
        }),
      },
      district: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'dist-maadi',
          governorateId: 'gov-cairo',
        }),
      },
      sportCategory: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'sport-padel',
          slug: 'padel',
          activityKind: 'racket-court',
        }),
        findMany: jest.fn().mockResolvedValue([
          { id: 'sport-padel', slug: 'padel' },
        ]),
      },
      countryConfig: {
        findUnique: jest.fn().mockResolvedValue({ currency: 'EGP' }),
      },
      venue: {
        create: jest.fn().mockResolvedValue({ id: 'venue-1' }),
        update: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      venuePhoto: { deleteMany: jest.fn(), createMany: jest.fn() },
      venueSport: { deleteMany: jest.fn(), createMany: jest.fn() },
      venueAmenity: { deleteMany: jest.fn(), createMany: jest.fn() },
      court: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn().mockResolvedValue({ id: 'c1' }), update: jest.fn() },
      pricingRule: { deleteMany: jest.fn(), createMany: jest.fn() },
      amenity: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn((fn: any) => fn(prisma)),
    };
    const notifications = { create: jest.fn().mockResolvedValue({}) };
    const venues = { refreshVenuePriceFrom: jest.fn().mockResolvedValue(undefined) };
    const subscriptions = {
      startOrExtendOnApproval: jest.fn().mockResolvedValue(undefined),
      ensure: jest.fn().mockResolvedValue({}),
    };
    (prisma as any).venueSubscription = { findUnique: jest.fn().mockResolvedValue(null) };
    const svc = new PartnersService(
      prisma,
      {} as any,
      notifications as any,
      venues as any,
      subscriptions as any,
    );
    return { svc, prisma, notifications, subscriptions };
  }

  it('approves without a partner note, starting the subscription with the days the admin typed', async () => {
    const { svc, subscriptions } = serviceWith();
    await expect(
      svc.decide('admin-1', 'app-1', { action: 'approve', version: 1, subscriptionDays: 90, agreedPriceAmount: 200000 }),
    ).resolves.toMatchObject({ status: 'approved' });
    expect(subscriptions.startOrExtendOnApproval).toHaveBeenCalledWith(expect.anything(), 'admin-1', expect.any(String), 90, 200000);
  });

  it('refuses to approve a new venue without a subscription length', async () => {
    const { svc } = serviceWith();
    await expect(
      svc.decide('admin-1', 'app-1', { action: 'approve', version: 1 }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'SUBSCRIPTION_DAYS_REQUIRED' }) });
  });

  it('suspends without a partner note', async () => {
    const { svc } = serviceWith({ app: { status: 'approved', venueId: 'venue-1' } });
    await expect(
      svc.decide('admin-1', 'app-1', { action: 'suspend', version: 1 }),
    ).resolves.toMatchObject({ status: 'suspended' });
  });

  it('requires a useful note only when rejecting or requesting changes', async () => {
    const { svc } = serviceWith();
    await expect(
      svc.decide('admin-1', 'app-1', { action: 'reject', version: 1 }),
    ).rejects.toBeInstanceOf(ApiException);
    await expect(
      svc.decide('admin-1', 'app-1', { action: 'request_changes', version: 1 }),
    ).rejects.toBeInstanceOf(ApiException);
  });
});
