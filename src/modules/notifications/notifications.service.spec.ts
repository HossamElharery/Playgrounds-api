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
