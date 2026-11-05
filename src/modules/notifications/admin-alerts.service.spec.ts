import { AdminAlertsService } from './admin-alerts.service';

describe('AdminAlertsService', () => {
  const alert = {
    dedupKey: 'partner-submit:app-1:3',
    titleEn: 'New venue application: Arena',
    titleAr: 'طلب منشأة جديد: أرينا',
    bodyEn: 'body',
    bodyAr: 'نص',
    deepLink: '/admin/venues',
  };

  function make(admins: Array<{ id: string; email: string | null }>) {
    const prisma = { user: { findMany: jest.fn().mockResolvedValue(admins) } };
    const notifications = { create: jest.fn().mockResolvedValue({}) };
    const email = { sendFinanceNotice: jest.fn().mockResolvedValue(undefined) };
    const svc = new AdminAlertsService(prisma as never, notifications as never, email as never);
    return { svc, prisma, notifications, email };
  }

  it('notifies every active admin in-app and by email, with a per-admin dedup key', async () => {
    const { svc, prisma, notifications, email } = make([
      { id: 'a1', email: 'a1@x.com' },
      { id: 'a2', email: null },
    ]);
    await svc.alert(alert);
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { roles: { has: 'admin' }, status: 'active' } }),
    );
    expect(notifications.create).toHaveBeenCalledTimes(2);
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'a1', dedupKey: 'partner-submit:app-1:3:a1', category: 'system' }),
    );
    expect(email.sendFinanceNotice).toHaveBeenCalledTimes(1);
    expect(email.sendFinanceNotice).toHaveBeenCalledWith('a1@x.com', alert.titleEn, expect.stringContaining('body'));
  });

  it('skips email when asked, and never throws when delivery fails', async () => {
    const { svc, notifications, email } = make([{ id: 'a1', email: 'a1@x.com' }]);
    await svc.alert({ ...alert, email: false });
    expect(email.sendFinanceNotice).not.toHaveBeenCalled();
    notifications.create.mockRejectedValue(new Error('db down'));
    email.sendFinanceNotice.mockRejectedValue(new Error('smtp down'));
    await expect(svc.alert(alert)).resolves.toBeUndefined();
  });
});
