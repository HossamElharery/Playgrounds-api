import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { EmailService } from '../email/email.service';
import { SquadService } from '../squad/squad.service';
import * as bcrypt from 'bcrypt';

const guest = { id: 'guest-1', isGuest: true, status: 'active', roles: ['player'], email: null, passwordHash: null, name: 'Guest', avatarConfig: { kitColor: '#00ff00' } };
const dto = { name: 'Ahmed Ali', email: ' Player@Example.com ', password: 'Password123!', code: '1234' };

describe('Guest account completion', () => {
  let service: AuthService;
  let tx: any;
  let prisma: any;
  let email: any;
  beforeEach(async () => {
    tx = {
      $queryRaw: jest.fn(),
      user: {
        findUnique: jest.fn(({ where }) => Promise.resolve(where.id ? { ...guest } : null)),
        update: jest.fn(({ data }) => Promise.resolve({ ...guest, ...data })),
      },
      otpCode: {
        findFirst: jest.fn().mockResolvedValue({ id: 'code-1', userId: guest.id, attempts: 0, consumedAt: null, expiresAt: new Date(Date.now() + 300000), codeHash: await bcrypt.hash('1234', 4) }),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({ id: 'new-code' }),
        count: jest.fn().mockResolvedValue(0),
        deleteMany: jest.fn(),
      },
    };
    prisma = { ...tx, $transaction: jest.fn(async (fn) => fn(tx)), refreshToken: { create: jest.fn() } };
    email = { sendVerificationCode: jest.fn().mockResolvedValue(undefined), sendWelcome: jest.fn().mockResolvedValue(undefined) };
    service = new AuthService(prisma as PrismaService, { signAsync: jest.fn().mockResolvedValue('token') } as unknown as JwtService,
      { get: (_key: string, fallback: unknown) => fallback } as ConfigService,
      { send: jest.fn() }, email as EmailService, { accountCompleted: jest.fn().mockResolvedValue(undefined) } as unknown as SquadService);
  });

  it('verifies the email and promotes the same identity without touching avatar, roles or membership', async () => {
    const result = await service.completeGuest(guest.id, dto);
    expect(result.user).toMatchObject({ id: guest.id, isGuest: false, email: 'player@example.com', emailVerifiedAt: expect.any(Date), avatarConfig: guest.avatarConfig });
    expect(result.user).not.toHaveProperty('passwordHash');
    expect(tx.user.update.mock.calls[0][0].data).not.toHaveProperty('roles');
    expect(tx.user.update.mock.calls[0][0].data).not.toHaveProperty('avatarConfig');
    expect(await bcrypt.compare(dto.password, tx.user.update.mock.calls[0][0].data.passwordHash)).toBe(true);
    expect(tx.otpCode.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: guest.id, target: 'player@example.com', purpose: 'register' } }));
  });

  it('commits a failed attempt and leaves the guest untouched for a wrong code', async () => {
    await expect(service.completeGuest(guest.id, { ...dto, code: '9999' })).rejects.toMatchObject({ status: 400 });
    expect(tx.otpCode.update).toHaveBeenCalledWith({ where: { id: 'code-1' }, data: { attempts: { increment: 1 } } });
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it.each([
    ['expired', { expiresAt: new Date(0) }],
    ['consumed', { consumedAt: new Date() }],
    ['exhausted', { attempts: 5 }],
  ])('rejects %s codes without promoting the guest', async (_label, overrides) => {
    const otp = await tx.otpCode.findFirst();
    tx.otpCode.findFirst.mockResolvedValue({ ...otp, ...overrides });
    await expect(service.completeGuest(guest.id, dto)).rejects.toMatchObject({ status: 400 });
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('rejects a code issued to another session or email', async () => {
    tx.otpCode.findFirst.mockResolvedValue(null);
    await expect(service.completeGuest(guest.id, dto)).rejects.toThrow(/expired/i);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('refuses an existing email without linking or replacing another account', async () => {
    tx.user.findUnique.mockImplementation(({ where }) => Promise.resolve(where.id ? guest : { id: 'other' }));
    await expect(service.completeGuest(guest.id, dto)).rejects.toMatchObject({ status: 409 });
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('refuses already promoted identities, including a change during the transaction', async () => {
    tx.user.findUnique.mockResolvedValueOnce(guest).mockResolvedValueOnce({ ...guest, isGuest: false });
    await expect(service.completeGuest(guest.id, dto)).rejects.toMatchObject({ status: 403 });
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('checks the atomic single-use claim before updating the account', async () => {
    tx.otpCode.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.completeGuest(guest.id, dto)).rejects.toMatchObject({ status: 400 });
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('binds new codes to the guest and delivers them out of band', async () => {
    expect(await service.requestGuestEmailCode(guest.id, dto.email)).toBeUndefined();
    expect(tx.otpCode.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: guest.id, target: 'player@example.com', purpose: 'register' }) }));
    expect(email.sendVerificationCode).toHaveBeenCalledWith('player@example.com', expect.stringMatching(/^\d{4}$/), 5);
  });

  it('blocks repeat requests before sending email', async () => {
    tx.otpCode.count.mockResolvedValue(1);
    await expect(service.requestGuestEmailCode(guest.id, dto.email)).rejects.toThrow(/wait/i);
    expect(email.sendVerificationCode).not.toHaveBeenCalled();
  });

  it('removes an undelivered code so the guest can retry', async () => {
    email.sendVerificationCode.mockRejectedValue(new Error('delivery failed'));
    await expect(service.requestGuestEmailCode(guest.id, dto.email)).rejects.toThrow('delivery failed');
    expect(prisma.otpCode.deleteMany).toHaveBeenCalledWith({ where: { id: 'new-code', consumedAt: null } });
  });
});
