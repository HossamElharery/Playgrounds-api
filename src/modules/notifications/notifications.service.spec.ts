import { NotificationsService } from './notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { RealtimeGatewayEmitter } from '../realtime/realtime-emitter.interface';

describe('Notification delivery', () => {
  const prisma = { user: { findMany: jest.fn() }, notification: { deleteMany: jest.fn() } };
  let service: NotificationsService;
  beforeEach(() => {
    jest.clearAllMocks();
    service = new NotificationsService(prisma as unknown as PrismaService, {} as RealtimeGatewayEmitter, {} as ConfigService);
  });
  it('counts created notifications and uses the system category for admin messages', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    const create = jest.spyOn(service, 'create').mockResolvedValueOnce({ id: 'notification' } as never).mockResolvedValueOnce(null);
    const result = await service.broadcast({ audience: 'owners', titleEn: 'Notice', titleAr: 'إشعار', bodyEn: 'Details', bodyAr: 'تفاصيل' });
    expect(result).toEqual({ sent: 1, recipientIds: ['a'] });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ category: 'system' }));
  });
  it('narrows player broadcasts to a district and attaches a CTA', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'p1' }]);
    const create = jest.spyOn(service, 'create').mockResolvedValue({ id: 'n1' } as never);
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
    await service.broadcast({ audience: 'players', titleEn: 'Notice', titleAr: 'إشعار', bodyEn: 'Details', bodyAr: 'تفاصيل' });
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ NOT: { roles: { hasSome: ['owner', 'staff', 'admin'] } } }) }));
  });
  it('scopes dismissal to the authenticated recipient', async () => {
    await service.dismiss('current-user', 'message');
    expect(prisma.notification.deleteMany).toHaveBeenCalledWith({ where: { id: 'message', userId: 'current-user' } });
  });
});
