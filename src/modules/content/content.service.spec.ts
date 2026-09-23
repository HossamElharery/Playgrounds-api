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
});
