import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { OwnerService } from './owner.service';

describe('Owner dashboard integrity', () => {
  let db: any; let service: OwnerService;
  const owner = { id: 'owner', phone: '', name: 'Owner', roles: ['owner'] as UserRole[] };
  beforeEach(() => {
    db = {
      venue: { findUnique: jest.fn().mockResolvedValue({ id: 'v1', ownerId: 'owner', currency: 'EGP' }) },
      booking: { findMany: jest.fn().mockResolvedValue([]) },
      commissionSetting: { findUnique: jest.fn().mockResolvedValue({ percentageBps: 750 }) },
      staffInvite: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
      user: { findUniqueOrThrow: jest.fn() },
      userRoleAssignment: { deleteMany: jest.fn().mockResolvedValue({count:1}), findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
    };
    db.$transaction = jest.fn(fn => fn(db));
    const bookings: any = { getSlotGrid: jest.fn().mockResolvedValue([]) };
    const nlu: any = { enabled: false, interpret: jest.fn() };
    service = new OwnerService(db, bookings, nlu);
  });
  it.each([[30, 4000], [45, 6000], [60, 8000], [90, 12000]])('quotes the actual %i-minute owner cell', async (minutes, amount) => {
    db.venue.findUnique.mockResolvedValue({ id: 'v1', ownerId: 'owner', country: { timezone: 'Africa/Cairo' } });
    db.court = { findMany: jest.fn().mockResolvedValue([{ id: 'c1', slotDurationMins: minutes,
      sport: { activityKind: 'table-game' }, pricingRules: [{ daysOfWeek: [], startTime: '00:00', endTime: '24:00', priceAmount: 8000, currency: 'EGP', priority: 0 }] }]) };
    db.calendarBlock = { findMany: jest.fn().mockResolvedValue([]) };
    const start = new Date('2026-10-05T09:00:00Z');
    service = new OwnerService(db, { getSlotGrid: jest.fn().mockResolvedValue([{ start: start.toISOString(),
      end: new Date(start.getTime() + minutes * 60000).toISOString(), state: 'free', priceAmount: 8000 }]) } as never, { enabled: false } as never);
    const result = await service.board(owner as never, 'v1', '2026-10-05');
    expect(result.courts[0].slots[0].priceAmount).toBe(amount);
  });

  it('rejects finance for another owner venue', async () => {
    await expect(service.finance({ ...owner, id: 'other' },'v1','2026-09-01','2026-09-07')).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.booking.findMany).not.toHaveBeenCalled();
  });
  it('includes the whole final day and uses configured commission', async () => {
    db.booking.findMany.mockResolvedValue([{totalAmount:10000,currency:'EGP',slotStart:new Date('2026-09-07T22:00:00Z'),court:{name:'A'}}]);
    const result = await service.finance(owner as never,'v1','2026-09-01','2026-09-07');
    expect(result).toMatchObject({totalRevenue:10000,commissionAmount:750,netPayout:9250,paidBookings:1,currency:'EGP'});
    expect(db.booking.findMany.mock.calls[0][0].where.slotStart.lte.toISOString()).toBe('2026-09-07T23:59:59.999Z');
  });
  it('does not add different currencies together', async () => {
    db.booking.findMany.mockResolvedValue([{currency:'EGP'},{currency:'SAR'}]);
    await expect(service.finance(owner as never,'v1','2026-09-01','2026-09-07')).rejects.toBeInstanceOf(BadRequestException);
  });
  describe('the admin’s permanent copy of the assistant chat', () => {
    let transcript: { mirrorClientLine: jest.Mock };
    beforeEach(() => {
      db.assistantMessage = {
        create: jest.fn().mockResolvedValue({ id: 'm1' }),
        findMany: jest.fn().mockResolvedValue([]),
      };
      transcript = { mirrorClientLine: jest.fn().mockResolvedValue(undefined) };
      service = new OwnerService(db, { getSlotGrid: jest.fn() } as never, { enabled: false } as never, transcript as never);
    });

    it('mirrors every line the app posts into the transcript, with who and where', async () => {
      await service.createAssistantMessage(owner as never, { venueId: 'v1', sender: 'owner', text: 'اقفل بلايستيشن 2' } as never);
      expect(db.assistantMessage.create).toHaveBeenCalled();
      expect(transcript.mirrorClientLine).toHaveBeenCalledWith({
        ownerId: 'owner',
        ownerName: 'Owner',
        venueId: 'v1',
        sender: 'owner',
        text: 'اقفل بلايستيشن 2',
        scheduleChange: false,
      });
    });

    it('marks a line that carried a schedule change', async () => {
      await service.createAssistantMessage(owner as never, { venueId: 'v1', sender: 'system', text: 'قفل 5-7', inverseChange: { remove: ['b'] } } as never);
      expect(transcript.mirrorClientLine.mock.calls[0][0]).toMatchObject({ scheduleChange: true });
    });

    it('staff only reads their own assistant history in the allowed venue', async () => {
      db.staffMember = { findUnique: jest.fn().mockResolvedValue({ id:'s1', ownerId:'owner', venueIds:['v1'], permissions:['bookings.view'] }) };
      await service.listAssistantMessages({id:'staff', roles:['staff']} as never, 'v1');
      expect(db.assistantMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({where:{venueId:'v1',ownerId:'staff',NOT:{text:'assistant-undo'}}}));
    });

    it('does not list the hidden undo-point rows as chat', async () => {
      await service.listAssistantMessages(owner as never, 'v1');
      expect(db.assistantMessage.findMany.mock.calls[0][0].where).toEqual({ venueId: 'v1', NOT: { text: 'assistant-undo' } });
    });
  });
});
