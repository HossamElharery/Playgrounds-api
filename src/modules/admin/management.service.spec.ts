import { ManagementService } from './management.service';
import { ManagementController } from './management.controller';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AdminUserDto, CoinAdjustmentDto } from './dto/management.dto';

describe('Administrator management', () => {
  let db: any;
  let service: ManagementService;
  beforeEach(() => {
    db = {
      user: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(2),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      refreshToken: { updateMany: jest.fn() },
      auditLogEntry: { create: jest.fn() },
      coinLedgerEntry: { create: jest.fn() },
      venueReview: {
        findUnique: jest.fn(),
        update: jest.fn(),
        aggregate: jest.fn(),
      },
      venue: { update: jest.fn() },
      district: { findUnique: jest.fn() },
      governorate: { findUnique: jest.fn() },
    };
    db.$transaction = jest.fn((fn: any) => fn(db));
    service = new ManagementService(db);
  });
  it('restricts every management route to administrators', () => {
    expect(Reflect.getMetadata(ROLES_KEY, ManagementController)).toEqual([
      'admin',
    ]);
  });
  it('does not allow password or arbitrary fields in the admin profile DTO', async () => {
    const dto = plainToInstance(AdminUserDto, {
      name: 'Valid User',
      reason: 'Correction',
      passwordHash: 'forged',
    });
    expect(
      (
        await validate(dto, { whitelist: true, forbidNonWhitelisted: true })
      ).some((e) => e.property === 'passwordHash'),
    ).toBe(true);
  });
  it('rejects unsupported roles and invalid phone formats', async () => {
    const dto = plainToInstance(AdminUserDto, {
      reason: 'Correction',
      roles: ['root'],
      phone: '123',
    });
    expect((await validate(dto)).map((e) => e.property)).toEqual(
      expect.arrayContaining(['roles', 'phone']),
    );
  });
  it('prevents self-demotion', async () => {
    db.user.findUnique.mockResolvedValue({
      id: 'admin',
      roles: ['admin'],
      status: 'active',
    });
    await expect(
      service.updateUser('admin', 'admin', {
        roles: ['player'],
        reason: 'Change roles',
      }),
    ).rejects.toThrow('own administrator');
    expect(db.user.update).not.toHaveBeenCalled();
  });
  it('saves changes and audit evidence together and revokes refresh sessions after a role change', async () => {
    db.user.findUnique.mockResolvedValue({
      id: 'u',
      roles: ['player'],
      status: 'active',
    });
    db.user.update.mockResolvedValue({ id: 'u', roles: ['owner'] });
    await service.updateUser('a', 'u', {
      roles: ['owner'],
      reason: 'Approved owner',
    });
    expect(db.refreshToken.updateMany).toHaveBeenCalled();
    expect(db.auditLogEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorUserId: 'a',
          targetId: 'u',
          action: 'admin.user.update',
        }),
      }),
    );
  });
  it('prevents a negative coin balance without creating ledger entries', async () => {
    db.user.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.coins('a', 'u', { amount: -500, reason: 'Correction' }),
    ).rejects.toThrow('insufficient');
    expect(db.coinLedgerEntry.create).not.toHaveBeenCalled();
    expect(db.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u', coinsBalance: { gte: 500 } },
      }),
    );
  });
  it('records a coin adjustment in the ledger and audit log', async () => {
    db.user.updateMany.mockResolvedValue({ count: 1 });
    await service.coins('a', 'u', { amount: 50, reason: 'Support credit' });
    expect(db.coinLedgerEntry.create).toHaveBeenCalledWith({
      data: { userId: 'u', amount: 50, reason: 'admin: Support credit' },
    });
    expect(db.auditLogEntry.create).toHaveBeenCalled();
  });
  it('retains original review in audit and recomputes aggregate rating', async () => {
    db.venueReview.findUnique.mockResolvedValue({
      id: 'r',
      venueId: 'v',
      stars: 1,
      text: 'Original',
    });
    db.venueReview.aggregate.mockResolvedValue({
      _avg: { stars: 3.5 },
      _count: 2,
    });
    await service.updateReview('a', 'r', {
      stars: 4,
      reason: 'Correction requested',
    });
    expect(db.venue.update).toHaveBeenCalledWith({
      where: { id: 'v' },
      data: { ratingAvg: 3.5, ratingCount: 2 },
    });
    expect(
      db.auditLogEntry.create.mock.calls[0][0].data.metadata.before.text,
    ).toBe('Original');
  });
  it('never selects authentication secrets in list responses', async () => {
    await service.users({ page: 1, perPage: 20 });
    expect(
      db.user.findMany.mock.calls[0][0].select.passwordHash,
    ).toBeUndefined();
    expect(
      db.user.findMany.mock.calls[0][0].select.refreshTokens,
    ).toBeUndefined();
  });
  describe('seeing what a user said to the assistants', () => {
    it('reads an owner’s whole assistant history from the permanent transcript, in the shape the user screen reads', async () => {
      const transcript = {
        forOwner: jest.fn().mockResolvedValue({
          items: [{ id: 't1', ownerId: 'o1', venueName: 'نيون', sender: 'owner', text: 'اقفل', flags: ['unrecognized'] }],
          nextCursor: 't0',
        }),
      };
      const svc = new ManagementService(db, transcript as never);
      const out = await svc.assistantMessages('o1', 30, 'c');
      expect(transcript.forOwner).toHaveBeenCalledWith('o1', 30, 'c');
      expect(out.nextCursor).toBe('t0');
      expect(out.items[0]).toMatchObject({ text: 'اقفل', flags: ['unrecognized'], venue: { nameAr: 'نيون' } });
    });

    it('shows a user’s Captain questions with the answers, newest first, paged', async () => {
      db.aiQuestionLog = {
        findMany: jest.fn().mockResolvedValue([
          { id: 'a', createdAt: new Date('2026-10-02T10:00:00Z'), textRedacted: 'بادل في المعادي', replyText: 'لقيتلك 2 أماكن', intent: 'find_venues', outcome: 'venues', feedback: null, model: 'm', lang: 'ar' },
          { id: 'b', createdAt: new Date('2026-10-02T09:00:00Z'), textRedacted: 'مين رئيس أمريكا', replyText: null, intent: 'unknown', outcome: 'clarify', feedback: 'down', model: 'm', lang: 'ar' },
        ]),
      };
      const out = await service.captainQuestions('u1', 1);
      expect(db.aiQuestionLog.findMany.mock.calls[0][0]).toMatchObject({ where: { userId: 'u1' }, take: 2 });
      expect(out.items).toHaveLength(1);
      expect(out.items[0]).toMatchObject({ text: 'بادل في المعادي', reply: 'لقيتلك 2 أماكن', outcome: 'venues' });
      expect(out.nextCursor).toBe('a');
    });
  });
});
