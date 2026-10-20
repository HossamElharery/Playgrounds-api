/// <reference types="jest" />
import { Logger } from '@nestjs/common';
import { ContentService } from './content.service';

describe('ContentService support inbox', () => {
  const inquiry = {
    id: 'inq-1',
    fullName: 'Omar Hassan',
    email: 'omar@mail.com',
    phone: '+201001234567',
    message: 'I cannot see my booking QR code.',
    status: 'new',
    userId: null,
  };

  let prisma: {
    supportInquiry: {
      create: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
  };
  let email: { sendSupportInquiry: jest.Mock };
  let service: ContentService;

  beforeEach(() => {
    prisma = {
      supportInquiry: {
        create: jest.fn().mockResolvedValue(inquiry),
        findMany: jest.fn(),
        count: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    email = { sendSupportInquiry: jest.fn().mockResolvedValue(undefined) };
    service = new ContentService(
      prisma as never,
      { notifyUrls: jest.fn() } as never,
      email as never,
    );
  });

  it('stores the contact message and emails support with the details', async () => {
    const saved = await service.createSupportInquiry(
      {
        fullName: inquiry.fullName,
        email: inquiry.email,
        phone: inquiry.phone,
        message: inquiry.message,
      },
      'user-9',
    );

    expect(saved).toEqual(inquiry);
    expect(prisma.supportInquiry.create).toHaveBeenCalledWith({
      data: {
        fullName: inquiry.fullName,
        email: inquiry.email,
        phone: inquiry.phone,
        message: inquiry.message,
        userId: 'user-9',
      },
    });
    expect(email.sendSupportInquiry).toHaveBeenCalledWith({
      fullName: inquiry.fullName,
      email: inquiry.email,
      phone: inquiry.phone,
      message: inquiry.message,
    });
  });

  it('keeps the inquiry even if the support email fails', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    email.sendSupportInquiry.mockRejectedValueOnce(new Error('smtp down'));

    await expect(
      service.createSupportInquiry({
        fullName: inquiry.fullName,
        email: inquiry.email,
        message: inquiry.message,
      }),
    ).resolves.toEqual(inquiry);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Support inquiry inq-1 saved but email failed'),
    );
    warn.mockRestore();
  });

  it('files a venue lead in the support inbox with a marker and the venue details', async () => {
    await expect(
      service.createVenueLead({
        fullName: 'Karim Adel',
        phone: '+201001234567',
        venueName: 'Golden Goal',
        city: 'Nasr City',
        sports: ['football', 'padel'],
        units: 4,
        source: '/ar/partners/padel',
        campaign: 'facebook / cpc',
        lang: 'ar',
      }),
    ).resolves.toEqual({ received: true });

    const data = prisma.supportInquiry.create.mock.calls[0][0].data;
    expect(data.fullName).toBe('Karim Adel');
    expect(data.phone).toBe('+201001234567');
    expect(data.email).toBe('venue-lead@no-email.matchena.com');
    expect(data.message.startsWith('[VENUE_LEAD]')).toBe(true);
    expect(data.message).toContain('Venue: Golden Goal');
    expect(data.message).toContain('Sports: football, padel');
    expect(data.message).toContain('Courts / devices: 4');
    expect(data.message).toContain('Page: /ar/partners/padel');
    expect(email.sendSupportInquiry).toHaveBeenCalledTimes(1);
  });

  it('keeps the owner email when one is given', async () => {
    await service.createVenueLead({ fullName: 'Karim Adel', phone: '+201001234567', email: 'k@mail.com' });
    expect(prisma.supportInquiry.create.mock.calls[0][0].data.email).toBe('k@mail.com');
  });

  it('drops honeypot submissions without storing or emailing anything', async () => {
    await expect(
      service.createVenueLead({ fullName: 'Bot', phone: '+201001234567', website: 'http://spam.example' }),
    ).resolves.toEqual({ received: true });
    expect(prisma.supportInquiry.create).not.toHaveBeenCalled();
    expect(email.sendSupportInquiry).not.toHaveBeenCalled();
  });
});

describe('ContentService account deletion requests', () => {
  const makeService = (recent: unknown) => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ name: 'Ahmed', email: null, phone: 'pending-1', username: 'ahmed.staff', roles: ['staff'] }) },
      supportInquiry: {
        findFirst: jest.fn().mockResolvedValue(recent),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...data, id: 'x', createdAt: new Date('2026-10-14T10:00:00Z') })),
      },
    };
    const service = new ContentService(prisma as never, { notifyUrls: jest.fn() } as never, { sendSupportInquiry: jest.fn() } as never);
    return { service, prisma };
  };

  it('files one request linked to the account, even without an email', async () => {
    const { service, prisma } = makeService(null);
    await service.requestAccountDeletion('u1');
    const data = prisma.supportInquiry.create.mock.calls[0][0].data;
    expect(data.userId).toBe('u1');
    expect(data.email).toBe('ahmed.staff@no-email.matchena.com');
    expect(data.phone).toBe('');
    expect(data.message).toContain('[ACCOUNT_DELETION_REQUEST]');
  });

  it('does not file a second request within a week', async () => {
    const { service, prisma } = makeService({ createdAt: new Date('2026-10-13T10:00:00Z') });
    const res = await service.requestAccountDeletion('u1');
    expect(prisma.supportInquiry.create).not.toHaveBeenCalled();
    expect(res.requestedAt.toISOString()).toBe('2026-10-13T10:00:00.000Z');
  });
});
