import { BadRequestException } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { RealtimeGatewayEmitter } from '../realtime/realtime-emitter.interface';

describe('Notification delivery', () => {
  const prisma = {
    user: { findMany: jest.fn() },
    notification: { deleteMany: jest.fn() },
  };
  let service: NotificationsService;
  beforeEach(() => {
    jest.clearAllMocks();
    service = new NotificationsService(
      prisma as unknown as PrismaService,
      {} as RealtimeGatewayEmitter,
      {} as ConfigService,
      { send: jest.fn() } as never,
      { sendToUser: jest.fn() } as never,
    );
  });
  it('counts created notifications and uses the system category for admin messages', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    const create = jest
      .spyOn(service, 'create')
      .mockResolvedValueOnce({ id: 'notification' } as never)
      .mockResolvedValueOnce(null);
    const result = await service.broadcast({
      audience: 'owners',
      titleEn: 'Notice',
      titleAr: 'إشعار',
      bodyEn: 'Details',
      bodyAr: 'تفاصيل',
    });
    expect(result).toEqual({ sent: 1, recipientIds: ['a'] });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'system' }),
    );
  });
  it('narrows player broadcasts to a district and attaches a CTA', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'p1' }]);
    const create = jest
      .spyOn(service, 'create')
      .mockResolvedValue({ id: 'n1' } as never);
    await service.broadcast({
      audience: 'players',
      districtId: 'nasr-city',
      titleEn: 'Tonight at Neon',
      titleAr: 'الليلة في نيون',
      bodyEn: 'Book a discounted court',
      bodyAr: 'احجز ملعب بخصم',
      ctaLabelEn: 'Book now',
      ctaLabelAr: 'احجز الآن',
      ctaUrl: '/en/venues/neon-arena',
    });
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ districtId: 'nasr-city' }),
      }),
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        deepLink: '/en/venues/neon-arena',
        payload: {
          ctaLabelEn: 'Book now',
          ctaLabelAr: 'احجز الآن',
          ctaUrl: '/en/venues/neon-arena',
        },
      }),
    );
  });
  it('excludes partner, staff and admin roles from player-only broadcasts', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    await service.broadcast({
      audience: 'players',
      titleEn: 'Notice',
      titleAr: 'إشعار',
      bodyEn: 'Details',
      bodyAr: 'تفاصيل',
    });
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          NOT: { roles: { hasSome: ['owner', 'staff', 'admin'] } },
        }),
      }),
    );
  });
  it('sends to selected accounts without applying a governorate filter', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'u1' }]);
    jest.spyOn(service, 'create').mockResolvedValue({ id: 'n1' } as never);
    await service.broadcast({
      audience: 'individual',
      recipientIds: ['u1'],
      governorateId: 'cairo',
      titleEn: 'Notice',
      titleAr: 'إشعار',
      bodyEn: 'Details',
      bodyAr: 'تفاصيل',
    });
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['u1'] }, status: 'active' },
      }),
    );
  });
  it('rejects individual broadcasts with no recipients', async () => {
    await expect(
      service.broadcast({
        audience: 'individual',
        titleEn: 'Notice',
        titleAr: 'إشعار',
        bodyEn: 'Details',
        bodyAr: 'تفاصيل',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });
  it('scopes dismissal to the authenticated recipient', async () => {
    await service.dismiss('current-user', 'message');
    expect(prisma.notification.deleteMany).toHaveBeenCalledWith({
      where: { id: 'message', userId: 'current-user' },
    });
  });
});

describe('Notifications to an owner with several venues', () => {
  const venue = { findUnique: jest.fn(), count: jest.fn() };
  const prisma = {
    user: { findUnique: jest.fn() },
    notification: { create: jest.fn() },
    venue,
  };
  let service: NotificationsService;
  const input = { userId: 'owner-1', category: 'system', titleEn: '250 EGP still due', titleAr: 'متبقي 250 ج.م', payload: { venueId: 'v1' } };
  beforeEach(() => {
    jest.resetAllMocks();
    prisma.user.findUnique.mockResolvedValue({ notificationPrefs: {}, preferredLang: 'ar' });
    prisma.notification.create.mockImplementation(({ data }) => Promise.resolve({ id: 'n1', ...data }));
    service = new NotificationsService(
      prisma as unknown as PrismaService,
      { emitToUser: jest.fn() } as unknown as RealtimeGatewayEmitter,
      {} as ConfigService,
      { send: jest.fn() } as never,
      { sendToUser: jest.fn() } as never,
    );
  });

  it('puts the venue name in front of the title when the owner has more than one venue', async () => {
    venue.findUnique.mockResolvedValue({ ownerId: 'owner-1', nameAr: 'مارينا', nameEn: 'Marina Hub' });
    venue.count.mockResolvedValue(3);
    await service.create(input);
    const data = prisma.notification.create.mock.calls[0][0].data;
    expect(data.titleAr).toBe('مارينا: متبقي 250 ج.م');
    expect(data.titleEn).toBe('Marina Hub: 250 EGP still due');
  });

  it('leaves the title alone for a one-venue owner', async () => {
    venue.findUnique.mockResolvedValue({ ownerId: 'owner-1', nameAr: 'مارينا', nameEn: 'Marina Hub' });
    venue.count.mockResolvedValue(1);
    await service.create(input);
    expect(prisma.notification.create.mock.calls[0][0].data.titleEn).toBe('250 EGP still due');
  });

  it('does not repeat a venue name the title already has', async () => {
    venue.findUnique.mockResolvedValue({ ownerId: 'owner-1', nameAr: 'مارينا', nameEn: 'Marina Hub' });
    venue.count.mockResolvedValue(2);
    await service.create({ ...input, titleEn: 'Marina Hub: drawer short by 50 EGP' });
    expect(prisma.notification.create.mock.calls[0][0].data.titleEn).toBe('Marina Hub: drawer short by 50 EGP');
  });

  it('never tags a player\'s notification, even when the payload names a venue', async () => {
    venue.findUnique.mockResolvedValue({ ownerId: 'someone-else', nameAr: 'مارينا', nameEn: 'Marina Hub' });
    venue.count.mockResolvedValue(5);
    await service.create({ ...input, userId: 'player-1' });
    expect(prisma.notification.create.mock.calls[0][0].data.titleEn).toBe('250 EGP still due');
  });

  it('still delivers when the venue lookup fails', async () => {
    venue.findUnique.mockRejectedValue(new Error('db'));
    await service.create(input);
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
  });
});



describe('Legacy cash notice amounts', () => {
  const notification = { findMany: jest.fn() };
  const cashShift = { findMany: jest.fn() };
  const cashHandover = { findMany: jest.fn() };
  const service = new NotificationsService({ notification, cashShift, cashHandover } as never, {} as never, {} as never, {} as never, {} as never);
  beforeEach(() => jest.resetAllMocks());
  const legacy = { id: 'n1', titleAr: 'مارينا: الخزنة ناقصة 12550 EGP', titleEn: 'Marina: drawer short by 12550 EGP', payload: { venueId: 'v1', shiftId: 's1' } };
  it.each(['assistant_overdue', 'assistant_arrival_due'])('orders by creation time and does not guess an old %s currency', async (kind) => {
    const old = { ...legacy, payload: { kind, venueId: 'v1', total: 12000 }, titleAr: '120 EGP', titleEn: '120 EGP' };
    notification.findMany.mockResolvedValue([old]);
    const result = await service.list('owner');
    expect(notification.findMany).toHaveBeenCalledWith(expect.objectContaining({orderBy:[{createdAt:'desc'},{id:'desc'}]}));
    expect(result.items[0].titleAr).toContain('تذكير سابق');
    expect(result.items[0].titleAr).not.toContain('EGP');
    expect(old.titleAr).toBe('120 EGP');
  });

  it('renders a legacy cash title from the source record without rewriting stored data', async () => {
    notification.findMany.mockResolvedValue([legacy]);
    cashShift.findMany.mockResolvedValue([{ id: 's1', venueId: 'v1', difference: -12550, currency: 'AED' }]);
    const result = await service.list('owner');
    expect(result.items[0].titleAr).toBe('مارينا: الخزنة ناقصة 125.5 د.إ');
    expect(result.items[0].titleEn).toBe('Marina: drawer short by 125.5 AED');
    expect(legacy.titleAr).toContain('12550 EGP');
    expect(notification.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'owner' } }));
  });
  it('leaves modern text, other numbers, and mismatched venues untouched', async () => {
    notification.findMany.mockResolvedValue([
      { ...legacy, id: 'n1', titleAr: 'ناقصة 125.5 د.إ', titleEn: 'short by 125.5 AED' },
      { ...legacy, id: 'n2', titleAr: 'رقم 900 EGP', titleEn: 'number 900 EGP' },
      { ...legacy, id: 'n3', payload: { venueId: 'other', shiftId: 's1' } },
    ]);
    cashShift.findMany.mockResolvedValue([{ id: 's1', venueId: 'v1', difference: -12550, currency: 'AED' }]);
    const result = await service.list('owner');
    expect(result.items.map(n => n.titleAr)).toEqual(['ناقصة 125.5 د.إ', 'رقم 900 EGP', legacy.titleAr]);
  });
  it('does not reinterpret the fractional digits of a modern amount as minor units', async () => {
    notification.findMany.mockResolvedValue([{ ...legacy, titleAr: '0.05 AED', titleEn: '0.05 AED' }]);
    cashShift.findMany.mockResolvedValue([{ id: 's1', venueId: 'v1', difference: -5, currency: 'AED' }]);
    expect((await service.list('owner')).items[0].titleEn).toBe('0.05 AED');
  });
  it('also corrects old handover notices and skips all cash queries for ordinary notices', async () => {
    notification.findMany.mockResolvedValue([{ ...legacy, payload: { venueId: 'v1', handoverId: 'h1' } }]);
    cashHandover.findMany.mockResolvedValue([{ id: 'h1', venueId: 'v1', difference: 12550, currency: 'AED' }]);
    expect((await service.list('owner')).items[0].titleEn).toContain('125.5 AED');
    expect(cashShift.findMany).not.toHaveBeenCalled();
    notification.findMany.mockResolvedValue([{ ...legacy, payload: null }]);
    cashHandover.findMany.mockClear();
    expect((await service.list('owner')).items[0].titleAr).toBe(legacy.titleAr);
    expect(cashHandover.findMany).not.toHaveBeenCalled();
  });
});

describe('historical staff notification scope', () => {
  it('redacts financial and reassigned venue notices using current access without changing stored rows', async () => {
    const rows = [
      { id: 'debt', titleAr: '120 AED', payload: { kind: 'assistant_overdue', venueId: 'assigned', currency: 'AED' }, deepLink: '/ar/owner/today' },
      { id: 'other', titleAr: 'Other venue', payload: { kind: 'assistant_arrival', venueId: 'other' }, deepLink: '/ar/owner/today' },
      { id: 'allowed', titleAr: 'Arrival', payload: { kind: 'assistant_arrival', venueId: 'assigned' }, deepLink: '/ar/owner/today' },
    ];
    const service = new NotificationsService({
      notification: { findMany: jest.fn().mockResolvedValue(rows) },
      staffMember: { findUnique: jest.fn().mockResolvedValue({ id: 'member', ownerId: 'owner', venueIds: ['assigned'], permissions: ['bookings.view'] }) },
    } as never, {} as never, {} as never, {} as never, {} as never);
    const page = await service.list('staff', undefined, 30, { id: 'staff', name: 'Staff', phone: '', roles: ['staff'] });
    expect(page.items.slice(0, 2)).toEqual(expect.arrayContaining([expect.objectContaining({ payload: null, deepLink: null, titleAr: 'تنبيه سابق خارج صلاحياتك الحالية' })]));
    expect(page.items[0].payload).toBeNull();
    expect(page.items[1].payload).toBeNull();
    expect(page.items[2]).toEqual(rows[2]);
    expect(rows[0].titleAr).toBe('120 AED');
    expect(rows[0].payload.venueId).toBe('assigned');
  });
});
