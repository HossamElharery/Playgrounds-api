import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../../common/guards/auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { PostsService } from './posts.service';
import { FollowService } from './follow.service';
import { CreatePostDto } from './dto/create-post.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { CreatePostReportDto } from './dto/create-report.dto';
import {
  ListCommentsQueryDto,
  ListHashtagPostsQueryDto,
  ListPostsQueryDto,
} from './dto/list-posts-query.dto';
import { CursorPaginationQueryDto } from '../../common/pagination/cursor-pagination.dto';

@ApiTags('posts')
@Controller()
export class PostsController {
  constructor(
    private readonly posts: PostsService,
    private readonly follows: FollowService,
  ) {}

  @Public()
  @Get('posts/feed')
  feed(
    @Query() q: ListPostsQueryDto,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    return this.posts.feed(q.tab, q.cursor, q.limit, user);
  }

  @Public()
  @Get('posts/explore')
  explore(@CurrentUser() user?: AuthenticatedUser) {
    return this.posts.explore(user);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Get('posts/composer-status')
  composerStatus(@CurrentUser() user: AuthenticatedUser) {
    return this.posts.postingStatus(user.id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Get('posts/mentions')
  mentions(@Query('q') q: string) {
    return this.posts.searchMentions(q || '');
  }

  @Public()
  @Get('posts/:id')
  get(@Param('id') id: string, @CurrentUser() user?: AuthenticatedUser) {
    return this.posts.getByParam(id, user);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('posts')
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreatePostDto) {
    const isAdmin = (user.roles ?? []).includes('admin');
    return this.posts.create(user.id, dto, isAdmin);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Patch('posts/:id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdatePostDto,
  ) {
    return this.posts.updateText(user.id, id, dto.text);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Delete('posts/:id')
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.posts.removeOwn(user.id, id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  @Post('posts/:id/likes')
  like(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.posts.like(user.id, id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Delete('posts/:id/likes/me')
  unlike(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.posts.unlike(user.id, id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Post('posts/:id/saves')
  save(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.posts.save(user.id, id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Delete('posts/:id/saves/me')
  unsave(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.posts.unsave(user.id, id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Post('posts/:id/shares')
  share(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.posts.share(user.id, id);
  }

  @Public()
  @Get('posts/:id/comments')
  comments(@Param('id') id: string, @Query() q: ListCommentsQueryDto) {
    return this.posts.comments(id, q.cursor, q.limit);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @Post('posts/:id/comments')
  addComment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CreateCommentDto,
  ) {
    return this.posts.addComment(user.id, id, dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Delete('comments/:id')
  deleteComment(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.posts.deleteComment(user.id, id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @Post('posts/:id/reports')
  report(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CreatePostReportDto,
  ) {
    return this.posts.report(user.id, id, dto);
  }

  @Public()
  @Get('hashtags/trending')
  trending() {
    return this.posts.trending();
  }

  @Public()
  @Get('hashtags/:tag/posts')
  hashtagPosts(@Param('tag') tag: string, @Query() q: ListHashtagPostsQueryDto, @CurrentUser() user?: AuthenticatedUser) {
    return this.posts.listByHashtag(tag, q.cursor, q.limit, user);
  }

  @Public()
  @Get('venues/:id/posts')
  venuePosts(
    @Param('id') id: string,
    @Query() q: CursorPaginationQueryDto,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    return this.posts.listByVenue(id, q.cursor, q.limit, user);
  }

  @Public()
  @Get('users/:id/posts')
  userPosts(
    @Param('id') id: string,
    @Query() q: CursorPaginationQueryDto,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    return this.posts.listByAuthor(id, q.cursor, q.limit, user);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @Post('follows/:userId')
  follow(@CurrentUser() user: AuthenticatedUser, @Param('userId') userId: string) {
    return this.follows.follow(user.id, userId);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Delete('follows/:userId')
  unfollow(@CurrentUser() user: AuthenticatedUser, @Param('userId') userId: string) {
    return this.follows.unfollow(user.id, userId);
  }

  @Public()
  @Get('users/:id/follow-stats')
  followStats(@Param('id') id: string) {
    return this.follows.counts(id);
  }

  @Public()
  @Get('users/:id/followers')
  followers(
    @Param('id') id: string,
    @Query() q: CursorPaginationQueryDto,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    return this.follows.followers(id, q.cursor, q.limit, user?.id);
  }

  @Public()
  @Get('users/:id/following')
  following(
    @Param('id') id: string,
    @Query() q: CursorPaginationQueryDto,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    return this.follows.following(id, q.cursor, q.limit, user?.id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Get('follows/:userId')
  isFollowing(@CurrentUser() user: AuthenticatedUser, @Param('userId') userId: string) {
    return this.follows.isFollowing(user.id, userId);
  }
}
