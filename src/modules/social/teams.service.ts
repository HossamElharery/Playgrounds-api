import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTeamDto } from './dto/create-team.dto';
import { CreateChallengeDto } from './dto/create-challenge.dto';

@Injectable()
export class TeamsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(captainId: string, dto: CreateTeamDto) {
    const thread = await this.prisma.chatThread.create({
      data: {
        type: 'team',
        title: dto.name,
        participants: { create: [{ userId: captainId }] },
      },
    });
    return this.prisma.team.create({
      data: {
        name: dto.name,
        logoUrl: dto.logoUrl,
        sportId: dto.sportId,
        captainId,
        chatThreadId: thread.id,
        members: { create: [{ userId: captainId }] },
      },
    });
  }

  list(sportId?: string) {
    return this.prisma.team.findMany({
      where: sportId ? { sportId } : undefined,
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
      include: {
        members: {
          include: {
            user: { select: { id: true, name: true, avatarUrl: true } },
          },
        },
        captain: { select: { id: true, name: true } },
      },
    });
    if (!team) throw new NotFoundException('Team not found');
    return team;
  }

  mine(userId: string) {
    return this.prisma.team.findMany({
      where: { members: { some: { userId } } },
      include: { members: true },
    });
  }

  async addMember(captainId: string, teamId: string, userId: string) {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) throw new NotFoundException('Team not found');
    if (team.captainId !== captainId)
      throw new ForbiddenException('Only the captain can manage the roster');
    return this.prisma.teamMember.upsert({
      where: { teamId_userId: { teamId, userId } },
      update: {},
      create: { teamId, userId },
    });
  }

  async removeMember(captainId: string, teamId: string, userId: string) {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) throw new NotFoundException('Team not found');
    if (team.captainId !== captainId)
      throw new ForbiddenException('Only the captain can manage the roster');
    if (userId === captainId)
      throw new BadRequestException('Captain cannot leave their own team');
    return this.prisma.teamMember.delete({
      where: { teamId_userId: { teamId, userId } },
    });
  }

  async createChallenge(
    captainId: string,
    teamId: string,
    dto: CreateChallengeDto,
  ) {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) throw new NotFoundException('Team not found');
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
    return this.prisma.teamChallenge.update({
      where: { id: challengeId },
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
