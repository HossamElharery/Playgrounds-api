import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTeamDto } from './dto/create-team.dto';
import { CreateChallengeDto } from './dto/create-challenge.dto';
import { Prisma } from '@prisma/client';
import { RealtimeGatewayEmitter } from '../realtime/realtime-emitter.interface';
import { NotificationsService } from '../notifications/notifications.service';

const TEAM_INCLUDE = {
  members: {
    include: { user: { select: { id: true, name: true, avatarUrl: true } } },
  },
  captain: { select: { id: true, name: true, avatarUrl: true } },
  sport: true,
} as const;

@Injectable()
export class TeamsService {
  private readonly logger = new Logger(TeamsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: RealtimeGatewayEmitter,
    private readonly notifications: NotificationsService,
  ) {}

  async create(captainId: string, dto: CreateTeamDto) {
    if (!dto.name.trim())
      throw new BadRequestException('Team name is required');
    return this.prisma.$transaction(async (tx) => {
      const thread = await tx.chatThread.create({
        data: {
          type: 'team',
          title: dto.name,
          participants: { create: [{ userId: captainId }] },
        },
      });
      return tx.team.create({
        data: {
          name: dto.name.trim(),
          logoUrl: dto.logoUrl,
          sportId: dto.sportId,
          captainId,
          chatThreadId: thread.id,
          members: { create: [{ userId: captainId }] },
        },
        include: TEAM_INCLUDE,
      });
    });
  }

  list(sportId?: string) {
    return this.prisma.team.findMany({
      where: { archivedAt: null, ...(sportId ? { sportId } : {}) },
      include: {
        members: {
          include: {
            user: { select: { id: true, name: true, avatarUrl: true } },
          },
        },
        captain: { select: { id: true, name: true, avatarUrl: true } },
        sport: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getById(id: string) {
    const team = await this.prisma.team.findUnique({
      where: { id },
      include: TEAM_INCLUDE,
    });
    if (!team || team.archivedAt) throw new NotFoundException('Team not found');
    return team;
  }

  mine(userId: string) {
    return this.prisma.team.findMany({
      where: { archivedAt: null, members: { some: { userId } } },
      include: TEAM_INCLUDE,
    });
  }

  async addMember(captainId: string, teamId: string, userId: string) {
    return this.requestMembership(captainId, teamId, userId);
  }

  async removeMember(captainId: string, teamId: string, userId: string) {
    const threadId = await this.locked(teamId, async (tx, team) => {
      if (team.captainId !== captainId && captainId !== userId)
        throw new ForbiddenException('Only the captain can manage the roster');
      if (userId === team.captainId)
        throw new BadRequestException(
          'Transfer captaincy or archive the team before leaving',
        );
      await tx.teamMember.deleteMany({
        where: { teamId, userId },
      });
      if (team.chatThreadId)
        await tx.chatThreadParticipant.deleteMany({
          where: { threadId: team.chatThreadId, userId },
        });
      return team.chatThreadId;
    });
    if (threadId) this.emitter.revokeRoomAccess(userId, `thread:${threadId}`);
    await this.changed(teamId, [userId]);
  }

  private locked<T>(
    teamId: string,
    action: (
      tx: Prisma.TransactionClient,
      team: Prisma.TeamGetPayload<object>,
    ) => Promise<T>,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM "Team" WHERE "id" = ${teamId} FOR UPDATE`;
      const team = await tx.team.findUnique({ where: { id: teamId } });
      if (!team || team.archivedAt)
        throw new NotFoundException('Team not found');
      return action(tx, team);
    });
  }

  private async changed(teamId: string, extra: string[] = []) {
    const members = await this.prisma.teamMember.findMany({
      where: { teamId },
      select: { userId: true },
    });
    for (const userId of new Set([...members.map((m) => m.userId), ...extra]))
      this.emitter.emitToUser(userId, { type: 'team.changed', teamId });
  }

  async transferCaptain(captainId: string, teamId: string, userId: string) {
    await this.locked(teamId, async (tx, team) => {
      if (team.captainId !== captainId)
        throw new ForbiddenException(
          'Only the captain can transfer leadership',
        );
      if (userId === captainId)
        throw new BadRequestException('Already captain');
      const member = await tx.teamMember.findUnique({
        where: { teamId_userId: { teamId, userId } },
      });
      if (!member)
        throw new BadRequestException('New captain must be a team member');
      await tx.team.update({
        where: { id: teamId },
        data: { captainId: userId },
      });
    });
    await this.changed(teamId);
  }

  async archive(captainId: string, teamId: string) {
    const removed = await this.locked(teamId, async (tx, team) => {
      if (team.captainId !== captainId)
        throw new ForbiddenException('Only the captain can archive the team');
      const members = await tx.teamMember.findMany({
        where: { teamId },
        select: { userId: true },
      });
      await tx.team.update({
        where: { id: teamId },
        data: { archivedAt: new Date() },
      });
      await tx.teamMembershipRequest.updateMany({
        where: { teamId, status: 'pending' },
        data: { status: 'cancelled', respondedAt: new Date() },
      });
      await tx.teamChallenge.updateMany({
        where: {
          status: { in: ['pending', 'accepted'] },
          OR: [{ challengerTeamId: teamId }, { challengedTeamId: teamId }],
        },
        data: { status: 'declined' },
      });
      await tx.teamMember.deleteMany({ where: { teamId } });
      if (team.chatThreadId)
        await tx.chatThreadParticipant.deleteMany({
          where: { threadId: team.chatThreadId },
        });
      return { userIds: members.map((m) => m.userId), threadId: team.chatThreadId };
    });
    if (removed.threadId) for (const userId of removed.userIds) this.emitter.revokeRoomAccess(userId, `thread:${removed.threadId}`);
    await this.changed(teamId, removed.userIds);
  }

  async requestMembership(actorId: string, teamId: string, userId = actorId) {
    const request = await this.locked(teamId, async (tx, team) => {
      if (actorId !== userId && actorId !== team.captainId)
        throw new ForbiddenException('Only the captain can invite players');
      if (
        !(await tx.user.findFirst({ where: { id: userId, status: 'active' } }))
      )
        throw new NotFoundException('Player not found');
      const block = await tx.userBlock.findFirst({
        where: {
          OR: [
            { blockerId: team.captainId, blockedId: userId },
            { blockerId: userId, blockedId: team.captainId },
          ],
        },
      });
      if (block) throw new ForbiddenException('Cannot request this membership');
      if (
        await tx.teamMember.findUnique({
          where: { teamId_userId: { teamId, userId } },
        })
      )
        throw new BadRequestException('Already a team member');
      if (
        await tx.teamMembershipRequest.findFirst({
          where: { teamId, userId, status: 'pending' },
        })
      )
        throw new BadRequestException('Membership request already pending');
      return tx.teamMembershipRequest.create({
        data: { teamId, userId, requestedById: actorId },
        include: { team: true, user: { select: { name: true } } },
      });
    });
    const recipientId = actorId === userId ? request.team.captainId : userId;
    await this.notifications
      .create({
        userId: recipientId,
        category: 'teams',
        titleAr:
          actorId === userId
            ? `${request.user.name} يطلب الانضمام إلى ${request.team.name}`
            : `دعوة للانضمام إلى ${request.team.name}`,
        titleEn:
          actorId === userId
            ? `${request.user.name} wants to join ${request.team.name}`
            : `Invitation to join ${request.team.name}`,
        deepLink: `/app/teams/${teamId}`,
        payload: { teamRequestId: request.id },
      })
      .catch(() => this.logger.error('Could not deliver team notification'));
    await this.changed(teamId, [userId]);
    return request;
  }

  listRequests(userId: string) {
    return this.prisma.teamMembershipRequest.findMany({
      where: {
        status: 'pending',
        team: { archivedAt: null },
        OR: [
          { userId },
          { requestedById: userId },
          { team: { captainId: userId } },
        ],
      },
      include: {
        user: { select: { id: true, name: true, avatarUrl: true } },
        team: { select: { id: true, name: true, captainId: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async resolveRequest(
    actorId: string,
    requestId: string,
    action: 'accept' | 'decline' | 'cancel',
  ) {
    const original = await this.prisma.teamMembershipRequest.findUnique({
      where: { id: requestId },
    });
    if (!original) throw new NotFoundException('Membership request not found');
    await this.locked(original.teamId, async (tx, team) => {
      const request = await tx.teamMembershipRequest.findUnique({
        where: { id: requestId },
      });
      if (!request || request.status !== 'pending')
        throw new BadRequestException('Request already resolved');
      const isJoinRequest = request.userId === request.requestedById;
      const recipient = isJoinRequest ? team.captainId : request.userId;
      if (
        action === 'cancel'
          ? actorId !== request.requestedById && actorId !== team.captainId
          : actorId !== recipient
      )
        throw new ForbiddenException('Not your request');
      if (action === 'accept') {
        if (!(await tx.user.findFirst({ where: { id: request.userId, status: 'active' } })))
          throw new BadRequestException('Player is no longer active');
        const block = await tx.userBlock.findFirst({
          where: {
            OR: [
              { blockerId: team.captainId, blockedId: request.userId },
              { blockerId: request.userId, blockedId: team.captainId },
            ],
          },
        });
        if (block)
          throw new ForbiddenException('Cannot accept this membership');
        await tx.teamMember.upsert({
          where: { teamId_userId: { teamId: team.id, userId: request.userId } },
          create: { teamId: team.id, userId: request.userId },
          update: {},
        });
        if (team.chatThreadId)
          await tx.chatThreadParticipant.upsert({
            where: {
              threadId_userId: {
                threadId: team.chatThreadId,
                userId: request.userId,
              },
            },
            create: { threadId: team.chatThreadId, userId: request.userId },
            update: {},
          });
      }
      await tx.teamMembershipRequest.update({
        where: { id: requestId },
        data: {
          status:
            action === 'accept'
              ? 'accepted'
              : action === 'decline'
                ? 'declined'
                : 'cancelled',
          respondedAt: new Date(),
        },
      });
    });
    await this.changed(original.teamId, [
      original.userId,
      original.requestedById,
    ]);
  }

  async createChallenge(
    captainId: string,
    teamId: string,
    dto: CreateChallengeDto,
  ) {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team || team.archivedAt) throw new NotFoundException('Team not found');
    if (team.captainId !== captainId)
      throw new ForbiddenException('Only the captain can challenge');
    if (teamId === dto.challengedTeamId)
      throw new BadRequestException('Cannot challenge your own team');

    return this.prisma.teamChallenge.create({
      data: {
        challengerTeamId: teamId,
        challengedTeamId: dto.challengedTeamId,
        proposedDateTime: dto.proposedDateTime
          ? new Date(dto.proposedDateTime)
          : undefined,
      },
    });
  }

  async respondChallenge(
    captainId: string,
    challengeId: string,
    accept: boolean,
  ) {
    const challenge = await this.prisma.teamChallenge.findUnique({
      where: { id: challengeId },
      include: { challengedTeam: true },
    });
    if (!challenge) throw new NotFoundException('Challenge not found');
    if (challenge.challengedTeam.captainId !== captainId)
      throw new ForbiddenException('Not your team');
    if (challenge.challengedTeam.archivedAt || challenge.status !== 'pending')
      throw new BadRequestException('Challenge already resolved');
    return this.prisma.teamChallenge.updateMany({
      where: { id: challengeId, status: 'pending' },
      data: { status: accept ? 'accepted' : 'declined' },
    });
  }

  headToHead(teamAId: string, teamBId: string) {
    return this.prisma.teamChallenge.findMany({
      where: {
        status: 'played',
        OR: [
          { challengerTeamId: teamAId, challengedTeamId: teamBId },
          { challengerTeamId: teamBId, challengedTeamId: teamAId },
        ],
      },
    });
  }
}
