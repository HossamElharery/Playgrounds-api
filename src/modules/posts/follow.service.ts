import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class FollowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async follow(followerId: string, followingId: string) {
    if (followerId === followingId) {
      throw new BadRequestException('Cannot follow yourself');
    }
    const target = await this.prisma.user.findUnique({
      where: { id: followingId },
      select: { id: true, status: true },
    });
    if (!target || target.status !== 'active') {
      throw new NotFoundException('User not found');
    }
    const created = await this.prisma.follow.upsert({
      where: { followerId_followingId: { followerId, followingId } },
      update: {},
      create: { followerId, followingId },
    });
    if (created.createdAt.getTime() > Date.now() - 1500) {
      await this.notifications.create({
        userId: followingId,
        category: 'posts',
        titleEn: 'New follower',
        titleAr: 'متابع جديد',
        deepLink: `/app/profile/${followerId}`,
        payload: { followerId },
      });
    }
    return { following: true };
  }

  async unfollow(followerId: string, followingId: string) {
    await this.prisma.follow.deleteMany({ where: { followerId, followingId } });
    return { following: false };
  }

  async isFollowing(followerId: string, followingId: string) {
    const row = await this.prisma.follow.findUnique({
      where: { followerId_followingId: { followerId, followingId } },
    });
    return { following: !!row };
  }

  async counts(userId: string) {
    const [followers, following] = await Promise.all([
      this.prisma.follow.count({ where: { followingId: userId } }),
      this.prisma.follow.count({ where: { followerId: userId } }),
    ]);
    return { followers, following };
  }

  async followers(userId: string, cursor?: string, limit = 30, viewerId?: string) {
    return this.list(userId, 'followers', cursor, limit, viewerId);
  }

  async following(userId: string, cursor?: string, limit = 30, viewerId?: string) {
    return this.list(userId, 'following', cursor, limit, viewerId);
  }

  private async list(
    userId: string,
    direction: 'followers' | 'following',
    cursor: string | undefined,
    limit: number,
    viewerId?: string,
  ) {
    const take = Math.min(Math.max(limit, 1), 50);
    const rows = await this.prisma.follow.findMany({
      where: direction === 'followers' ? { followingId: userId } : { followerId: userId },
      include: {
        follower: { select: { id: true, name: true, username: true, avatarUrl: true } },
        following: { select: { id: true, name: true, username: true, avatarUrl: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(cursor
        ? {
            cursor: {
              followerId_followingId:
                direction === 'followers'
                  ? { followerId: cursor, followingId: userId }
                  : { followerId: userId, followingId: cursor },
            },
            skip: 1,
          }
        : {}),
    });
    const page = rows.slice(0, take);
    const items = await Promise.all(
      page.map(async (row) => {
        const user = direction === 'followers' ? row.follower : row.following;
        const followingViewer = viewerId
          ? !!(await this.prisma.follow.findUnique({
              where: {
                followerId_followingId: { followerId: viewerId, followingId: user.id },
              },
            }))
          : false;
        return { ...user, following: followingViewer };
      }),
    );
    const nextId =
      direction === 'followers'
        ? page[page.length - 1]?.followerId
        : page[page.length - 1]?.followingId;
    return {
      items,
      nextCursor: rows.length > take ? nextId : undefined,
    };
  }
}
