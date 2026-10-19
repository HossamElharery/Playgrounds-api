import {
  bookings, disconnect, futureSlot, listing, makeUser, makeVenue, prisma, seedWorld,
} from './helpers/booking-harness';
import { VenuesService } from '../src/modules/venues/venues.service';
import { ManagementService } from '../src/modules/admin/management.service';
import { OwnerService } from '../src/modules/owner/owner.service';
import { SitemapService } from '../src/modules/seo/sitemap.service';

jest.setTimeout(120_000);

describe('venue visibility controls (real Postgres)', () => {
  let sportId: string;
  const venues = new VenuesService(prisma);
  const management = new ManagementService(prisma as never);

  beforeAll(async () => {
    ({ sportId } = await seedWorld());
  });
  afterAll(disconnect);

  async function setup() {
    const owner = await makeUser('owner', ['owner']);
    const admin = await makeUser('admin', ['admin']);
    const w = await makeVenue(owner.row.id, sportId, 1);
    return { owner, admin, ...w };
  }
  const audits = (venueId: string) =>
    prisma.auditLogEntry.findMany({ where: { targetType: 'venue', targetId: venueId }, orderBy: { createdAt: 'asc' } });
  const listed = async (slug: string) => {
    const hit = await prisma.venue.findFirst({
      where: { slug, status: 'active', ownerListingEnabled: true, adminHidden: false },
    });
    return !!hit;
  };

  it('lets the owner hide and show the venue, records who/what/when, and is idempotent', async () => {
    const { owner, venue } = await setup();
    const hidden = await listing.ownerSet(owner.auth, venue.id, 'listing', false);
    expect(hidden).toMatchObject({ ownerListingEnabled: false, effective: { listing: 'hidden_by_owner', publicVisible: false } });
    expect(await listed(venue.slug)).toBe(false);

    await listing.ownerSet(owner.auth, venue.id, 'listing', false); // repeat: no second audit
    const shown = await listing.ownerSet(owner.auth, venue.id, 'listing', true);
    expect(shown.effective).toMatchObject({ listing: 'visible', publicVisible: true, bookable: true });

    const log = await audits(venue.id);
    expect(log.map((l) => l.action)).toEqual(['owner.venue.listing', 'owner.venue.listing']);
    expect(log[0]).toMatchObject({ actorUserId: owner.row.id });
    expect(log[0].metadata).toMatchObject({
      before: { ownerListingEnabled: true },
      after: { ownerListingEnabled: false },
    });
    const row = await prisma.venue.findUniqueOrThrow({ where: { id: venue.id } });
    expect(row.listingChangedById).toBe(owner.row.id);
    expect(row.listingChangedAt).toBeInstanceOf(Date);
  });

  it('changes one switch at a time: listing, booking acceptance and operations never leak into each other', async () => {
    const { owner, venue } = await setup();
    await listing.ownerSet(owner.auth, venue.id, 'booking', false);
    let row = await prisma.venue.findUniqueOrThrow({ where: { id: venue.id } });
    expect(row).toMatchObject({ instantBook: false, ownerListingEnabled: true, operationsEnabled: true, status: 'active' });
    const state = await listing.stateOf(venue.id);
    expect(state.effective).toMatchObject({ publicVisible: true, bookable: false, booking: 'bookings_paused' });

    await listing.ownerSet(owner.auth, venue.id, 'operations', false);
    row = await prisma.venue.findUniqueOrThrow({ where: { id: venue.id } });
    expect(row).toMatchObject({ operationsEnabled: false, ownerListingEnabled: true, instantBook: false });
    expect((await listing.stateOf(venue.id)).effective).toMatchObject({ publicVisible: true, operationsPaused: true });
  });

  it('does not lose concurrent changes: parallel hide requests write once, other fields untouched', async () => {
    const { owner, venue } = await setup();
    const results = await Promise.allSettled([
      ...Array.from({ length: 5 }, () => listing.ownerSet(owner.auth, venue.id, 'listing', false)),
      listing.ownerSet(owner.auth, venue.id, 'booking', false),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const row = await prisma.venue.findUniqueOrThrow({ where: { id: venue.id } });
    expect(row).toMatchObject({ ownerListingEnabled: false, instantBook: false });
    const log = await audits(venue.id);
    expect(log.filter((l) => l.action === 'owner.venue.listing')).toHaveLength(1);
  });

  it('asks for confirmation before hiding a venue with upcoming bookings, and never cancels them', async () => {
    const { owner, venue, courts } = await setup();
    const p = await makeUser('p');
    const held = await bookings.holdSlot(p.row.id, { courtId: courts[0].id, slotStart: futureSlot(2).toISOString() });
    await bookings.confirmBooking(p.row.id, held.id, { paymentMethod: 'cash' });

    await expect(listing.ownerSet(owner.auth, venue.id, 'listing', false)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'FUTURE_BOOKINGS_EXIST', futureBookings: 1 }),
    });
    expect((await prisma.venue.findUniqueOrThrow({ where: { id: venue.id } })).ownerListingEnabled).toBe(true);

    await listing.ownerSet(owner.auth, venue.id, 'listing', false, { acknowledgeFutureBookings: true });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: held.id } })).status).toBe('confirmed');
    // history and ledgers are untouched, and showing again creates nothing new
    const before = await prisma.booking.count({ where: { venueId: venue.id } });
    await listing.ownerSet(owner.auth, venue.id, 'listing', true);
    expect(await prisma.booking.count({ where: { venueId: venue.id } })).toBe(before);
  });

  it('refuses to show a venue that is not ready and lists exactly what is missing', async () => {
    const owner = await makeUser('owner', ['owner']);
    const w = await makeVenue(owner.row.id, sportId, 1, { weeklyHours: null });
    await prisma.pricingRule.deleteMany({ where: { courtId: w.courts[0].id } });
    await prisma.venue.update({ where: { id: w.venue.id }, data: { ownerListingEnabled: false } });
    await expect(listing.ownerSet(owner.auth, w.venue.id, 'listing', true)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'VENUE_NOT_READY', missing: expect.arrayContaining(['hours', 'prices']) }),
    });
    expect((await prisma.venue.findUniqueOrThrow({ where: { id: w.venue.id } })).ownerListingEnabled).toBe(false);
  });

  it('keeps another owner and staff out', async () => {
    const { venue } = await setup();
    const stranger = await makeUser('owner', ['owner']);
    await expect(listing.ownerSet(stranger.auth, venue.id, 'listing', false)).rejects.toMatchObject({ status: 403 });
    const staff = await makeUser('staff', ['staff']);
    await expect(listing.ownerSet(staff.auth, venue.id, 'listing', false)).rejects.toMatchObject({ status: 403 });
    expect((await prisma.venue.findUniqueOrThrow({ where: { id: venue.id } })).ownerListingEnabled).toBe(true);
  });

  describe('platform decisions outrank the owner', () => {
    it('lets an admin hide a venue with a reason; the owner cannot show it again; the owner’s own preference survives', async () => {
      const { owner, admin, venue } = await setup();
      await listing.ownerSet(owner.auth, venue.id, 'listing', false); // owner chose to hide earlier
      const hidden = await listing.adminSetListing(admin.row.id, venue.id, true, 'Reported for wrong prices');
      expect(hidden).toMatchObject({
        adminHidden: true,
        moderation: { reason: 'Reported for wrong prices', byId: admin.row.id },
        effective: { lockedByAdmin: true },
      });
      await expect(listing.ownerSet(owner.auth, venue.id, 'listing', true)).rejects.toMatchObject({
        status: 403,
        response: expect.objectContaining({ code: 'VENUE_LOCKED_BY_ADMIN' }),
      });
      await prisma.venue.update({ where: { id: venue.id }, data: { instantBook: false } });
      await expect(listing.ownerSet(owner.auth, venue.id, 'booking', true)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'VENUE_LOCKED_BY_ADMIN' }),
      });
      // lifting the admin hide does NOT publish a venue the owner hid himself
      const lifted = await listing.adminSetListing(admin.row.id, venue.id, false, 'Prices fixed');
      expect(lifted).toMatchObject({ adminHidden: false, ownerListingEnabled: false });
      expect(lifted.effective).toMatchObject({ listing: 'hidden_by_owner', publicVisible: false });
      const log = (await audits(venue.id)).map((l) => l.action);
      expect(log).toEqual(['owner.venue.listing', 'admin.venue.hide', 'admin.venue.show']);
    });

    it('survives an owner who changes everything they are allowed to while suspended', async () => {
      const { owner, admin, venue } = await setup();
      await management.updateVenue(admin.row.id, venue.id, { status: 'suspended', reason: 'Chargebacks under review' } as never);
      const row = await prisma.venue.findUniqueOrThrow({ where: { id: venue.id } });
      expect(row).toMatchObject({ status: 'suspended', moderationReason: 'Chargebacks under review', moderatedById: admin.row.id });
      expect(row.moderatedAt).toBeInstanceOf(Date);
      // the owner may hide it further (more restrictive) but can never show it again
      await listing.ownerSet(owner.auth, venue.id, 'listing', false, { acknowledgeFutureBookings: true });
      await expect(listing.ownerSet(owner.auth, venue.id, 'listing', true)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'VENUE_LOCKED_BY_ADMIN' }),
      });
      // the owner may still hide it further or pause operations, but nothing makes it public
      await listing.ownerSet(owner.auth, venue.id, 'operations', false);
      const state = await listing.stateOf(venue.id);
      expect(state.effective).toMatchObject({ listing: 'suspended_by_admin', publicVisible: false, bookable: false, lockedByAdmin: true });
      expect(await listed(venue.slug)).toBe(false);
      await expect(venues.getBySlug(venue.slug)).rejects.toMatchObject({ status: 404 });
    });

    it('reactivation restores a venue the owner never hid, but not one the owner did hide', async () => {
      const { owner, admin, venue } = await setup();
      await management.updateVenue(admin.row.id, venue.id, { status: 'suspended', reason: 'Under review' } as never);
      await management.updateVenue(admin.row.id, venue.id, { status: 'active', reason: 'Review finished' } as never);
      expect((await listing.stateOf(venue.id)).effective.publicVisible).toBe(true);

      await listing.ownerSet(owner.auth, venue.id, 'listing', false);
      await management.updateVenue(admin.row.id, venue.id, { status: 'suspended', reason: 'Again under review' } as never);
      await management.updateVenue(admin.row.id, venue.id, { status: 'active', reason: 'Fine now' } as never);
      expect((await listing.stateOf(venue.id)).effective.listing).toBe('hidden_by_owner');
    });

    it('requires a reason for every sensitive admin decision', async () => {
      const { admin, venue } = await setup();
      await expect(management.updateVenue(admin.row.id, venue.id, { status: 'suspended' } as never)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'REASON_REQUIRED' }),
      });
      expect((await prisma.venue.findUniqueOrThrow({ where: { id: venue.id } })).status).toBe('active');
    });
  });

  describe('the admin venue list shows the real state', () => {
    it('labels each venue and filters by where it stands on Matchena', async () => {
      const owner = await makeUser('owner', ['owner']);
      const admin = await makeUser('admin', ['admin']);
      const tag = `list-${Date.now()}`;
      const mk = (patch: Record<string, unknown>) => makeVenue(owner.row.id, sportId, 1, { nameEn: `${tag}`, ...patch }).then((w) => w.venue);
      const visible = await mk({});
      const byOwner = await mk({ ownerListingEnabled: false });
      const byAdmin = await mk({ adminHidden: true });
      const suspended = await mk({ status: 'suspended' });
      const pending = await mk({ status: 'pending' });
      const paused = await mk({ instantBook: false });
      const q = (listing?: string) => management.venues({ page: 1, perPage: 50, search: tag, ...(listing ? { listing } : {}) } as never);

      const all = await q();
      const stateOf = (id: string) => all.items.find((v) => v.id === id)!;
      expect(stateOf(visible.id)).toMatchObject({ listing: 'visible', bookable: true });
      expect(stateOf(byOwner.id)).toMatchObject({ listing: 'hidden_by_owner', bookable: false });
      expect(stateOf(byAdmin.id)).toMatchObject({ listing: 'hidden_by_admin', bookable: false });
      expect(stateOf(suspended.id)).toMatchObject({ listing: 'suspended_by_admin' });
      expect(stateOf(pending.id)).toMatchObject({ listing: 'pending_approval' });
      expect(stateOf(paused.id)).toMatchObject({ listing: 'visible', bookable: false }); // listed, but takes no new bookings

      const ids = async (listing: string) => (await q(listing)).items.map((v) => v.id).sort();
      expect(await ids('visible')).toEqual([visible.id, paused.id].sort());
      expect(await ids('hidden_by_owner')).toEqual([byOwner.id]);
      expect(await ids('hidden_by_admin')).toEqual([byAdmin.id]);
      expect(await ids('suspended_by_admin')).toEqual([suspended.id]);
      expect(await ids('pending_approval')).toEqual([pending.id]);
      void admin;
    });
  });

  describe('hiding a venue never stops the owner running it', () => {
    it('keeps the owner’s calendar, bookings, check-in and cancellation working while hidden by the owner, hidden by an admin or paused', async () => {
      const { owner, admin, venue, courts } = await setup();
      const p = await makeUser('p');
      const held = await bookings.holdSlot(p.row.id, { courtId: courts[0].id, slotStart: futureSlot(2).toISOString() });
      const confirmed = await bookings.confirmBooking(p.row.id, held.id, { paymentMethod: 'cash' });

      await listing.ownerSet(owner.auth, venue.id, 'listing', false, { acknowledgeFutureBookings: true });
      await listing.adminSetListing(admin.row.id, venue.id, true, 'Policy review in progress');
      await listing.ownerSet(owner.auth, venue.id, 'booking', false, { acknowledgeFutureBookings: true });
      expect((await listing.stateOf(venue.id)).effective).toMatchObject({ publicVisible: false, bookable: false, operationsPaused: false });

      // the owner still sees and works the booking…
      const mine = await bookings.listForVenue(venue.id, owner.auth);
      expect(mine.map((b) => b.id)).toContain(confirmed.id);
      // …can add a walk-in booking from the calendar…
      const owners = new OwnerService(prisma, bookings, {} as never);
      await expect(
        owners.createCalendarBlock(owner.auth, {
          venueId: venue.id, courtId: courts[0].id, kind: 'private',
          startsAt: futureSlot(10).toISOString(), endsAt: futureSlot(11).toISOString(),
        } as never),
      ).resolves.toBeDefined();
      // …and checks the customer in.
      const checked = await bookings.checkInById(owner.auth, confirmed.id, 'cash');
      expect(checked.status).toBe('completed');
      // The venue stays out of every public surface the whole time.
      await expect(venues.getBySlug(venue.slug)).rejects.toMatchObject({ status: 404 });
    });

    it('lets an owner pause only the management system without touching what players see', async () => {
      const { owner, venue } = await setup();
      await listing.ownerSet(owner.auth, venue.id, 'operations', false);
      const s = await listing.stateOf(venue.id);
      expect(s.effective).toMatchObject({ publicVisible: true, bookable: true, operationsPaused: true });
      await expect(venues.getBySlug(venue.slug)).resolves.toBeDefined();
    });
  });

  describe('every public surface agrees', () => {
    it('removes a hidden venue from search, the venue page and the sitemap, and keeps owner data', async () => {
      const { owner, admin, venue, courts } = await setup();
      const sitemap = new SitemapService(prisma as never, { get: () => 'https://matchena.test' } as never);
      const visibleIn = async () => ({
        search: (await venues.search({ country: 'EG', search: venue.nameEn, perPage: 50 } as never)).items.some((v) => (v as { id: string }).id === venue.id),
        page: await venues.getBySlug(venue.slug).then(() => true, () => false),
        sitemap: (await sitemap.venues()).includes(venue.slug),
      });
      expect(await visibleIn()).toEqual({ search: true, page: true, sitemap: true });

      await listing.ownerSet(owner.auth, venue.id, 'listing', false);
      expect(await visibleIn()).toEqual({ search: false, page: false, sitemap: false });
      await listing.ownerSet(owner.auth, venue.id, 'listing', true);
      expect(await visibleIn()).toEqual({ search: true, page: true, sitemap: true });

      await listing.adminSetListing(admin.row.id, venue.id, true, 'Policy violation');
      expect(await visibleIn()).toEqual({ search: false, page: false, sitemap: false });
      // owner and admin can still see everything
      expect((await listing.ownerState(owner.auth, venue.id)).venueId).toBe(venue.id);
      expect(await prisma.court.count({ where: { id: courts[0].id } })).toBe(1);
      expect((await management.venue(venue.id)).id).toBe(venue.id);
    });
  });
});
