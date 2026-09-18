import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { PresenceService } from '../presence/presence.service';
import { RealtimeGatewayEmitter } from '../realtime/realtime-emitter.interface';
import { NotificationsService } from '../notifications/notifications.service';

const SQUAD_MAX_SIZE = 7;

@Injectable()
export class SquadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: PresenceService,
    private readonly emitter: RealtimeGatewayEmitter,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  iceServers() {
    const stun =
      this.config.get<string>('STUN_URLS') ??
      'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302';
    const servers: { urls: string; username?: string; credential?: string }[] =
      stun.split(',').filter(Boolean).map((urls) => ({ urls: urls.trim() }));
    const turn = this.config.get<string>('TURN_URLS');
    if (turn) {
      servers.push({
        urls: turn,
        username: this.config.get<string>('TURN_USERNAME') ?? undefined,
        credential: this.config.get<string>('TURN_CREDENTIAL') ?? undefined,
      });
    }
    return { iceServers: servers };
  }

  incomingInvites(userId: string) {
    return this.prisma.squadInvite.findMany({
      where: { toUserId: userId, status: 'pending' },
      include: {
        fromUser: { select: { id: true, name: true, avatarUrl: true, avatarConfig: true } },
        squad: { include: { members: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  joinRequests(leaderId: string, squadId: string) {
    return this.requireLeaderOrThrow(squadId, leaderId).then(() =>
      this.prisma.squadJoinRequest.findMany({
        where: { squadId, status: 'pending' },
        include: {
          fromUser: { select: { id: true, name: true, avatarUrl: true } },
        },
      }),
    );
  }

  async mySquad(userId: string) {
    const membership = await this.prisma.squadMember.findFirst({
      where: { userId },
      include: {
        squad: {
          include: {
            members: {
              include: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    avatarUrl: true,
                    avatarConfig: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    return membership?.squad ?? null;
  }

  private async requireLeaderOrThrow(squadId: string, userId: string) {
    const member = await this.prisma.squadMember.findUnique({
      where: { squadId_userId: { squadId, userId } },
    });
    if (!member?.isLeader)
      throw new ForbiddenException('Only the squad leader can do this');
    return member;
  }

  async invite(fromUserId: string, toUserId: string) {
    if (fromUserId === toUserId)
      throw new BadRequestException('Cannot invite yourself');

    const membership = await this.prisma.squadMember.findFirst({
      where: { userId: fromUserId },
    });
    let squadId: string;

    if (!membership) {
      const squad = await this.prisma.squad.create({
        data: { members: { create: [{ userId: fromUserId, isLeader: true }] } },
      });
      squadId = squad.id;
      this.presence.setInSquad(fromUserId, true);
    } else {
      squadId = membership.squadId;
    }

    const size = await this.prisma.squadMember.count({ where: { squadId } });
    if (size >= SQUAD_MAX_SIZE) throw new BadRequestException('Squad is full');

    const isLeader = membership?.isLeader ?? true;
    if (!isLeader) {
      const request = await this.prisma.squadJoinRequest.create({
        data: { squadId, fromUserId: toUserId, viaMemberId: membership!.id },
      });
      const leader = await this.prisma.squadMember.findFirst({
        where: { squadId, isLeader: true },
      });
      if (leader)
        this.emitter.emitToUser(leader.userId, {
          type: 'squad.join_request.created',
          request,
        });
      return request;
    }

    const invite = await this.prisma.squadInvite.create({
      data: { squadId, fromUserId, toUserId },
    });
    this.emitter.emitToUser(toUserId, { type: 'squad.invite.created', invite });
    const from = await this.prisma.user.findUnique({
      where: { id: fromUserId },
      select: { name: true },
    });
    await this.notifications.create({
      userId: toUserId,
      category: 'squad',
      titleEn: `${from?.name ?? 'A player'} invited you to a squad`,
      titleAr: `${from?.name ?? 'لاعب'} دعاك إلى سكواد`,
      deepLink: `/app`,
      payload: { inviteId: invite.id, squadId },
    });
    return invite;
  }

  async respondInvite(userId: string, inviteId: string, accept: boolean) {
    const invite = await this.prisma.squadInvite.findUnique({
      where: { id: inviteId },
    });
    if (!invite) throw new NotFoundException('Invite not found');
    if (invite.toUserId !== userId)
      throw new ForbiddenException('Not your invite');
    if (invite.status !== 'pending')
      throw new BadRequestException('Already resolved');

    if (accept) {
      // Switching squads has to go through leave(), not a bare member delete:
      // deleting a leader's row directly strands their old squad with members
      // and no leader, so nobody can ever invite, kick or approve in it again.
      const existingMembership = await this.prisma.squadMember.findFirst({
        where: { userId },
      });
      if (existingMembership && existingMembership.squadId === invite.squadId)
        throw new BadRequestException('Already in this squad');
      if (existingMembership)
        await this.leave(userId, existingMembership.squadId);

      // Seat check, seat claim and marking the invite used are one atomic step.
      // Otherwise N pending invites all pass a stale count and overflow the
      // lobby — and a failure here would leave the invite "accepted" for a
      // squad the player never actually got into, with no way to retry.
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT 1 FROM "Squad" WHERE "id" = ${invite.squadId} FOR UPDATE`;
        const squad = await tx.squad.findUnique({
          where: { id: invite.squadId },
        });
        if (!squad) throw new NotFoundException('Squad no longer exists');
        const size = await tx.squadMember.count({
          where: { squadId: invite.squadId },
        });
        if (size >= SQUAD_MAX_SIZE)
          throw new BadRequestException('Squad is full');
        await tx.squadMember.create({
          data: { squadId: invite.squadId, userId },
        });
        await tx.squadInvite.update({
          where: { id: inviteId },
          data: { status: 'accepted' },
        });
      });
      this.presence.setInSquad(userId, true);
    } else {
      await this.prisma.squadInvite.update({
        where: { id: inviteId },
        data: { status: 'declined' },
      });
    }

    this.emitter.emitToUser(invite.fromUserId, {
      type: 'squad.invite.resolved',
      inviteId,
      status: accept ? 'accepted' : 'declined',
    });
    return { accepted: accept };
  }

  async resolveJoinRequest(
    leaderId: string,
    requestId: string,
    approve: boolean,
  ) {
    const request = await this.prisma.squadJoinRequest.findUnique({
      where: { id: requestId },
    });
    if (!request) throw new NotFoundException('Request not found');
    await this.requireLeaderOrThrow(request.squadId, leaderId);

    if (request.status !== 'pending')
      throw new BadRequestException('Request already resolved');

    await this.prisma.squadJoinRequest.update({
      where: { id: requestId },
      data: {
        status: approve ? 'accepted' : 'declined',
        resolvedByUserId: leaderId,
      },
    });

    if (!approve) {
      this.emitter.emitToUser(request.fromUserId, {
        type: 'squad.join_request.resolved',
        requestId,
        status: 'declined',
      });
      return { approved: false, invited: false };
    }

    // A member suggested this player; the leader has now agreed to ask them.
    // That is still only half the consent — the player themselves never asked
    // for any of this, so they get a normal invite to accept or decline rather
    // than being dropped straight into a live voice lobby.
    const invite = await this.prisma.squadInvite.create({
      data: {
        squadId: request.squadId,
        fromUserId: leaderId,
        toUserId: request.fromUserId,
      },
    });
    this.emitter.emitToUser(request.fromUserId, {
      type: 'squad.invite.created',
      invite,
    });
    const leader = await this.prisma.user.findUnique({
      where: { id: leaderId },
      select: { name: true },
    });
    await this.notifications
      .create({
        userId: request.fromUserId,
        category: 'squad',
        titleEn: `${leader?.name ?? 'A player'} invited you to a squad`,
        titleAr: `${leader?.name ?? 'لاعب'} دعاك إلى سكواد`,
        deepLink: '/app',
        payload: { inviteId: invite.id, squadId: request.squadId },
      })
      .catch(() => undefined);
    return { approved: true, invited: true };
  }

  async kick(leaderId: string, squadId: string, userId: string) {
    await this.requireLeaderOrThrow(squadId, leaderId);
    if (userId === leaderId)
      throw new BadRequestException(
        'Leader cannot kick themselves — use leave or transfer leadership',
      );
    await this.prisma.squadMember.delete({
      where: { squadId_userId: { squadId, userId } },
    });
    this.presence.setInSquad(userId, false);
    this.emitter.emitToRoom(`squad:${squadId}`, {
      type: 'squad.member.kicked',
      squadId,
      userId,
    });
  }

  async makeLeader(leaderId: string, squadId: string, userId: string) {
    await this.requireLeaderOrThrow(squadId, leaderId);
    await this.prisma.$transaction([
      this.prisma.squadMember.update({
        where: { squadId_userId: { squadId, userId: leaderId } },
        data: { isLeader: false },
      }),
      this.prisma.squadMember.update({
        where: { squadId_userId: { squadId, userId } },
        data: { isLeader: true },
      }),
    ]);
    this.emitter.emitToRoom(`squad:${squadId}`, {
      type: 'squad.leader.changed',
      squadId,
      userId,
    });
  }

  async setMemberMuted(
    leaderId: string,
    squadId: string,
    userId: string,
    muted: boolean,
  ) {
    await this.requireLeaderOrThrow(squadId, leaderId);
    await this.prisma.squadMember.update({
      where: { squadId_userId: { squadId, userId } },
      data: { micMuted: muted },
    });
    this.emitter.emitToRoom(`squad:${squadId}`, {
      type: 'squad.member.muted',
      squadId,
      userId,
      muted,
    });
  }

  async toggleOwnMic(userId: string, squadId: string, muted: boolean) {
    await this.prisma.squadMember.update({
      where: { squadId_userId: { squadId, userId } },
      data: { micMuted: muted },
    });
    this.emitter.emitToRoom(`squad:${squadId}`, {
      type: 'squad.member.muted',
      squadId,
      userId,
      muted,
    });
  }

  async leave(userId: string, squadId: string) {
    const member = await this.prisma.squadMember.findUnique({
      where: { squadId_userId: { squadId, userId } },
    });
    if (!member) throw new NotFoundException('Not a member of this squad');

    if (member.isLeader) {
      const next = await this.prisma.squadMember.findFirst({
        where: { squadId, userId: { not: userId } },
      });
      if (next) {
        await this.prisma.squadMember.update({
          where: { id: next.id },
          data: { isLeader: true },
        });
      }
    }
    await this.prisma.squadMember.delete({ where: { id: member.id } });
    this.presence.setInSquad(userId, false);

    const remaining = await this.prisma.squadMember.count({
      where: { squadId },
    });
    if (remaining === 0)
      await this.prisma.squad.delete({ where: { id: squadId } });
  }
}
