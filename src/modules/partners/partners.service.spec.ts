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
      venuePhoto: { findMany:jest.fn().mockResolvedValue([]),update:jest.fn(),deleteMany: jest.fn(), createMany: jest.fn() },
      gamingLayout:{findUnique:jest.fn().mockResolvedValue(null)},usageSession:{findFirst:jest.fn().mockResolvedValue(null)},
      venueSport: { deleteMany: jest.fn(), createMany: jest.fn(), findFirst: jest.fn().mockResolvedValue(null) },
      venueAmenity: { deleteMany: jest.fn(), createMany: jest.fn() },
      court: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'c1' }), update: jest.fn() },
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
    prisma.partnerApplication.findUniqueOrThrow = jest
      .fn()
      .mockImplementation(() => Promise.resolve({ ...app, ...overrides.app, events: [] }));
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

  it('sends the owner to the live venue, not the submit wizard, when a venue is approved', async () => {
    const { svc, notifications } = serviceWith();
    await svc.decide('admin-1', 'app-1', { action: 'approve', version: 1, subscriptionDays: 90 });
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ deepLink: '/owner/venues/venue-1' }),
    );
  });

  it('keeps the application wizard link for decisions the owner must act on', async () => {
    const { svc, notifications } = serviceWith();
    await svc.decide('admin-1', 'app-1', { action: 'request_changes', version: 1, note: 'Please fix the photos' });
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ deepLink: '/partners/join?application=app-1' }),
    );
  });

  it('clears a removed contact and map pin instead of retaining stale application columns', async () => {
    const { svc, prisma } = serviceWith({ app: { status: 'draft', contactPhone: '+201001234567' } });
    await svc.patchOwned('owner-1', 'app-1', { payload: { contactPhone: '', lat: null, lng: null, locationConfirmed: false } as any, version: 1 });
    expect(prisma.partnerApplication.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ contactPhone: '', lat: null, lng: null }),
    }));
  });

  describe('owner edits of an approved listing', () => {
    const approved = { status: 'approved', venueId: 'venue-1' };

    it('leaves a live venue live when the save changes nothing', async () => {
      const { svc, prisma } = serviceWith({ app: approved });
      const out = await svc.patchOwned('owner-1', 'app-1', { payload: {} as any });
      expect(out.status).toBe('approved');
      expect(prisma.venue.update).not.toHaveBeenCalled();
      expect(prisma.partnerApplication.update).not.toHaveBeenCalled();
    });

    it('still takes a live venue back to review when something really changed', async () => {
      const { svc, prisma } = serviceWith({ app: approved });
      const out = await svc.patchOwned('owner-1', 'app-1', { payload: { address: 'Street 2' } as any });
      expect(out.status).toBe('draft');
      expect(prisma.venue.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'pending' } }),
      );
    });
  });
});
