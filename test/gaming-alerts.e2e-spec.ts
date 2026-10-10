const dbUrl = process.env.TEST_DATABASE_URL ?? '';
const parsed = new URL(dbUrl);
if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || !/^\/matchena_gaming_test_[a-z0-9_]+$/.test(parsed.pathname)) throw new Error('Dedicated local gaming database required');
process.env.DATABASE_URL = dbUrl;
import { randomUUID } from 'crypto';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { GamingAlertsService } from '../src/modules/owner/gaming/gaming-alerts.service';
import { GamingCommandService } from '../src/modules/owner/gaming/gaming-command.service';
import { GamingSessionsService } from '../src/modules/owner/gaming/gaming-sessions.service';
import { VenuesService } from '../src/modules/venues/venues.service';
import { ManagementService } from '../src/modules/admin/management.service';
import { CommissionService } from '../src/modules/finance/commission.service';
import { LedgerService } from '../src/modules/finance/ledger.service';
jest.setTimeout(120000);

describe('F07 meaningful alerts without spam (PostgreSQL, no external transports)', () => {
  const db = new PrismaService();
  const emitter = { emitToUser: jest.fn(), emitToRoom: jest.fn(), disconnectUser: jest.fn(), revokeRoomAccess: jest.fn() };
  const transport = { sendToUser: jest.fn().mockResolvedValue(undefined), send: jest.fn().mockResolvedValue(undefined) };
  const notifications = new NotificationsService(db, emitter as never, {} as never, transport as never, transport as never);
  const alerts = new GamingAlertsService(db, notifications);
  const sessions = new GamingSessionsService(new GamingCommandService(db), new LedgerService(db, new CommissionService(db, {} as never)));
  let ownerId: string; let adminId: string; let venueId: string; let unitId: string; let sportId: string;

  beforeAll(async () => {
    await db.countryConfig.upsert({ where: { code: 'EG' }, create: { code: 'EG', nameAr: 'مصر', nameEn: 'Egypt', currency: 'EGP', phoneCallingCode: '+20', timezone: 'Africa/Cairo', weekendDays: [5, 6], paymentMethods: ['cash'] }, update: {} });
    const owner = await db.user.create({ data: { name: 'Alerts owner', phone: '+201099990101', roles: ['owner'] } });
    const admin = await db.user.create({ data: { name: 'Alerts admin', phone: '+201099990102', roles: ['admin'] } });
    ownerId = owner.id; adminId = admin.id;
    const sport = await db.sportCategory.create({ data: { slug: 'alerts-fixture', nameAr: 'ألعاب', nameEn: 'Gaming', icon: 'gamepad', accentColor: '#22cc88', activityKind: 'gaming-station' } });
    sportId = sport.id;
    const venue = await db.venue.create({ data: { slug: 'alerts-fixture', nameAr: 'محل التنبيهات', nameEn: 'Alerts venue', ownerId, lat: 30, lng: 31, geohash: 'sv8', status: 'active', approvedAt: new Date(), gamingSessionsEnabled: true, gamingProductsEnabled: true, gamingReceiptsEnabled: true } });
    venueId = venue.id;
    unitId = (await db.court.create({ data: { venueId, sportId, name: 'PS5 A', pricingRules: { create: { label: 'base', daysOfWeek: [], startTime: '00:00', endTime: '24:00', priceAmount: 12000, currency: 'EGP' } } } })).id;
  });
  afterAll(() => db.$disconnect());
  const count = (prefix: string) => db.notification.count({ where: { dedupKey: { startsWith: prefix } } });

  it('three failed prints in the window alert the owner once; the admin hears nothing below the pattern threshold', async () => {
    const order = await db.gamingOrder.create({ data: { venueId, currency: 'EGP', createdById: ownerId } });
    const receipt = await db.receiptDocument.create({ data: { venueId, orderId: order.id, number: 1, kind: 'bill', snapshot: {} } });
    for (let i = 0; i < 2; i++) await db.gamingPrintJob.create({ data: { receiptId: receipt.id, actorId: ownerId, terminalId: 't1', status: 'failed' } });
    await alerts.printFailures(); expect(await count('gaming-print:')).toBe(0);
    await db.gamingPrintJob.create({ data: { receiptId: receipt.id, actorId: ownerId, terminalId: 't1', status: 'failed' } });
    await alerts.printFailures(); await alerts.printFailures();
    expect(await count('gaming-print:')).toBe(1);
    expect(await count('gaming-print-admin:')).toBe(0);
    for (let i = 0; i < 7; i++) await db.gamingPrintJob.create({ data: { receiptId: receipt.id, actorId: ownerId, terminalId: 't1', status: 'failed' } });
    await alerts.printFailures(); await alerts.printFailures();
    expect(await count('gaming-print-admin:')).toBe(1);
  });

  it('low tracked stock produces one daily owner reminder, not one per sale', async () => {
    await db.gamingProduct.create({ data: { venueId, nameAr: 'بيبسي', nameEn: 'Pepsi', priceMinor: 1500, currency: 'EGP', stockTracked: true, availableQuantity: 2 } });
    await db.gamingProduct.create({ data: { venueId, nameAr: 'شيبسي', nameEn: 'Chips', priceMinor: 1000, currency: 'EGP', stockTracked: false, availableQuantity: 0 } });
    await alerts.lowStock();
    await db.gamingProduct.updateMany({ where: { venueId, nameEn: 'Pepsi' }, data: { availableQuantity: 1 } });
    await alerts.lowStock();
    expect(await count('gaming-stock:')).toBe(1);
  });

  it('a running session that overlaps the next booking prompts staff once and changes neither record', async () => {
    const now = Date.now();
    const booking = await db.booking.create({ data: { code: randomUUID(), venueId, courtId: unitId, userId: ownerId, slotStart: new Date(now + 5 * 60000), slotEnd: new Date(now + 65 * 60000), baseAmount: 1000, totalAmount: 1000, status: 'confirmed', source: 'manual' } });
    const user = { id: ownerId, name: 'Alerts owner', phone: '+201099990101', roles: ['owner'] } as never;
    const session = await sessions.start(user, { venueId, requestKey: randomUUID(), unitId, startMode: 'now', durationMinutes: 3 });
    // The device is free again by the time the booking starts, so there is nothing to warn about yet.
    await alerts.threatenedBookings();
    expect(await count('gaming-next-booking:')).toBe(0);
    // Customer keeps playing past the planned end: now the same booking is threatened.
    await db.usageSession.update({ where: { id: session.id }, data: { expectedEnd: new Date(Date.parse(session.startedAt as unknown as string) + 1) } });
    await alerts.threatenedBookings(); await alerts.threatenedBookings();
    expect(await count('gaming-next-booking:')).toBe(1);
    expect((await db.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('confirmed');
  });

  it('consistent order payments raise no reconciliation alert; stuck events alert admins once per window', async () => {
    await alerts.financialMismatch();
    expect(await count('gaming-mismatch:')).toBe(0);
    await db.gamingOutbox.create({ data: { venueId, entityId: venueId, version: 1, type: 'order.updated', attempts: 6 } });
    await alerts.stuckEvents(); await alerts.stuckEvents();
    expect(await count('gaming-outbox:')).toBe(1);
    expect(await db.notification.count({ where: { userId: adminId, dedupKey: { startsWith: 'gaming-outbox:' } } })).toBe(1);
  });

  it('R01 a new venue asks each admin for review once, and approving or suspending tells only that venue owner', async () => {
    const venues = new VenuesService(db, notifications);
    const created = await venues.create(ownerId, { nameEn: 'Review me', nameAr: 'راجعني', lat: 30, lng: 31, countryCode: 'EG' } as never);
    await new Promise(r => setTimeout(r, 300));
    expect(await count(`venue-review:${created.id}:`)).toBe(1);
    expect(await db.notification.count({ where: { userId: adminId, dedupKey: `venue-review:${created.id}:${adminId}` } })).toBe(1);

    const management = new ManagementService(db, undefined, notifications);
    await db.venue.update({ where: { id: created.id }, data: { status: 'pending' } });
    await management.updateVenue(adminId, created.id, { status: 'suspended', reason: 'Documents missing' } as never);
    const suspended = await db.notification.findFirst({ where: { userId: ownerId, dedupKey: { startsWith: `venue-status:${created.id}:suspended` } } });
    expect(suspended?.titleEn).toContain('suspended');
    // An edit that does not change the status stays silent.
    await management.updateVenue(adminId, created.id, { address: 'New address', reason: 'Typo' } as never);
    expect(await count(`venue-status:${created.id}:`)).toBe(1);
    // Nobody else hears about it.
    expect(await db.notification.count({ where: { userId: adminId, dedupKey: { startsWith: 'venue-status:' } } })).toBe(0);
  });
});
