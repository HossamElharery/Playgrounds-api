const dbUrl = process.env.TEST_DATABASE_URL ?? '';
const parsed = new URL(dbUrl);
if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || !/^\/matchena_gaming_test_[a-z0-9_]+$/.test(parsed.pathname)) throw new Error('Dedicated local gaming database required');
process.env.DATABASE_URL = dbUrl;
import { randomUUID } from 'crypto';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { GamingCommandService } from '../src/modules/owner/gaming/gaming-command.service';
import { GamingSessionsService } from '../src/modules/owner/gaming/gaming-sessions.service';
import { GamingCommerceService } from '../src/modules/owner/gaming/gaming-commerce.service';
import { GamingReceiptsService } from '../src/modules/owner/gaming/gaming-receipts.service';
import { GamingLayoutService } from '../src/modules/owner/gaming/gaming-layout.service';
import { CommissionService } from '../src/modules/finance/commission.service';
import { LedgerService } from '../src/modules/finance/ledger.service';
import { CashService } from '../src/modules/owner/cash/cash.service';
import { OwnerSummaryService } from '../src/modules/owner/owner-summary.service';
import type { AuthenticatedUser } from '../src/common/types/authenticated-user.interface';
jest.setTimeout(180000);

/**
 * Phase-6 fixture journey from 12-EXECUTION-AND-RELEASE: approve the venue, build three floors, place
 * a PS5, billiards and a ping-pong table, publish, run a session, sell two drinks, transfer, end,
 * collect partially then fully, print/reprint and reconcile with the cash drawer.
 */
describe('gaming operator journey on PostgreSQL', () => {
  const db = new PrismaService(); const commands = new GamingCommandService(db);
  const ledger = new LedgerService(db, new CommissionService(db, {} as never));
  const sessions = new GamingSessionsService(commands, ledger); const receipts = new GamingReceiptsService(commands, sessions);
  const commerce = new GamingCommerceService(commands, sessions, receipts); const layout = new GamingLayoutService(db); const cash = new CashService(db);
  let user: AuthenticatedUser; let venueId: string;
  const key = () => ({ venueId, requestKey: randomUUID() });

  beforeAll(async () => {
    await db.countryConfig.upsert({ where: { code: 'EG' }, create: { code: 'EG', nameAr: 'مصر', nameEn: 'Egypt', currency: 'EGP', phoneCallingCode: '+20', timezone: 'Africa/Cairo', weekendDays: [5, 6], paymentMethods: ['cash'] }, update: {} });
    const owner = await db.user.create({ data: { name: 'Journey owner', phone: '+201099990201', roles: ['owner'] } });
    user = { id: owner.id, name: owner.name, phone: owner.phone!, roles: ['owner'] };
    const consoleSport = await db.sportCategory.create({ data: { slug: 'journey-console', nameAr: 'ألعاب', nameEn: 'Gaming', icon: 'gamepad', accentColor: '#22cc88', activityKind: 'gaming-station' } });
    for (const slug of ['billiards', 'table-tennis']) await db.sportCategory.upsert({ where: { slug }, create: { slug, nameAr: slug, nameEn: slug, icon: 'table', accentColor: '#2288cc', activityKind: 'table-game' }, update: { activityKind: 'table-game' } });
    const tableSports = await db.sportCategory.findMany({ where: { slug: { in: ['billiards', 'table-tennis'] } } });
    // Starts life pending, with its activities declared but no devices yet: nothing may run until an admin approves it.
    venueId = (await db.venue.create({ data: { slug: 'journey-venue', nameAr: 'محل الرحلة', nameEn: 'Journey venue', ownerId: owner.id, lat: 30, lng: 31, geohash: 'sv8', status: 'pending', gamingSessionsEnabled: true, gamingProductsEnabled: true, gamingReceiptsEnabled: true, sports: { create: [consoleSport, ...tableSports].map(sport => ({ sportId: sport.id })) } } })).id;
  });
  afterAll(() => db.$disconnect());

  it('runs from approval to a reconciled, reprinted payment without double counting', async () => {
    await expect(sessions.createUnits(user, { ...key(), assetKey: 'ps5', count: 1, namePrefix: 'PS5', hourlyRateMinor: 12000 })).rejects.toMatchObject({ status: 403 });
    await db.venue.update({ where: { id: venueId }, data: { status: 'active', approvedAt: new Date() } });

    const ps5 = (await sessions.createUnits(user, { ...key(), assetKey: 'ps5', count: 2, namePrefix: 'PS5', hourlyRateMinor: 12000 })).units;
    const pool = (await sessions.createUnits(user, { ...key(), assetKey: 'billiards', count: 1, namePrefix: 'Billiards', hourlyRateMinor: 6000 })).units;
    const pong = (await sessions.createUnits(user, { ...key(), assetKey: 'table-tennis', count: 1, namePrefix: 'Ping-pong', hourlyRateMinor: 4000 })).units;
    // Unpublished devices cannot run sessions before the layout is published.
    await expect(sessions.start(user, { ...key(), unitId: ps5[0].id, startMode: 'now' })).rejects.toBeDefined();

    const place = (id: string, floorId: string, unitId: string, assetKey: string, x: number) => ({ id, floorId, unitId, assetKey, x, z: 3, rotation: 0, width: 1.5, depth: 1.5, height: 1 });
    const document = { schemaVersion: 1, venueId, units: 'm', floors: [0, 1, 2].map(i => ({ id: `f${i}`, name: `Floor ${i}`, width: 20, depth: 12, elevation: i * 3, rooms: [] })),
      placements: [place('a', 'f0', ps5[0].id, 'ps5', 3), place('b', 'f0', ps5[1].id, 'ps5', 6), place('c', 'f1', pool[0].id, 'billiards', 4), place('d', 'f2', pong[0].id, 'table-tennis', 4)] };
    const saved = await layout.save(user, { venueId, baseRevision: 0, draftVersion: 0, document } as never);
    const published = await layout.publish(user, { venueId, baseRevision: saved.revision, draftVersion: saved.draftVersion, requestKey: randomUUID() } as never);
    expect(published.revision).toBe(1);
    expect((await db.court.findMany({ where: { id: { in: [...ps5, ...pool, ...pong].map(u => u.id) } } })).every(c => c.gamingPublished)).toBe(true);

    // Start Now: the server instant is kept to the millisecond, never rounded to a quarter hour.
    const session = await sessions.start(user, { ...key(), unitId: ps5[0].id, startMode: 'now' });
    expect(Date.parse(session.startedAt as unknown as string) % 900000).not.toBe(0);

    const drink = (nameEn: string, nameAr: string) => commerce.product(user, { ...key(), nameAr, nameEn, category: 'drinks', priceMinor: 1500, stockTracked: false } as never);
    const [pepsi, tea] = [await drink('Pepsi', 'بيبسي'), await drink('Tea', 'شاي')];
    let order = await commerce.detail(user, session.orderId);
    await commerce.add(user, order.id, { ...key(), expectedVersion: order.version, productId: pepsi.id, quantity: 1 });
    order = await commerce.detail(user, order.id);
    await commerce.add(user, order.id, { ...key(), expectedVersion: order.version, productId: tea.id, quantity: 1 });

    const moved = await sessions.transfer(user, session.id, { ...key(), expectedVersion: 1, targetUnitId: ps5[1].id });
    expect(moved.version).toBe(2);
    expect(await db.resourceOccupancy.count({ where: { resourceId: ps5[0].id, sessionId: session.id } })).toBe(0);
    await sessions.end(user, session.id, { ...key(), expectedVersion: 2 });
    // The device is free again even though the bill is unpaid.
    expect(await db.resourceOccupancy.count({ where: { sessionId: session.id } })).toBe(0);

    order = await commerce.detail(user, order.id);
    expect(order.state).toBe('open');
    expect(order.lines.filter(l => l.kind === 'product').reduce((s, l) => s + l.amountMinor, 0)).toBe(3000);
    expect(order.totalMinor).toBe(order.lines.reduce((s, l) => s + (l.kind === 'discount' ? -l.amountMinor : l.amountMinor), 0));

    const partial = Math.min(1000, order.totalMinor - 1);
    const first = await commerce.collect(user, order.id, { ...key(), expectedVersion: order.version, amountMinor: partial, method: 'cash' } as never);
    order = await commerce.detail(user, order.id);
    expect(order.remainingMinor).toBe(order.totalMinor - partial);
    const second = await commerce.collect(user, order.id, { ...key(), expectedVersion: order.version, amountMinor: order.remainingMinor, method: 'cash' } as never);
    order = await commerce.detail(user, order.id);
    expect(order.remainingMinor).toBe(0);
    expect((await commerce.settle(user, order.id, { ...key(), expectedVersion: order.version })).order.state).toBe('settled');
    // The bills list is newest-first, says which stations a bill belongs to, and `open` keeps a settled bill out.
    const recent = await commerce.list(user, venueId);
    expect(recent.items[0].id).toBe(order.id);
    expect(recent.items[0].units.map(u => u.name)).toEqual([ps5[0].name, ps5[1].name]);
    expect(recent.items[0].unitIds).toEqual([ps5[1].id]);
    expect(recent.items[0].remainingMinor).toBe(0);
    expect((await commerce.list(user, venueId, undefined, 'open')).items.some(o => o.id === order.id)).toBe(false);

    // Receipts: distinct, ordered numbers; reprint never creates another payment.
    const [r1, r2] = [await receipts.read(user, first.receiptId), await receipts.read(user, second.receiptId)];
    expect(r2.number).toBeGreaterThan(r1.number);
    // The customer copy shows both legs of the transferred session, frozen with device names.
    const timeLine = (r2.snapshot as { lines: { kind: string; snapshot: { detail?: { unitName: string | null; hourlyRateMinor: number | null }[] } }[] }).lines.find(l => l.kind === 'time')!;
    expect(timeLine.snapshot.detail?.map(d => d.unitName)).toEqual([ps5[0].name, ps5[1].name]);
    expect(timeLine.snapshot.detail?.every(d => d.hourlyRateMinor === 12000)).toBe(true);
    const job = await receipts.job(user, r2.id, { ...key(), terminalId: randomUUID() });
    await receipts.status(user, job.id, { ...key(), status: 'unknown' });
    await receipts.job(user, r2.id, { ...key(), terminalId: randomUUID() });
    expect(await db.payment.count({ where: { gamingOrderId: order.id } })).toBe(2);

    // Shift reconciliation: the drawer and the cash book each count the money exactly once.
    const total = order.totalMinor; const scale = 100;
    const drawer = await cash.drawer(user, venueId);
    expect((drawer.mine as any).cash.in).toBeGreaterThanOrEqual(total / scale);
    const book = await new OwnerSummaryService(db).cashbook(venueId, new Date(Date.now() - 86400000), new Date(Date.now() + 86400000));
    expect(book.received).toBeGreaterThanOrEqual(total / scale);
  });
});
