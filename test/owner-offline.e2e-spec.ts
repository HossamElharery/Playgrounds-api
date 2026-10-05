import { randomUUID } from 'crypto';
const dbUrl = process.env.TEST_DATABASE_URL ?? '';
if (!/(test|tmp)/.test(dbUrl.split('?')[0].split('/').pop() ?? '')) throw new Error('Use a throwaway test database');
process.env.DATABASE_URL = dbUrl;
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { OwnerBookingsService } from '../src/modules/owner/owner-bookings.service';
import { LedgerService } from '../src/modules/finance/ledger.service';
import { CommissionService } from '../src/modules/finance/commission.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { AuthenticatedUser } from '../src/common/types/authenticated-user.interface';
import { CreateManualBookingDto } from '../src/modules/owner/dto/manual-booking.dto';

jest.setTimeout(60_000);
describe('Owner offline replay on real PostgreSQL', () => {
  const prisma = new PrismaService();
  const ledger = new LedgerService(prisma, new CommissionService(prisma, {} as never));
  const service = new OwnerBookingsService(prisma, ledger, {} as never, { create: async () => {} } as unknown as NotificationsService);
  let user: AuthenticatedUser, venueId: string, courtId: string;
  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => {
    const id = randomUUID();
    const owner = await prisma.user.create({ data: { name: 'Offline owner', phone: `+201${Math.floor(Math.random() * 1e9).toString().padStart(9, '0')}`, roles: ['owner'] } });
    user = { id: owner.id, name: owner.name, phone: owner.phone!, roles: ['owner'] };
    const sport = await prisma.sportCategory.create({ data: { slug: `offline-${id}`, nameEn: 'Offline court', nameAr: 'ملعب', icon: 'ball' } });
    const venue = await prisma.venue.create({ data: {
      slug: `offline-${id}`, ownerId: user.id, nameEn: 'Offline venue', nameAr: 'ملعب', lat: 30, lng: 31, geohash: 'sv8wr', status: 'active', currency: 'EGP', priceFromCurrency: 'EGP',
      weeklyHours: Object.fromEntries(Array.from({ length: 7 }, (_, d) => [String(d), { closed: false, open: '00:00', close: '23:45' }])),
    } });
    venueId = venue.id;
    courtId = (await prisma.court.create({ data: { venueId, sportId: sport.id, name: 'Court' } })).id;
  });
  const draft = (): CreateManualBookingDto => ({ requestKey: randomUUID(), venueId, courtId, startsAt: new Date(Date.now() + 86400_000).toISOString(), durationMinutes: 60, priceAmount: 70000, paidAmount: 20000, paymentStatus: 'partial', paymentMethod: 'cash', customerName: 'Ahmed' });
  it('atomically creates the 700/200/500 booking and replays without another deposit', async () => {
    const dto = draft();
    const first = await service.createManualBooking(user, dto);
    const replay = await service.createManualBooking(user, { ...dto, requestKey: dto.requestKey!.toUpperCase() });
    expect(first.id).toBe(replay.id);
    expect(replay.money).toMatchObject({ total: 70000, paidAmount: 20000, outstanding: 50000 });
    expect(await prisma.payment.count({ where: { bookingId: first.id } })).toBe(1);
    expect(await prisma.booking.count({ where: { manualRequestKey: dto.requestKey } })).toBe(1);
  });
  it('rejects key reuse with different amount or a different actor', async () => {
    const dto = draft(); await service.createManualBooking(user, dto);
    await expect(service.createManualBooking(user, { ...dto, priceAmount: 80000 })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'OPERATION_KEY_REUSED' }) });
    await expect(service.createManualBooking({ ...user, id: randomUUID() }, dto)).rejects.toBeDefined();
  });
  it('rolls back the booking and its cash if another booking occupies the time', async () => {
    const dto = draft(); await service.createManualBooking(user, dto);
    await expect(service.createManualBooking(user, { ...dto, requestKey: randomUUID() })).rejects.toBeDefined();
    expect(await prisma.booking.count({ where: { venueId } })).toBe(1);
    expect(await prisma.payment.count({ where: { booking: { venueId } } })).toBe(1);
  });
  it('accepts a late replay within a server-issued grant, rejecting forged and out-of-range grants', async () => {
    const grant = await service.prepareOffline(user, venueId, randomUUID());
    const dto = { ...draft(), startsAt: new Date(Date.now() - 2 * 3600_000).toISOString(), offlineGrant: grant.token };
    // Simulate an earlier prepared shift using server-owned grant timestamps, not a client clock.
    await prisma.ownerOfflineGrant.updateMany({ where: { venueId }, data: { issuedAt: new Date(Date.now() - 3 * 3600_000) } });
    const saved = await service.createManualBooking(user, dto);
    expect(saved.money.outstanding).toBe(50000);
    await expect(service.createManualBooking(user, { ...draft(), offlineGrant: 'forged' })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'OFFLINE_GRANT_INVALID' }) });
    await expect(service.createManualBooking(user, { ...draft(), startsAt: new Date(Date.now() + 10 * 86400_000).toISOString(), offlineGrant: grant.token })).rejects.toBeDefined();
    await expect(service.createManualBooking(user, { ...draft(), offlineGrant: grant.token, paymentMethod: 'card' })).rejects.toBeDefined();
  });
  it('prevents non-grant creation of past bookings', async () => {
    await expect(service.createManualBooking(user, { ...draft(), startsAt: new Date(Date.now() - 2 * 3600_000).toISOString() })).rejects.toBeDefined();
    expect(await prisma.booking.count({ where: { venueId } })).toBe(0);
  });
  it('concurrent first submissions keep one booking and one initial payment', async () => {
    const dto = draft();
    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => service.createManualBooking(user, dto)));
    expect(outcomes.some(o => o.status === 'fulfilled')).toBe(true);
    const replay = await service.createManualBooking(user, dto);
    expect(await prisma.booking.count({ where: { venueId } })).toBe(1);
    expect(await prisma.payment.count({ where: { bookingId: replay.id } })).toBe(1);
  });
  it('appends a note once across replays and rejects changed content', async () => {
    const booking = await service.createManualBooking(user, draft());
    const event = { requestKey: randomUUID(), bookingId: booking.id, kind: 'note' as const, note: 'Arriving with team' };
    await service.recordOfflineEvent(user, event); await service.recordOfflineEvent(user, event);
    expect((await service.getBooking(user, booking.id)).notes).toBe('Arriving with team');
    await expect(service.recordOfflineEvent(user, { ...event, note: 'Changed' })).rejects.toBeDefined();
  });
  it('records manual attendance without collecting the unpaid balance', async () => {
    const grant = await service.prepareOffline(user, venueId, randomUUID());
    const booking = await service.createManualBooking(user, { ...draft(), startsAt: new Date(Date.now() - 1000).toISOString(), offlineGrant: grant.token });
    const event = { requestKey: randomUUID(), bookingId: booking.id, kind: 'attendance' as const };
    await service.recordOfflineEvent(user, event); await service.recordOfflineEvent(user, event);
    const saved = await service.getBooking(user, booking.id);
    expect(saved.checkedInAt).toBeTruthy(); expect(saved.money.outstanding).toBe(50000);
    expect(await prisma.payment.count({ where: { bookingId: booking.id } })).toBe(1);
  });
  it('rechecks revoked staff collection permission even with a previously valid grant', async () => {
    const staffRow = await prisma.user.create({ data: {name:'Offline staff',roles:['staff']} });
    const staff = {id:staffRow.id,name:staffRow.name,phone:'',roles:['staff']} as AuthenticatedUser;
    const member = await prisma.staffMember.create({data:{userId:staff.id,ownerId:user.id,createdById:user.id,venueIds:[venueId],permissions:['bookings.view','bookings.create','payments.record']}});
    const grant = await service.prepareOffline(staff,venueId,randomUUID());
    expect(grant.cashAllowed).toBe(true);
    await prisma.staffMember.update({where:{id:member.id},data:{permissions:['bookings.view','bookings.create']}});
    await expect(service.createManualBooking(staff,{...draft(),offlineGrant:grant.token})).rejects.toMatchObject({status:403});
    expect(await prisma.booking.count({where:{venueId}})).toBe(0);
  });
  it('allows a rejected slot to move with the same identity and one deposit, but never changes an accepted operation', async () => {
    const occupied = await service.createManualBooking(user,draft());
    const dto = {...draft(),startsAt:occupied.startsAt};
    await expect(service.createManualBooking(user,dto)).rejects.toBeDefined();
    expect((await service.offlineBookingOutcome(user,dto.requestKey!)).booking).toBeNull();
    const moved = {...dto,startsAt:new Date(Date.parse(dto.startsAt)+3600_000).toISOString()};
    const booking = await service.createManualBooking(user,moved);
    expect((await service.offlineBookingOutcome(user,dto.requestKey!)).booking?.id).toBe(booking.id);
    await expect(service.createManualBooking(user,dto)).rejects.toMatchObject({response:expect.objectContaining({code:'OPERATION_KEY_REUSED'})});
    expect(await prisma.payment.count({where:{bookingId:booking.id}})).toBe(1);
  });

  it('retrieves acknowledged outcomes without repeating cash and isolates the actor', async () => {
    const dto = draft(); const booking = await service.createManualBooking(user, dto);
    expect((await service.offlineOperationOutcome(user,dto.requestKey!,'create')).booking?.id).toBe(booking.id);
    const event = {requestKey:randomUUID(),bookingId:booking.id,kind:'note' as const,note:'Saved once'};
    await service.recordOfflineEvent(user,event);
    expect((await service.offlineOperationOutcome(user,event.requestKey,'note')).booking?.notes).toBe('Saved once');
    const paymentKey = randomUUID();
    await service.addManualPayment(user,booking.id,10000,'cash',paymentKey);
    expect((await service.offlineOperationOutcome(user,paymentKey,'payment')).booking?.money.outstanding).toBe(40000);
    expect((await service.offlineOperationOutcome({...user,id:randomUUID()},event.requestKey,'note')).booking).toBeNull();
    expect(await prisma.payment.count({where:{bookingId:booking.id}})).toBe(2);
  });

  it('recovers a staff cash receipt after collection permission is revoked', async () => {
    const booking = await service.createManualBooking(user,draft());
    const row = await prisma.user.create({data:{name:'Receipt staff',roles:['staff']}});
    const staff = {id:row.id,name:row.name,phone:'',roles:['staff']} as AuthenticatedUser;
    const member = await prisma.staffMember.create({data:{userId:row.id,ownerId:user.id,createdById:user.id,venueIds:[venueId],permissions:['bookings.view','payments.record']}});
    const key = randomUUID();
    await service.addManualPayment(staff,booking.id,10000,'cash',key);
    await prisma.staffMember.update({where:{id:member.id},data:{permissions:['bookings.view']}});
    await expect(service.addManualPayment(staff,booking.id,10000,'cash',key)).rejects.toMatchObject({status:403});
    expect((await service.offlineOperationOutcome(staff,key,'payment')).booking?.money.outstanding).toBe(40000);
    expect(await prisma.payment.count({where:{bookingId:booking.id}})).toBe(2);
  });

});
