import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MatchPostsService } from '../social/match-posts.service';
import { assertVenueStaffAccess } from '../../common/access/venue-access';
import { RealtimeGatewayEmitter } from '../realtime/realtime-emitter.interface';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import {
  CreateTournamentDto,
  ListTournamentsQueryDto,
  ReportMatchResultDto,
} from './dto/tournament.dto';

interface BracketSlot {
  round: number;
  matchIndex: number;
  slotAId: string | null;
  slotBId: string | null;
  winnerId: string | null;
}

/**
 * An entrant feeding into a bracket slot: either a concrete participant (or
 * `id: null` meaning a genuine bye — no one there), or `pending: true`
 * meaning "the winner of an earlier real match, not decided yet". The
 * distinction matters: a bye auto-advances, a pending slot must not.
 */
interface BracketEntrant {
  id: string | null;
  pending: boolean;
}

/**
 * Lightweight single-elimination esports tournaments (§3.9/§7.3) — a
 * deliberately scoped-down Phase-2 module: no sponsors, no prize
 * infrastructure. Bracket seeding is random for v1 (documented TODO:
 * ELO-seed once per-activity skill data exists — that needs the
 * `User.sports -> activities` widening the blueprint calls out as its own
 * dedicated mechanical commit, not done in this pass).
 */
@Injectable()
export class TournamentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly matchPosts: MatchPostsService,
    private readonly emitter: RealtimeGatewayEmitter,
  ) {}

  private async resolveActivity(activityId: string) {
    const sport = await this.prisma.sportCategory.findFirst({
      where: { OR: [{ id: activityId }, { slug: activityId }] },
    });
    if (sport)
      return { sportId: sport.id, gameId: undefined as string | undefined };

    const game = await this.prisma.gameCatalogEntry.findFirst({
      where: { OR: [{ id: activityId }, { slug: activityId }] },
    });
    if (game) {
      const gamingSport = await this.prisma.sportCategory.findFirst({
        where: { slug: 'playstation' },
      });
      if (!gamingSport) {
        throw new BadRequestException('Gaming sport category is not seeded');
      }
      return { sportId: gamingSport.id, gameId: game.id };
    }

    throw new BadRequestException('Unknown activityId — not a sport or a game');
  }

  list(query: ListTournamentsQueryDto) {
    return this.prisma.tournament.findMany({
      where: {
        ...(query.activityId ? { activityId: query.activityId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.venueId ? { venueId: query.venueId } : {}),
      },
      include: { _count: { select: { participants: true } } },
      orderBy: { startsAt: 'asc' },
    });
  }

  async get(id: string) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id },
      include: {
        participants: {
          include: {
            user: { select: { id: true, name: true, avatarUrl: true } },
          },
        },
        matches: { orderBy: [{ round: 'asc' }, { matchIndex: 'asc' }] },
        venue: { select: { id: true, nameEn: true, nameAr: true, slug: true } },
      },
    });
    if (!tournament) throw new NotFoundException('Tournament not found');
    return tournament;
  }

  async create(user: AuthenticatedUser, dto: CreateTournamentDto) {
    await this.resolveActivity(dto.activityId);
    if (dto.venueId) {
      await assertVenueStaffAccess(this.prisma, dto.venueId, user);
    } else if (!user.roles.includes('admin')) {
      throw new ForbiddenException(
        'Only admins can create a virtual/platform-wide tournament',
      );
    }
    if (new Date(dto.registrationDeadline) >= new Date(dto.startsAt)) {
      throw new BadRequestException(
        'registrationDeadline must be before startsAt',
      );
    }
    return this.prisma.tournament.create({
      data: {
        venueId: dto.venueId,
        activityId: dto.activityId,
        nameEn: dto.nameEn,
        nameAr: dto.nameAr,
        entryFeeAmount: dto.entryFeeAmount,
        entryFeeCurrency:
          dto.entryFeeCurrency ?? (dto.entryFeeAmount ? 'EGP' : undefined),
        maxParticipants: dto.maxParticipants,
        registrationDeadline: new Date(dto.registrationDeadline),
        startsAt: new Date(dto.startsAt),
        createdById: user.id,
      },
    });
  }

  async register(userId: string, tournamentId: string) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
      include: { _count: { select: { participants: true } } },
    });
    if (!tournament) throw new NotFoundException('Tournament not found');
    if (tournament.status !== 'open') {
      throw new BadRequestException(
        'Registration is closed for this tournament',
      );
    }
    if (tournament.registrationDeadline < new Date()) {
      throw new BadRequestException('Registration deadline has passed');
    }
    if (tournament._count.participants >= tournament.maxParticipants) {
      throw new ConflictException('Tournament is full');
    }
    try {
      const participant = await this.prisma.tournamentParticipant.create({
        data: { tournamentId, userId },
      });
      const count = tournament._count.participants + 1;
      if (count >= tournament.maxParticipants) {
        await this.prisma.tournament.update({
          where: { id: tournamentId },
          data: { status: 'full' },
        });
      }
      return participant;
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        throw new ConflictException('Already registered');
      }
      throw error;
    }
  }

  /** Random-seeded single-elimination bracket (see class doc re: ELO TODO). */
  private buildBracket(entrants: BracketEntrant[], round = 1): BracketSlot[] {
    if (entrants.length <= 1) return [];
    const slots: BracketSlot[] = [];
    const nextEntrants: BracketEntrant[] = [];
    for (let i = 0; i < entrants.length; i += 2) {
      const a = entrants[i];
      const b = entrants[i + 1];
      let winnerId: string | null = null;
      if (!a.pending && !b.pending) {
        // Both sides are resolved (a concrete id, or a genuine bye = null).
        if (a.id && !b.id) winnerId = a.id;
        else if (b.id && !a.id) winnerId = b.id;
        // else: either a real match (both ids present) or a dead bracket
        // slot (both null, only possible with 0 entrants — never happens
        // here since we always pad from at least 2 real participants).
      }
      slots.push({
        round,
        matchIndex: i / 2,
        slotAId: a.id,
        slotBId: b.id,
        winnerId,
      });
      nextEntrants.push({ id: winnerId, pending: winnerId === null });
    }
    return [...slots, ...this.buildBracket(nextEntrants, round + 1)];
  }

  async generateBracket(user: AuthenticatedUser, tournamentId: string) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
      include: { participants: true },
    });
    if (!tournament) throw new NotFoundException('Tournament not found');
    if (tournament.venueId) {
      await assertVenueStaffAccess(this.prisma, tournament.venueId, user);
    } else if (!user.roles.includes('admin')) {
      throw new ForbiddenException(
        'Only admins can generate a virtual tournament bracket',
      );
    }
    if (!['open', 'full'].includes(tournament.status)) {
      throw new BadRequestException(
        'Bracket already generated or tournament closed',
      );
    }
    if (
      tournament.registrationDeadline > new Date() &&
      !user.roles.includes('admin')
    ) {
      throw new BadRequestException('Registration deadline has not passed yet');
    }
    if (tournament.participants.length < 2) {
      throw new BadRequestException('Need at least 2 registered participants');
    }

    const bracketSize =
      2 ** Math.ceil(Math.log2(tournament.participants.length));
    const shuffled = [...tournament.participants]
      .map((p) => p.userId)
      .sort(() => Math.random() - 0.5);
    const entrants: BracketEntrant[] = [
      ...shuffled.map((id) => ({ id, pending: false })),
      ...Array.from({ length: bracketSize - shuffled.length }, () => ({
        id: null,
        pending: false,
      })),
    ];
    const slots = this.buildBracket(entrants);

    const { sportId, gameId } = await this.resolveActivity(
      tournament.activityId,
    );

    await this.prisma.$transaction(async (tx) => {
      for (const slot of slots) {
        await tx.tournamentMatch.create({
          data: {
            tournamentId,
            round: slot.round,
            matchIndex: slot.matchIndex,
            slotAId: slot.slotAId,
            slotBId: slot.slotBId,
            winnerId: slot.winnerId,
            resultConfirmedByA: !!slot.winnerId,
            resultConfirmedByB: !!slot.winnerId,
          },
        });
      }
      await tx.tournament.update({
        where: { id: tournamentId },
        data: { status: 'in-progress' },
      });
    });

    const created = await this.prisma.tournamentMatch.findMany({
      where: { tournamentId },
      orderBy: [{ round: 'asc' }, { matchIndex: 'asc' }],
    });
    for (const match of created) {
      if (match.slotAId && match.slotBId && !match.matchPostId) {
        await this.createMatchPostForMatch(
          tournament,
          sportId,
          gameId,
          match.id,
        );
      }
    }

    this.emitter.emitToRoom('tournaments', {
      type: 'tournament.bracket.generated',
      tournamentId,
    });
    return this.get(tournamentId);
  }

  private async createMatchPostForMatch(
    tournament: { id: string; nameEn: string; venueId: string | null },
    sportId: string,
    gameId: string | undefined,
    matchId: string,
  ) {
    const match = await this.prisma.tournamentMatch.findUnique({
      where: { id: matchId },
    });
    if (!match || !match.slotAId || !match.slotBId) return;
    const post = await this.matchPosts.create(
      match.slotAId,
      {
        sportId,
        gameId,
        venueId: tournament.venueId ?? undefined,
        dateTime: (match.scheduledAt ?? new Date()).toISOString(),
        playersNeeded: 2,
        notes: `Tournament round: ${tournament.nameEn} — round ${match.round}`,
      } as never,
      [match.slotBId],
    );
    await this.prisma.tournamentMatch.update({
      where: { id: matchId },
      data: { matchPostId: post.id },
    });
  }

  async reportResult(
    user: AuthenticatedUser,
    tournamentId: string,
    matchId: string,
    dto: ReportMatchResultDto,
  ) {
    const match = await this.prisma.tournamentMatch.findUnique({
      where: { id: matchId },
    });
    if (!match || match.tournamentId !== tournamentId) {
      throw new NotFoundException('Match not found');
    }
    if (match.resultConfirmedByA && match.resultConfirmedByB) {
      throw new BadRequestException('Result already finalized');
    }
    const isAdmin = user.roles.includes('admin');
    const isSlotA = match.slotAId === user.id;
    const isSlotB = match.slotBId === user.id;
    if (!isAdmin && !isSlotA && !isSlotB) {
      throw new ForbiddenException('Not a participant in this match');
    }
    if (
      !isAdmin &&
      dto.winnerId !== match.slotAId &&
      dto.winnerId !== match.slotBId
    ) {
      throw new BadRequestException(
        'winnerId must be one of the two participants',
      );
    }

    let finalized = false;
    let updated: NonNullable<
      Awaited<ReturnType<typeof this.prisma.tournamentMatch.update>>
    >;
    if (isAdmin) {
      updated = await this.prisma.tournamentMatch.update({
        where: { id: matchId },
        data: {
          winnerId: dto.winnerId,
          resultConfirmedByA: true,
          resultConfirmedByB: true,
        },
      });
      finalized = true;
    } else if (!match.winnerId) {
      updated = await this.prisma.tournamentMatch.update({
        where: { id: matchId },
        data: {
          winnerId: dto.winnerId,
          resultConfirmedByA: isSlotA || match.resultConfirmedByA,
          resultConfirmedByB: isSlotB || match.resultConfirmedByB,
        },
      });
    } else {
      if (dto.winnerId !== match.winnerId) {
        throw new ConflictException(
          'RESULT_DISPUTED — the two participants reported different winners; an admin must resolve this',
        );
      }
      updated = await this.prisma.tournamentMatch.update({
        where: { id: matchId },
        data: {
          resultConfirmedByA: isSlotA || match.resultConfirmedByA,
          resultConfirmedByB: isSlotB || match.resultConfirmedByB,
        },
      });
      finalized = updated.resultConfirmedByA && updated.resultConfirmedByB;
    }

    if (finalized && updated.winnerId) {
      await this.advanceWinner(
        tournamentId,
        updated.round,
        updated.matchIndex,
        updated.winnerId,
      );
      this.emitter.emitToRoom('tournaments', {
        type: 'tournament.match.result',
        tournamentId,
        matchId,
        winnerId: updated.winnerId,
      });
    }
    return updated;
  }

  private async advanceWinner(
    tournamentId: string,
    round: number,
    matchIndex: number,
    winnerId: string,
  ) {
    const nextMatch = await this.prisma.tournamentMatch.findUnique({
      where: {
        tournamentId_round_matchIndex: {
          tournamentId,
          round: round + 1,
          matchIndex: Math.floor(matchIndex / 2),
        },
      },
    });
    if (!nextMatch) {
      // No next round — this was the final. Tournament complete.
      await this.prisma.tournament.update({
        where: { id: tournamentId },
        data: { status: 'completed' },
      });
      return;
    }
    const isA = matchIndex % 2 === 0;
    const updated = await this.prisma.tournamentMatch.update({
      where: { id: nextMatch.id },
      data: isA ? { slotAId: winnerId } : { slotBId: winnerId },
    });
    if (updated.slotAId && updated.slotBId && !updated.matchPostId) {
      const tournament = await this.prisma.tournament.findUniqueOrThrow({
        where: { id: tournamentId },
      });
      const { sportId, gameId } = await this.resolveActivity(
        tournament.activityId,
      );
      await this.createMatchPostForMatch(
        tournament,
        sportId,
        gameId,
        nextMatch.id,
      );
    }
  }
}
