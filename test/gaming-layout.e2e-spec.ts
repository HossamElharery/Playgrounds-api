const dbUrl = process.env.TEST_DATABASE_URL ?? '';
const parsed = new URL(dbUrl);
if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || !/^\/matchena_gaming_test_[a-z0-9_]+$/.test(parsed.pathname)) throw new Error('Dedicated local gaming test database required');
process.env.DATABASE_URL = dbUrl;
import { randomUUID } from 'crypto';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { OwnerBookingsService } from '../src/modules/owner/owner-bookings.service';
import { LedgerService } from '../src/modules/finance/ledger.service';
import { CommissionService } from '../src/modules/finance/commission.service';
import { GamingLayoutService } from '../src/modules/owner/gaming/gaming-layout.service';
import type { AuthenticatedUser } from '../src/common/types/authenticated-user.interface';
jest.setTimeout(120000);
describe('gaming layout real PostgreSQL B05/A01/A03', () => {
  const prisma = new PrismaService(); const service = new GamingLayoutService(prisma);
  let user: AuthenticatedUser; let venueId: string; let unitId: string; let document: Record<string, any>;
  beforeAll(async () => {
    await prisma.countryConfig.upsert({ where: { code: 'EG' }, create: { code: 'EG', nameEn: 'Egypt', nameAr: 'مصر', currency: 'EGP', phoneCallingCode: '+20', timezone: 'Africa/Cairo', weekendDays: [5,6], paymentMethods: ['cash'] }, update: {} });
    const owner = await prisma.user.create({ data: { name: 'Gaming fixture', phone: '+201099990001', roles: ['owner'] } });
    user = { id: owner.id, roles: ['owner'], name: owner.name, phone: owner.phone! };
    const sport = await prisma.sportCategory.create({ data: { slug: 'gaming-layout-fixture', nameEn: 'Gaming', nameAr: 'ألعاب', icon: 'gamepad', accentColor: '#00ff00', activityKind: 'gaming-station' } });
    const venue = await prisma.venue.create({ data: { slug: 'gaming-layout-fixture', ownerId: owner.id, nameEn: 'Gaming', nameAr: 'ألعاب', lat: 30, lng: 31, geohash: 'sv8', status: 'active', approvedAt: new Date(), weeklyHours: Object.fromEntries([0,1,2,3,4,5,6].map(day => [String(day), { open: '00:00', close: '23:59', closed: false }])) } }); venueId = venue.id;
    const unit = await prisma.court.create({ data: { venueId, sportId: sport.id, name: 'PS5' } }); unitId = unit.id;
    document = { schemaVersion: 1, venueId, units: 'm', floors: [0,1,2].map(i => ({ id: `f${i}`, name: `Floor ${i}`, width: 20, depth: 12, elevation: i * 3, rooms: [] })), placements: [{ id: 'p1', floorId: 'f0', unitId: unit.id, assetKey: 'ps5', x: 2, z: 2, rotation: 0, width: 1, depth: 1, height: 1 }] };
  });
  afterAll(async () => { await prisma.$disconnect(); });
  it('B05 two initial draft saves cannot overwrite each other', async () => {
    const dto = { venueId, baseRevision: 0, draftVersion: 0, document };
    const results = await Promise.allSettled([service.save(user, dto), service.save(user, dto)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.getStatus()).toBe(409);
  });
  it('B05 two publishers produce one revision; lost response retry returns original', async () => {
    const a = { venueId, baseRevision: 0, draftVersion: 1, requestKey: randomUUID() }; const b = { ...a, requestKey: randomUUID() };
    const results = await Promise.allSettled([service.publish(user, a), service.publish(user, b)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const dto = results[0].status === 'fulfilled' ? a : b;
    expect((await service.publish(user, dto)).revision).toBe(1);
    expect(await prisma.gamingLayoutRevision.count({ where: { venueId } })).toBe(1);
    await expect(service.publish(user, { ...dto, baseRevision: 1 })).rejects.toMatchObject({ status: 409 });
    expect((await service.read(user, venueId)).published).toEqual(document);
  });
  it('A01 rejects suspended venue mutations', async () => {
    await prisma.venue.update({ where: { id: venueId }, data: { status: 'suspended' } });
    await expect(service.save(user, { venueId, baseRevision: 1, draftVersion: 1, document })).rejects.toMatchObject({ status: 403 });
    await prisma.venue.update({ where: { id: venueId }, data: { status: 'active' } });
  });
  it('C01 server Now ignores a forged clock, preserves seconds, and retries the same booking', async () => {
    const commission = new CommissionService(prisma, {} as never);
    const bookings = new OwnerBookingsService(prisma, new LedgerService(prisma, commission), commission, { create: async () => null } as never);
    const requestKey = randomUUID(); const before = Date.now();
    const dto = { venueId, courtId: unitId, startsAt: 'forged-client-time', startMode: 'now' as const, requestKey, durationMinutes: 7, priceAmount: 1400 };
    const result = await bookings.createManualBooking(user,dto);
    const row = await prisma.booking.findUniqueOrThrow({ where: { id: result.id } });
    expect(row.slotStart.getTime()).toBeGreaterThanOrEqual(before);
    expect(row.slotStart.getTime()).toBeLessThanOrEqual(Date.now());
    expect(row.slotEnd.getTime() - row.slotStart.getTime()).toBe(420000);
    const replay = await bookings.createManualBooking(user,{ ...dto, startsAt: 'another-forged-clock' });
    expect(replay.id).toBe(result.id); expect(await prisma.booking.count({ where: { manualRequestKey: requestKey } })).toBe(1);
  });
  it('A03 refuses another owner even with a guessed venue ID', async () => {
    await expect(service.read({ ...user, id: randomUUID() }, venueId)).rejects.toMatchObject({ status: 403 });
  });
});
