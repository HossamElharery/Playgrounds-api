import { GlobalSearchService } from './global-search.service';
import { PrismaService } from '../prisma/prisma.service';

function makeService() {
  const prisma = {
    venue: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    team: { findMany: jest.fn().mockResolvedValue([]) },
    matchPost: { findMany: jest.fn().mockResolvedValue([]) },
    tournament: { findMany: jest.fn().mockResolvedValue([]) },
  };
  return {
    prisma,
    service: new GlobalSearchService(prisma as unknown as PrismaService),
  };
}

describe('GlobalSearchService', () => {
  it('returns empty buckets for a whitespace query without hitting the database', async () => {
    const { service, prisma } = makeService();
    const result = await service.search({ q: '   ' });
    expect(result).toEqual({ venues: [], players: [], teams: [], matches: [], tournaments: [] });
    expect(prisma.venue.findMany).not.toHaveBeenCalled();
  });

  it('fans out in parallel and maps each source into a typed hit', async () => {
    const { service, prisma } = makeService();
    prisma.venue.findMany.mockResolvedValue([
      {
        id: 'v1',
        slug: 'padel-house',
        nameAr: 'بادل هاوس',
        nameEn: 'Padel House',
        ratingAvg: 4.8,
        instantBook: true,
        district: { nameAr: 'الزمالك', nameEn: 'Zamalek' },
        photos: [{ url: '/uploads/v1.jpg' }],
      },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 'u1', name: 'Hossam', avatarUrl: null, reputation: 40, matchesPlayed: 12 },
    ]);
    prisma.team.findMany.mockResolvedValue([
      {
        id: 't1',
        name: 'Zamalek FC',
        logoUrl: null,
        sport: { nameAr: 'كورة', nameEn: 'Football' },
        _count: { members: 7 },
      },
    ]);
    prisma.matchPost.findMany.mockResolvedValue([
      {
        id: 'm1',
        notes: 'Need one more',
        dateTime: new Date('2026-09-23T18:00:00.000Z'),
        status: 'open',
        playersNeeded: 1,
        sport: { nameAr: 'بادل', nameEn: 'Padel' },
        district: { nameAr: 'المعادي', nameEn: 'Maadi' },
      },
    ]);
    prisma.tournament.findMany.mockResolvedValue([
      {
        id: 'n1',
        nameAr: 'كأس سبتمبر',
        nameEn: 'September Cup',
        status: 'open',
        startsAt: new Date('2026-09-30T16:00:00.000Z'),
      },
    ]);

    const result = await service.search({ q: 'padel', limit: 4 });

    expect(prisma.venue.findMany).toHaveBeenCalledTimes(1);
    expect(result.venues[0]).toMatchObject({ kind: 'venue', slug: 'padel-house', photo: '/uploads/v1.jpg' });
    expect(result.players[0]).toMatchObject({ kind: 'player', name: 'Hossam' });
    expect(result.teams[0]).toMatchObject({ kind: 'team', memberCount: 7 });
    expect(result.matches[0]).toMatchObject({ kind: 'match', id: 'm1', dateTime: '2026-09-23T18:00:00.000Z' });
    expect(result.tournaments[0]).toMatchObject({ kind: 'tournament', nameEn: 'September Cup' });
  });
});
