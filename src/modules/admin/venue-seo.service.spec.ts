import { NotFoundException } from '@nestjs/common';
import { VenueSeoService } from './venue-seo.service';

describe('VenueSeoService', () => {
  const tx = {
    venue: { update: jest.fn() },
    auditLogEntry: { create: jest.fn() },
  };
  const prisma = {
    venue: { findUnique: jest.fn() },
    $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
  };
  const service = new VenueSeoService(prisma as never);

  beforeEach(() => jest.clearAllMocks());

  it('rejects an unknown venue', async () => {
    prisma.venue.findUnique.mockResolvedValue(null);
    await expect(service.update('admin', 'missing', {})).rejects.toBeInstanceOf(NotFoundException);
  });

  it('normalizes empty overrides to null and writes an audit event', async () => {
    prisma.venue.findUnique.mockResolvedValue({ id: 'v1' });
    tx.venue.update.mockResolvedValue({ id: 'v1' });
    await service.update('admin', 'v1', {
      seoTitleOverrideAr: '  ',
      seoTitleOverrideEn: ' Custom title ',
    });
    expect(tx.venue.update).toHaveBeenCalledWith({
      where: { id: 'v1' },
      data: expect.objectContaining({
        seoTitleOverrideAr: null,
        seoTitleOverrideEn: 'Custom title',
      }),
    });
    expect(tx.auditLogEntry.create).toHaveBeenCalled();
  });
});
