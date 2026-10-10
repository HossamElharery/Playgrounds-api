const dbUrl = process.env.TEST_DATABASE_URL ?? '';
const parsed = new URL(dbUrl);
if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || !/^\/matchena_gaming_test_[a-z0-9_]+$/.test(parsed.pathname)) throw new Error('Dedicated local gaming test database required');
process.env.DATABASE_URL = dbUrl;
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { GamingLayoutService } from '../src/modules/owner/gaming/gaming-layout.service';
import { activateGamingDefaults } from '../src/modules/owner/gaming/gaming-activation';
import type { AuthenticatedUser } from '../src/common/types/authenticated-user.interface';
jest.setTimeout(120000);

describe('gaming defaults on real PostgreSQL — approval switches features on, first look generates the hall', () => {
  const prisma = new PrismaService();
  const layouts = new GamingLayoutService(prisma);
  let user: AuthenticatedUser; let venueId: string; let sportsVenueId: string; let units: string[] = [];
  beforeAll(async () => {
    await prisma.countryConfig.upsert({ where: { code: 'EG' }, create: { code: 'EG', nameEn: 'Egypt', nameAr: 'مصر', currency: 'EGP', phoneCallingCode: '+20', timezone: 'Africa/Cairo', weekendDays: [5, 6], paymentMethods: ['cash'] }, update: {} });
    const owner = await prisma.user.create({ data: { name: 'Defaults fixture', phone: '+201099990111', roles: ['owner'], preferredLang: 'ar' } });
    user = { id: owner.id, roles: ['owner'], name: owner.name, phone: owner.phone! };
    const ps = await prisma.sportCategory.create({ data: { slug: 'defaults-ps', nameEn: 'PS', nameAr: 'بلايستيشن', icon: 'gamepad', accentColor: '#0f0', activityKind: 'gaming-station' } });
    const pitch = await prisma.sportCategory.create({ data: { slug: 'defaults-pitch', nameEn: 'Pitch', nameAr: 'ملعب', icon: 'ball', accentColor: '#0f0', activityKind: 'sport' } });
    const mk = (slug: string) => prisma.venue.create({ data: { slug, ownerId: owner.id, nameEn: slug, nameAr: slug, lat: 30, lng: 31, geohash: 'sv8', status: 'active', approvedAt: new Date() } });
    venueId = (await mk('defaults-hall')).id; sportsVenueId = (await mk('defaults-sports')).id;
    await prisma.venueSport.create({ data: { venueId, sportId: ps.id } });
    await prisma.venueSport.create({ data: { venueId: sportsVenueId, sportId: pitch.id } });
    for (const [name, tier] of [['Station 1', 'standard'], ['Station 2', 'standard'], ['Room A', 'vip-big-screen']]) {
      units.push((await prisma.court.create({ data: { venueId, sportId: ps.id, name, gamingConfig: { consoleType: 'ps5', seats: 4, roomTier: tier } } })).id);
    }
    await prisma.court.create({ data: { venueId: sportsVenueId, sportId: pitch.id, name: 'Pitch 1' } });
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('approval defaults turn sessions, products and receipts on for a gaming venue only', async () => {
    expect(await activateGamingDefaults(prisma, venueId)).toBe(true);
    expect(await prisma.venue.findUniqueOrThrow({ where: { id: venueId }, select: { gamingSessionsEnabled: true, gamingProductsEnabled: true, gamingReceiptsEnabled: true } })).toEqual({ gamingSessionsEnabled: true, gamingProductsEnabled: true, gamingReceiptsEnabled: true });
    expect(await activateGamingDefaults(prisma, sportsVenueId)).toBe(false);
    expect((await prisma.venue.findUniqueOrThrow({ where: { id: sportsVenueId } })).gamingSessionsEnabled).toBe(false);
  });

  it('the first read publishes one generated layout covering every unit; later reads change nothing', async () => {
    const first = await layouts.read(user, venueId);
    expect(first.revision).toBe(1);
    const doc = first.published as any;
    expect(doc.floors[0].name).toBe('الدور الأرضي');
    expect(doc.placements.filter((p: any) => p.unitId).map((p: any) => p.unitId).sort()).toEqual([...units].sort());
    expect(doc.floors[0].rooms).toHaveLength(1);
    const again = await Promise.all([layouts.read(user, venueId), layouts.read(user, venueId)]);
    expect(again.map(r => r.revision)).toEqual([1, 1]);
    expect(await prisma.gamingLayoutRevision.count({ where: { venueId } })).toBe(1);
    expect((await prisma.court.findMany({ where: { id: { in: units } }, select: { gamingRoomId: true } })).filter(c => c.gamingRoomId).length).toBe(1);
  });

  it('never replaces a layout the owner already published or is drafting', async () => {
    const before = (await layouts.read(user, venueId)).published;
    const owner2 = await prisma.user.create({ data: { name: 'Draft owner', phone: '+201099990112', roles: ['owner'] } });
    const sport = await prisma.sportCategory.findFirstOrThrow({ where: { slug: 'defaults-ps' } });
    const v2 = await prisma.venue.create({ data: { slug: 'defaults-draft', ownerId: owner2.id, nameEn: 'd', nameAr: 'd', lat: 30, lng: 31, geohash: 'sv8', status: 'active', approvedAt: new Date() } });
    await prisma.venueSport.create({ data: { venueId: v2.id, sportId: sport.id } });
    await prisma.court.create({ data: { venueId: v2.id, sportId: sport.id, name: 'X' } });
    await prisma.gamingLayout.create({ data: { venueId: v2.id, draftVersion: 1, draft: { keep: 'me' } } });
    const u2: AuthenticatedUser = { id: owner2.id, roles: ['owner'], name: owner2.name, phone: owner2.phone! };
    const r = await layouts.read(u2, v2.id);
    expect(r.revision).toBe(0);
    expect(r.published).toBeNull();
    expect(r.draft).toEqual({ keep: 'me' });
    expect((await layouts.read(user, venueId)).published).toEqual(before);
  });

  it('a mixed venue gets a hall plan for its gaming units only, never for its courts', async () => {
    const owner = await prisma.user.create({ data: { name: 'Mixed owner', phone: '+201099990113', roles: ['owner'] } });
    const ps = await prisma.sportCategory.findFirstOrThrow({ where: { slug: 'defaults-ps' } });
    const pitch = await prisma.sportCategory.findFirstOrThrow({ where: { slug: 'defaults-pitch' } });
    const v = await prisma.venue.create({ data: { slug: 'defaults-mixed', ownerId: owner.id, nameEn: 'm', nameAr: 'm', lat: 30, lng: 31, geohash: 'sv8', status: 'active', approvedAt: new Date() } });
    await prisma.venueSport.createMany({ data: [{ venueId: v.id, sportId: ps.id }, { venueId: v.id, sportId: pitch.id }] });
    const station = await prisma.court.create({ data: { venueId: v.id, sportId: ps.id, name: 'PS5 1', gamingConfig: { consoleType: 'ps5', roomTier: 'standard', seats: 4 } } });
    await prisma.court.create({ data: { venueId: v.id, sportId: pitch.id, name: 'Pitch 1' } });
    const u: AuthenticatedUser = { id: owner.id, roles: ['owner'], name: owner.name, phone: owner.phone! };
    const doc = (await layouts.read(u, v.id)).published as any;
    expect(doc.placements.filter((p: any) => p.unitId).map((p: any) => p.unitId)).toEqual([station.id]);
  });

  it('a sports-only venue is refused instead of getting a hall', async () => {
    await expect(layouts.read(user, sportsVenueId)).rejects.toMatchObject({ status: 403 });
  });
});
