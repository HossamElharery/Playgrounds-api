import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateVenueReviewDto } from './dto/create-venue-review.dto';
import { CreatePlayerRatingDto } from './dto/create-player-rating.dto';
import { buildPagination } from '../../common/dto/page-query.dto';

@Injectable()
export class ReviewsService {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Venue reviews (gated to a completed, checked-in booking) ----

  async createVenueReview(userId: string, dto: CreateVenueReviewDto) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: dto.bookingId },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.userId !== userId)
      throw new ForbiddenException('Not your booking');
    if (booking.status !== 'completed')
      throw new BadRequestException(
        'Review is only available after a completed, checked-in booking',
      );

    try {
      const review = await this.prisma.venueReview.create({
        data: {
          venueId: booking.venueId,
          bookingId: booking.id,
          userId,
          stars: dto.stars,
          tags: dto.tags ?? [],
          text: dto.text,
          photos: dto.photos ?? [],
        },
      });
      await this.recomputeVenueRating(booking.venueId);
      return review;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('This booking was already reviewed');
      }
      throw err;
    }
  }

  async ownerReply(
    reviewId: string,
    ownerId: string,
    isPrivileged: boolean,
    text: string,
  ) {
    const review = await this.prisma.venueReview.findUnique({
      where: { id: reviewId },
      include: { venue: true },
    });
    if (!review) throw new NotFoundException('Review not found');
    if (!isPrivileged && review.venue.ownerId !== ownerId)
      throw new ForbiddenException('Not your venue');

    return this.prisma.venueReview.update({
      where: { id: reviewId },
      data: { ownerReply: text, ownerRepliedAt: new Date() },
    });
  }

  async listForVenue(venueId: string, page = 1, perPage = 20) {
    const take = Math.min(perPage, 50);
    const [items, total] = await Promise.all([
      this.prisma.venueReview.findMany({
        where: { venueId },
        include: { user: { select: { id: true, name: true, avatarUrl: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * take,
        take,
      }),
      this.prisma.venueReview.count({ where: { venueId } }),
    ]);
    return { items, pagination: buildPagination(page, take, total) };
  }

  private async recomputeVenueRating(venueId: string) {
    const agg = await this.prisma.venueReview.aggregate({
      where: { venueId },
      _avg: { stars: true },
      _count: true,
    });
    await this.prisma.venue.update({
      where: { id: venueId },
      data: { ratingAvg: agg._avg.stars ?? 0, ratingCount: agg._count },
    });
  }

  // ---- Player-to-player ratings ----

  private async eligibleParticipants(bookingId: string): Promise<Set<string>> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { splitShares: true },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    const ids = new Set<string>([booking.userId]);
    booking.splitShares.forEach((s) => s.userId && ids.add(s.userId));
    return ids;
  }

  async ratePlayer(raterId: string, dto: CreatePlayerRatingDto) {
    if (raterId === dto.rateeId)
      throw new BadRequestException('Cannot rate yourself');
    if (!dto.bookingId && !dto.matchPostId)
      throw new BadRequestException('bookingId or matchPostId is required');

    let participants: Set<string>;
    if (dto.matchPostId) {
      const post = await this.prisma.matchPost.findUnique({
        where: { id: dto.matchPostId },
        include: { joinRequests: { where: { status: 'approved' } } },
      });
      if (!post) throw new NotFoundException('Match post not found');
      if (post.status !== 'played')
        throw new BadRequestException(
          'Ratings are only available after the match is marked played',
        );
      participants = new Set([
        post.authorId,
        ...post.joinRequests.map((j) => j.userId),
      ]);
    } else {
      const booking = await this.prisma.booking.findUnique({
        where: { id: dto.bookingId },
      });
      if (!booking) throw new NotFoundException('Booking not found');
      if (booking.status !== 'completed')
        throw new BadRequestException(
          'Ratings are only available after a completed match',
        );
      participants = await this.eligibleParticipants(dto.bookingId!);
    }

    if (!participants.has(raterId) || !participants.has(dto.rateeId)) {
      throw new ForbiddenException(
        'Both players must have been part of this match',
      );
    }

    const rating = await this.prisma.playerRating.create({
      data: {
        bookingId: dto.bookingId ?? null,
        matchPostId: dto.matchPostId ?? null,
        raterId,
        rateeId: dto.rateeId,
        sportsmanship: dto.sportsmanship,
        skill: dto.skill,
        punctuality: dto.punctuality,
        mvpVote: dto.mvpVote ?? false,
      },
    });

    if (dto.mvpVote) {
      await this.prisma.user.update({
        where: { id: dto.rateeId },
        data: { mvps: { increment: 1 } },
      });
    }

    await this.recomputeReliability(dto.rateeId);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: raterId },
        data: { coinsBalance: { increment: 10 } },
      }),
      this.prisma.coinLedgerEntry.create({
        data: {
          userId: raterId,
          amount: 10,
          reason: 'post_match_rating',
          bookingId: dto.bookingId,
        },
      }),
    ]);

    return rating;
  }

  private async recomputeReliability(userId: string) {
    const agg = await this.prisma.playerRating.aggregate({
      where: { rateeId: userId },
      _avg: { punctuality: true },
    });
    if (agg._avg.punctuality != null) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { reliabilityPct: (agg._avg.punctuality / 5) * 100 },
      });
    }
  }

  listRatingsFor(userId: string) {
    return this.prisma.playerRating.findMany({
      where: { rateeId: userId },
      include: { rater: { select: { id: true, name: true, avatarUrl: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }
}
