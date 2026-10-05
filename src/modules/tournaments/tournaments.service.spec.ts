import { TournamentsService } from './tournaments.service';

// Who may run tournaments at a venue is covered by the access tests; here access is granted.
jest.mock('../../common/access/venue-access', () => ({ assertVenueStaffAccess: jest.fn().mockResolvedValue(undefined) }));

describe('Tournament entry fee payment', () => {
  const openTournament = {
    id: 'tour', status: 'open', maxParticipants: 8,
    registrationDeadline: new Date(Date.now() + 86_400_000),
    entryFeeAmount: 5000, entryFeeCurrency: 'EGP',
    nameEn: 'Cup', nameAr: 'كأس',
    _count: { participants: 1 },
  };
  const prisma = {
    $transaction: jest.fn(),
    tournament: { findUnique: jest.fn(), update: jest.fn() },
    tournamentParticipant: { create: jest.fn(), findUnique: jest.fn(), delete: jest.fn() },
    user: { findMany: jest.fn() },
  };
  const wallet = { debit: jest.fn(), credit: jest.fn() };
  const notifications = { create: jest.fn().mockResolvedValue(null) };
  let service: TournamentsService;

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));
    prisma.tournament.findUnique.mockResolvedValue(openTournament);
    prisma.tournamentParticipant.create.mockResolvedValue({ id: 'p1', tournamentId: 'tour', userId: 'u1', entryFeePaid: 5000, paymentStatus: 'paid' });
    notifications.create.mockResolvedValue(null);
    service = new TournamentsService(prisma as never, {} as never, { emitToRoom: jest.fn() } as never, wallet as never, notifications as never);
  });

  it('charges the wallet for the entry fee before creating the participant row', async () => {
    await service.register('u1', 'tour');
    expect(wallet.debit).toHaveBeenCalledWith(prisma, { userId: 'u1', amount: 5000, reason: 'tournament' });
    expect(prisma.tournamentParticipant.create).toHaveBeenCalledWith({
      data: { tournamentId: 'tour', userId: 'u1', entryFeePaid: 5000, paymentStatus: 'paid' },
    });
  });

  it('never creates a participant if the debit fails', async () => {
    wallet.debit.mockRejectedValue(new Error('INSUFFICIENT_WALLET'));
    await expect(service.register('u1', 'tour')).rejects.toThrow('INSUFFICIENT_WALLET');
    expect(prisma.tournamentParticipant.create).not.toHaveBeenCalled();
  });

  it('does not touch the wallet for a free tournament', async () => {
    prisma.tournament.findUnique.mockResolvedValue({ ...openTournament, entryFeeAmount: null });
    await service.register('u1', 'tour');
    expect(wallet.debit).not.toHaveBeenCalled();
  });

  it('refunds the paid entry fee on withdrawal and frees a full tournament back to open', async () => {
    prisma.tournament.findUnique.mockResolvedValue({ ...openTournament, status: 'full' });
    prisma.tournamentParticipant.findUnique.mockResolvedValue({ id: 'p1', entryFeePaid: 5000, paymentStatus: 'paid' });
    await service.withdraw('u1', 'tour');
    expect(prisma.tournamentParticipant.delete).toHaveBeenCalledWith({ where: { id: 'p1' } });
    expect(wallet.credit).toHaveBeenCalledWith(prisma, { userId: 'u1', amount: 5000, reason: 'refund' });
    expect(prisma.tournament.update).toHaveBeenCalledWith({ where: { id: 'tour' }, data: { status: 'open' } });
  });

  it('refuses to withdraw once the bracket has been generated', async () => {
    prisma.tournament.findUnique.mockResolvedValue({ ...openTournament, status: 'in-progress' });
    await expect(service.withdraw('u1', 'tour')).rejects.toThrow('bracket has been generated');
    expect(prisma.tournamentParticipant.delete).not.toHaveBeenCalled();
  });
});

describe('Creating a tournament needs one name, not two', () => {
  const owner = { id: 'o1', roles: ['owner'] } as never;
  const base = {
    venueId: 'v1', activityId: 'sport-padel', maxParticipants: 8 as const,
    registrationDeadline: '2030-01-01T18:00:00.000Z', startsAt: '2030-01-02T19:00:00.000Z',
  };
  function build() {
    const prisma = {
      sportCategory: { findFirst: jest.fn().mockResolvedValue({ id: 'sport-padel' }) },
      gameCatalogEntry: { findFirst: jest.fn().mockResolvedValue(null) },
      venue: { findUnique: jest.fn().mockResolvedValue({ currency: 'AED', ownerId: 'o1' }) },
      tournament: { create: jest.fn().mockResolvedValue({ id: 't1' }) },
    };
    const service = new TournamentsService(prisma as never, {} as never, {} as never, {} as never, {} as never);
    // Venue and activity rules are covered elsewhere; this pins only the names and the currency.
    jest.spyOn(service as never, 'resolveActivity').mockResolvedValue(undefined as never);
    return { service, prisma };
  }

  it('an Arabic-only name is used for both languages', async () => {
    const { service, prisma } = build();
    await service.create(owner, { ...base, nameAr: '  كأس البادل  ' } as never);
    expect(prisma.tournament.create).toHaveBeenCalledWith({ data: expect.objectContaining({ nameAr: 'كأس البادل', nameEn: 'كأس البادل' }) });
  });

  it('an English-only name fills the Arabic one', async () => {
    const { service, prisma } = build();
    await service.create(owner, { ...base, nameEn: 'Padel Cup' } as never);
    expect(prisma.tournament.create).toHaveBeenCalledWith({ data: expect.objectContaining({ nameAr: 'Padel Cup', nameEn: 'Padel Cup' }) });
  });

  it('no name at all is refused, and the fee is charged in the venue currency', async () => {
    const { service, prisma } = build();
    await expect(service.create(owner, { ...base, nameAr: '  ' } as never)).rejects.toThrow('A tournament needs a name');
    await service.create(owner, { ...base, nameAr: 'كأس', entryFeeAmount: 5000 } as never);
    expect(prisma.tournament.create).toHaveBeenCalledWith({ data: expect.objectContaining({ entryFeeCurrency: 'AED' }) });
  });
});
