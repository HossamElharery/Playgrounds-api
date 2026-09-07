import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../../common/guards/auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { ReviewsService } from './reviews.service';
import { CreateVenueReviewDto } from './dto/create-venue-review.dto';
import { OwnerReplyDto } from './dto/owner-reply.dto';
import { CreatePlayerRatingDto } from './dto/create-player-rating.dto';
import { PageQueryDto } from '../../common/dto/page-query.dto';

@ApiTags('reviews')
@Controller()
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

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
  reply(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: OwnerReplyDto,
  ) {
    return this.reviews.ownerReply(
      id,
      user.id,
      user.roles.includes('admin'),
      dto.text,
    );
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
