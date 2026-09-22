import { BadRequestException } from '@nestjs/common';
import { VenuesService } from './venues.service';

/**
 * Regression: opening hours had no update path anywhere in the app (only set once, at
 * partner-application approval) — the new-owner checklist pointed at a settings page that
 * couldn't touch them. `update()` is where the frontend's venue page now sends them.
 */
function build() {
  const venue = { id: 'v1', ownerId: 'o1' };
  const prisma = {
    venue: {
      findUnique: jest.fn(async () => venue),
      update: jest.fn(async ({ data }: any) => ({ ...venue, ...data })),
    },
    $transaction: jest.fn((fn: any) => fn(prisma)),
  };
  return { svc: new VenuesService(prisma as any), prisma };
}

const validHours = {
  '0': { closed: true },
  '1': { closed: false, open: '09:00', close: '23:00' },
  '2': { closed: false, open: '09:00', close: '23:00' },
  '3': { closed: false, open: '09:00', close: '23:00' },
  '4': { closed: false, open: '09:00', close: '23:00' },
  '5': { closed: false, open: '09:00', close: '23:00' },
  '6': { closed: false, open: '09:00', close: '23:00' },
};

describe('VenuesService.update — weekly hours', () => {
  it('persists valid hours', async () => {
    const { svc, prisma } = build();
    await svc.update('v1', 'o1', false, { weeklyHours: validHours } as any);
    expect(prisma.venue.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ weeklyHours: validHours }) }),
    );
  });

  it('rejects hours with no open day', async () => {
    const { svc } = build();
    const allClosed = Object.fromEntries(Object.keys(validHours).map((k) => [k, { closed: true }]));
    await expect(svc.update('v1', 'o1', false, { weeklyHours: allClosed } as any)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an invalid time', async () => {
    const { svc } = build();
    const bad = { ...validHours, '1': { closed: false, open: '9:00', close: '23:00' } };
    await expect(svc.update('v1', 'o1', false, { weeklyHours: bad } as any)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('leaves hours untouched when the field is omitted', async () => {
    const { svc, prisma } = build();
    await svc.update('v1', 'o1', false, { nameEn: 'New name' } as any);
    const data = prisma.venue.update.mock.calls[0][0].data;
    expect(data.weeklyHours).toBeUndefined();
  });

  it("a stranger cannot update another owner's venue", async () => {
    const { svc } = build();
    await expect(svc.update('v1', 'someone-else', false, { weeklyHours: validHours } as any)).rejects.toBeDefined();
  });
});
