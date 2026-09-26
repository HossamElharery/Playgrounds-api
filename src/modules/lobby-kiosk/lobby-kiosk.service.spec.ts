import { judgeProposal } from './lobby-kiosk.types';
import { LobbyKioskService } from './lobby-kiosk.service';
import { addCalendarDays, cairoYmd } from './lobby-kiosk.clock';

const NOW = new Date('2026-09-26T12:00:00Z').getTime();

function harness(
  opts: {
    venue?: Record<string, unknown> | null;
    court?: { id: string } | null;
    booking?: Record<string, unknown> | null;
    members?: { userId: string; isLeader: boolean }[];
  } = {},
) {
  const events: { squadId: string; event: string; payload: any }[] = [];
  const venue =
    opts.venue === undefined
      ? {
          id: 'v1',
          slug: 'pitch',
          status: 'active',
          nameAr: 'ملعب النصر',
          nameEn: 'Nasr Pitch',
          photos: [{ url: 'https://img/p.jpg' }],
        }
      : opts.venue;
  const prisma: any = {
    venue: { findUnique: jest.fn(async () => venue) },
    court: { findFirst: jest.fn(async () => (opts.court === undefined ? { id: 'c1' } : opts.court)) },
    booking: { findUnique: jest.fn(async () => opts.booking ?? null) },
    squadMember: {
      findMany: jest.fn(async () => opts.members ?? [{ userId: 'a', isLeader: false }, { userId: 'b', isLeader: true }]),
    },
  };
  const service = new LobbyKioskService(prisma);
  service.broadcaster = {
    emit: (squadId, event, payload) => events.push({ squadId, event, payload }),
  };
  return { service, events, prisma };
}

function proposeBody(over: Record<string, unknown> = {}) {
  const today = cairoYmd(new Date(NOW));
  return {
    squadId: 's1',
    venueId: 'v1',
    courtId: 'c1',
    date: today,
    startTime: '21:00',
    durationMin: 60,
    priceFrom: 300,
    ...over,
  };
}

describe('judgeProposal', () => {
  it('covers 1–7 members, the leader override, and a changed mind', () => {
    expect(judgeProposal(1, 0, 1, false)).toBe('passed');
    expect(judgeProposal(1, 1, 2, false)).toBe('failed');
    expect(judgeProposal(2, 0, 3, false)).toBe('passed');
    expect(judgeProposal(1, 2, 3, false)).toBe('failed');
    expect(judgeProposal(2, 1, 4, false)).toBe('open');
    expect(judgeProposal(3, 1, 5, false)).toBe('passed');
    expect(judgeProposal(2, 3, 5, false)).toBe('failed');
    expect(judgeProposal(3, 2, 6, false)).toBe('open');
    expect(judgeProposal(4, 2, 7, false)).toBe('passed');
    expect(judgeProposal(1, 3, 7, false)).toBe('open');
    expect(judgeProposal(1, 6, 7, true)).toBe('passed');
    expect(judgeProposal(2, 1, 4, false)).toBe('open');
    expect(judgeProposal(1, 2, 4, false)).toBe('failed');
  });
});

describe('LobbyKioskService', () => {
  it('proposes, counts the proposer as yes, and rejects a second open proposal', async () => {
    const { service, events } = harness();
    const first = await service.propose('a', proposeBody(), NOW);
    expect(first?.status).toBe('open');
    expect(first?.votes).toEqual({ a: 'yes' });
    expect(first?.venueName).toBe('ملعب النصر');
    expect(first?.venueSlug).toBe('pitch');
    expect(events.map((e) => e.event)).toEqual(['lobby.kiosk.proposal']);
    expect(await service.propose('b', proposeBody(), NOW)).toBeNull();
  });

  it('passes on a majority and on a leader yes, and allows changing a vote', async () => {
    const { service, events } = harness({
      members: [
        { userId: 'a', isLeader: false },
        { userId: 'b', isLeader: false },
        { userId: 'c', isLeader: true },
        { userId: 'd', isLeader: false },
      ],
    });
    const p = await service.propose('a', proposeBody(), NOW);
    await service.vote('b', 's1', p!.id, 'no', NOW);
    expect(service.state('s1', NOW).proposal?.status).toBe('open');
    await service.vote('b', 's1', p!.id, 'yes', NOW);
    expect(service.state('s1', NOW).proposal?.status).toBe('open');
    await service.vote('c', 's1', p!.id, 'yes', NOW);
    expect(service.state('s1', NOW).proposal?.status).toBe('passed');
    expect(events.some((e) => e.event === 'lobby.kiosk.resolved' && e.payload.status === 'passed')).toBe(true);
  });

  it('fails when nos reach half', async () => {
    const { service } = harness();
    const p = await service.propose('a', proposeBody(), NOW);
    await service.vote('b', 's1', p!.id, 'no', NOW);
    expect(service.state('s1', NOW).proposal?.status).toBe('failed');
  });

  it('fails on timeout and the timer stops once nothing is open', async () => {
    const { service } = harness();
    const p = await service.propose('a', proposeBody(), NOW);
    expect((service as any).timer).toBeTruthy();
    service.tick(p!.expiresAt);
    expect(service.state('s1', p!.expiresAt).proposal?.status).toBe('failed');
    expect((service as any).timer).toBeNull();
  });

  it('lets the proposer or the leader cancel, and nobody else', async () => {
    const { service } = harness({
      members: [
        { userId: 'a', isLeader: false },
        { userId: 'b', isLeader: true },
        { userId: 'c', isLeader: false },
      ],
    });
    const p = await service.propose('a', proposeBody(), NOW);
    expect(await service.cancel('c', 's1', p!.id)).toBe(false);
    expect(await service.cancel('b', 's1', p!.id)).toBe(true);
    expect(service.state('s1', NOW).proposal?.status).toBe('cancelled');
    const again = await service.propose('a', proposeBody(), NOW);
    expect(await service.cancel('a', 's1', again!.id)).toBe(true);
  });

  it('rejects an inactive venue, a past slot, and a date too far out', async () => {
    const inactive = harness({ venue: { id: 'v1', slug: 'x', status: 'pending', nameAr: 'x', nameEn: 'x', photos: [] } });
    expect(await inactive.service.propose('a', proposeBody(), NOW)).toBeNull();

    const past = harness();
    expect(await past.service.propose('a', proposeBody({ startTime: '08:00' }), NOW)).toBeNull();

    const far = harness();
    const today = cairoYmd(new Date(NOW));
    expect(await far.service.propose('a', proposeBody({ date: addCalendarDays(today, 14) }), NOW)).toBeNull();
    expect(await far.service.propose('a', proposeBody({ date: addCalendarDays(today, 13) }), NOW)).not.toBeNull();
  });

  it('drops state when the squad empties and clears a busy member who leaves', () => {
    const { service, events } = harness();
    service.setBusy('s1', 'a', true);
    service.memberLeft('s1', 'a');
    expect(events.at(-1)).toEqual({
      squadId: 's1',
      event: 'lobby.kiosk.busy',
      payload: { userId: 'a', busy: false },
    });
    expect(service.state('s1', NOW).busy).toEqual([]);
    service.setBusy('s1', 'a', true);
    service.squadEmptied('s1');
    expect(service.state('s1', NOW)).toEqual({ proposal: null, busy: [], nextMatch: null, shortlist: [], presence: [] });
  });

  it('sets nextMatch only for the booker on the proposal venue, in the future', async () => {
    const future = new Date(NOW + 86_400_000);
    const { service, events, prisma } = harness({
      booking: { id: 'bk1', userId: 'a', venueId: 'v1', slotStart: future, status: 'confirmed' },
    });
    const p = await service.propose('a', proposeBody(), NOW);
    await service.vote('b', 's1', p!.id, 'yes', NOW);
    expect(p && service.state('s1', NOW).proposal?.status).toBe('passed');

    prisma.booking.findUnique.mockResolvedValueOnce({
      id: 'other',
      userId: 'stranger',
      venueId: 'v1',
      slotStart: future,
      status: 'confirmed',
    });
    expect(await service.booked('a', 's1', p!.id, 'other', NOW)).toBe(false);

    prisma.booking.findUnique.mockResolvedValueOnce({
      id: 'wrong',
      userId: 'a',
      venueId: 'other-venue',
      slotStart: future,
      status: 'confirmed',
    });
    expect(await service.booked('a', 's1', p!.id, 'wrong', NOW)).toBe(false);

    expect(await service.booked('a', 's1', p!.id, 'bk1', NOW)).toBe(true);
    expect(service.state('s1', NOW).nextMatch).toEqual({
      venueName: 'ملعب النصر',
      venueSlug: 'pitch',
      startsAt: future.toISOString(),
      bookingId: 'bk1',
      bookerId: 'a',
    });
    expect(events.some((e) => e.event === 'lobby.kiosk.nextMatch')).toBe(true);

    service.tick(future.getTime());
    expect(service.state('s1', future.getTime()).nextMatch).toBeNull();
  });

  it('rate-limits a user to 5 messages per second', () => {
    const { service } = harness();
    for (let i = 0; i < 5; i++) expect(service.allow('a', NOW)).toBe(true);
    expect(service.allow('a', NOW)).toBe(false);
    expect(service.allow('a', NOW + 1001)).toBe(true);
  });

  it('shares map presence without GPS, rate-limits it, and drops it when the member leaves', () => {
    const { service, events } = harness();
    expect(service.setPresence('s1', 'a', { venueId: 'v1', center: { lat: 30, lng: 31, zoom: 13 } }, NOW)).toBe(true);
    const sent = events.at(-1);
    expect(sent?.event).toBe('lobby.kiosk.presence');
    expect(sent?.payload).toEqual({ userId: 'a', venueId: 'v1', center: { lat: 30, lng: 31, zoom: 13 } });
    expect(JSON.stringify(sent?.payload)).not.toMatch(/gps|accuracy/i);
    expect(service.setPresence('s1', 'a', { venueId: 'v1' }, NOW + 1)).toBe(true);
    expect(service.setPresence('s1', 'a', { venueId: 'v1' }, NOW + 2)).toBe(true);
    expect(service.setPresence('s1', 'a', { venueId: 'v1' }, NOW + 3)).toBe(true);
    expect(service.setPresence('s1', 'a', { venueId: 'v1' }, NOW + 4)).toBe(false);
    service.memberLeft('s1', 'a');
    expect(service.state('s1', NOW).presence).toEqual([]);
  });

  it('caps the shortlist at 5 and lets only the pinner or the leader remove one', async () => {
    const { service, prisma } = harness();
    for (let i = 1; i <= 5; i++) {
      prisma.venue.findUnique.mockResolvedValueOnce({ id: `v${i}`, status: 'active' });
      expect(await service.addShortlist('s1', 'a', `v${i}`)).toBe(true);
    }
    prisma.venue.findUnique.mockResolvedValueOnce({ id: 'v6', status: 'active' });
    expect(await service.addShortlist('s1', 'a', 'v6')).toBe(false);
    expect(service.state('s1', NOW).shortlist).toHaveLength(5);
    expect(await service.removeShortlist('s1', 'c', 'v1')).toBe(false);
    expect(await service.removeShortlist('s1', 'b', 'v1')).toBe(true);
    service.squadEmptied('s1');
    expect(service.state('s1', NOW).shortlist).toEqual([]);
  });
});
