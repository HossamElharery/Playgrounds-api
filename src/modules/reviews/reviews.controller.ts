import { Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../../common/guards/auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { ReviewsService } from './reviews.service';
import { PrismaService } from '../prisma/prisma.service';
import { requireStaffVenue } from '../../common/access/actor-access';
import { CreateVenueReviewDto } from './dto/create-venue-review.dto';
import { OwnerReplyDto } from './dto/owner-reply.dto';
import { CreatePlayerRatingDto } from './dto/create-player-rating.dto';
import { PageQueryDto } from '../../common/dto/page-query.dto';

@ApiTags('reviews')
@Controller()
export class ReviewsController {
  constructor(
    private readonly reviews: ReviewsService,
    private readonly prisma: PrismaService,
  ) {}

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Post('reviews')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateVenueReviewDto,
  ) {
    return this.reviews.createVenueReview(user.id, dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Post('reviews/:id/reply')
  async reply(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: OwnerReplyDto,
  ) {
    let ownerId = user.id;
    if (!user.roles.includes('admin') && !user.roles.includes('owner') && user.roles.includes('staff')) {
      // A staff reply needs the "reply to reviews" key on one of their own venues.
      const review = await this.prisma.venueReview.findUnique({ where: { id }, select: { venueId: true } });
      if (!review) throw new NotFoundException('Review not found');
      const scope = await requireStaffVenue(this.prisma, user, review.venueId);
      if (!scope.permissions.includes('reviews.reply')) throw new ForbiddenException('Insufficient permissions');
      ownerId = scope.ownerId;
    }
    return this.reviews.ownerReply(id, ownerId, user.roles.includes('admin'), dto.text);
  }

  @Public()
  @Get('venues/:venueId/reviews')
  async listForVenue(
    @Param('venueId') venueId: string,
    @Query() q: PageQueryDto,
  ) {
    const { items, pagination } = await this.reviews.listForVenue(
      venueId,
      q.page,
      q.perPage,
    );
    return { message: 'ok', result: items, pagination };
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Post('ratings')
  rate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePlayerRatingDto,
  ) {
    return this.reviews.ratePlayer(user.id, dto);
  }

  @Public()
  @Get('users/:id/ratings')
  listRatings(@Param('id') id: string) {
    return this.reviews.listRatingsFor(id);
  }
}
