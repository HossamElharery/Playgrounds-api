import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BookingsService } from './bookings.service';
import { PrismaService } from '../prisma/prisma.service';
import { PAYMENT_PROVIDER } from '../payments/payment-provider.interface';

describe('BookingsService', () => {
  let service: BookingsService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        BookingsService,
        { provide: PrismaService, useValue: {} },
        {
          provide: ConfigService,
          useValue: { get: () => 'test-secret-'.repeat(4) },
        },
        {
          provide: PAYMENT_PROVIDER,
          useValue: { charge: jest.fn(), refund: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(BookingsService);
  });

  describe('refundPreviewPct', () => {
    it('offers a full refund 24+ hours before the slot', () => {
      const slotStart = new Date(Date.now() + 25 * 3_600_000);
      expect(service.refundPreviewPct(slotStart)).toBe(100);
    });

    it('offers a partial refund between 2 and 24 hours before the slot', () => {
      const slotStart = new Date(Date.now() + 5 * 3_600_000);
      expect(service.refundPreviewPct(slotStart)).toBe(50);
    });

    it('offers no refund inside the 2-hour cancellation window', () => {
      const slotStart = new Date(Date.now() + 30 * 60_000);
      expect(service.refundPreviewPct(slotStart)).toBe(0);
    });
  });
});
