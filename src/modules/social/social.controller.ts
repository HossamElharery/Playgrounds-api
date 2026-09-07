import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../../common/guards/auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { FriendsService } from './friends.service';
import { MatchPostsService } from './match-posts.service';
import { TeamsService } from './teams.service';
import { SendFriendRequestDto } from './dto/send-friend-request.dto';
import { CreateMatchPostDto } from './dto/create-match-post.dto';
import { CreateTeamDto } from './dto/create-team.dto';
import { CreateChallengeDto } from './dto/create-challenge.dto';
import {
  CreateCommentDto,
  ToggleReactionDto,
} from './dto/create-comment.dto';
import {
  ListFriendRequestsQueryDto,
  ListFriendsQueryDto,
  MatchFeedQueryDto,
} from './dto/list-queries.dto';
import { clampLimit } from '../../common/utils/page-limit.util';

@ApiTags('social')
@Controller()
@ApiBearerAuth()
export class SocialController {
  constructor(
    private readonly friends: FriendsService,
    private readonly matchPosts: MatchPostsService,
    private readonly teams: TeamsService,
  ) {}

  @UseGuards(AuthGuard)
  @Get('friends')
  listFriends(
    @CurrentUser() user: AuthenticatedUser,
    @Query() q: ListFriendsQueryDto,
  ) {
    return this.friends.listFriends(user.id, q.status, q.query);
  }

  @UseGuards(AuthGuard)
  @Post('friends/requests')
  sendRequest(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SendFriendRequestDto,
  ) {
    return this.friends.sendRequest(user.id, dto.addresseeId);
  }

  @UseGuards(AuthGuard)
  @Get('friend-requests')
  listIncoming(
    @CurrentUser() user: AuthenticatedUser,
    @Query() q: ListFriendRequestsQueryDto,
  ) {
    return this.friends.listIncoming(user.id, q.direction ?? 'incoming');
  }

  @UseGuards(AuthGuard)
  @Post('friend-requests/:requestId/accept')
  accept(
    @CurrentUser() user: AuthenticatedUser,
    @Param('requestId') requestId: string,
  ) {
    return this.friends.respond(user.id, requestId, true);
  }

  @UseGuards(AuthGuard)
  @Post('friend-requests/:requestId/decline')
  decline(
    @CurrentUser() user: AuthenticatedUser,
    @Param('requestId') requestId: string,
  ) {
    return this.friends.respond(user.id, requestId, false);
  }

  @UseGuards(AuthGuard)
  @Post('friend-requests/:requestId/cancel')
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('requestId') requestId: string,
  ) {
    return this.friends.cancel(user.id, requestId);
  }

  @UseGuards(AuthGuard)
  @Delete('friends/:userId')
  unfriend(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId') otherUserId: string,
  ) {
    return this.friends.unfriend(user.id, otherUserId);
  }

  @Public()
  @Get('feed/matches')
  feed(@Query() q: MatchFeedQueryDto) {
    return this.matchPosts.feed({
      sportId: q.sportId,
      districtId: q.districtId,
      status: q.status,
    });
  }

  @UseGuards(AuthGuard)
  @Get('matches/mine/list')
  myMatches(@CurrentUser() user: AuthenticatedUser) {
    return this.matchPosts.mine(user.id);
  }

  @Public()
  @Get('matches/:id')
  getMatch(@Param('id') id: string) {
    return this.matchPosts.getById(id);
  }

  @UseGuards(AuthGuard)
  @Post('matches')
  createMatch(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateMatchPostDto,
  ) {
    return this.matchPosts.create(user.id, dto);
  }

  @UseGuards(AuthGuard)
  @Post('matches/:id/join')
  requestJoin(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.matchPosts.requestJoin(user.id, id);
  }

  @UseGuards(AuthGuard)
  @Post('matches/:id/leave')
  leaveMatch(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.matchPosts.leave(user.id, id);
  }

  @UseGuards(AuthGuard)
  @Post('matches/join-requests/:requestId/approve')
  approveJoin(
    @CurrentUser() user: AuthenticatedUser,
    @Param('requestId') requestId: string,
  ) {
    return this.matchPosts.resolveJoin(user.id, requestId, true);
  }

  @UseGuards(AuthGuard)
  @Post('matches/join-requests/:requestId/decline')
  declineJoin(
    @CurrentUser() user: AuthenticatedUser,
    @Param('requestId') requestId: string,
  ) {
    return this.matchPosts.resolveJoin(user.id, requestId, false);
  }

  @UseGuards(AuthGuard)
  @Post('matches/:id/played')
  markPlayed(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.matchPosts.markPlayed(user.id, id);
  }

  @UseGuards(AuthGuard)
  @Post('matches/:id/cancel')
  cancelMatch(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.matchPosts.cancel(user.id, id);
  }

  @Public()
  @Get('matches/:id/comments')
  listComments(
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.matchPosts.listComments(id, cursor, clampLimit(limit, 30, 100));
  }

  @UseGuards(AuthGuard)
  @Post('matches/:id/comments')
  addComment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CreateCommentDto,
  ) {
    return this.matchPosts.addComment(user.id, id, dto.text);
  }

  @UseGuards(AuthGuard)
  @Delete('comments/:commentId')
  deleteComment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('commentId') commentId: string,
  ) {
    return this.matchPosts.deleteComment(user.id, commentId);
  }

  @Public()
  @Get('matches/:id/reactions')
  listReactions(@Param('id') id: string) {
    return this.matchPosts.listReactions(id);
  }

  @UseGuards(AuthGuard)
  @Post('matches/:id/reactions')
  toggleReaction(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ToggleReactionDto,
  ) {
    return this.matchPosts.toggleReaction(user.id, id, dto.emoji ?? 'like');
  }

  @UseGuards(AuthGuard)
  @Post('teams')
  createTeam(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateTeamDto,
  ) {
    return this.teams.create(user.id, dto);
  }

  @Public()
  @Get('teams')
  listTeams(@Query('sportId') sportId?: string) {
    return this.teams.list(sportId);
  }

  @UseGuards(AuthGuard)
  @Get('teams/mine/list')
  myTeams(@CurrentUser() user: AuthenticatedUser) {
    return this.teams.mine(user.id);
  }

  @Public()
  @Get('teams/:id')
  getTeam(@Param('id') id: string) {
    return this.teams.getById(id);
  }

  @Public()
  @Get('teams/:aId/head-to-head/:bId')
  headToHead(@Param('aId') aId: string, @Param('bId') bId: string) {
    return this.teams.headToHead(aId, bId);
  }

  @UseGuards(AuthGuard)
  @Post('teams/:id/members/:userId')
  addMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    return this.teams.addMember(user.id, id, userId);
  }

  @UseGuards(AuthGuard)
  @Delete('teams/:id/members/:userId')
  removeMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    return this.teams.removeMember(user.id, id, userId);
  }

  @UseGuards(AuthGuard)
  @Post('teams/:id/challenges')
  challenge(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CreateChallengeDto,
  ) {
    return this.teams.createChallenge(user.id, id, dto);
  }

  @UseGuards(AuthGuard)
  @Post('teams/challenges/:challengeId/accept')
  acceptChallenge(
    @CurrentUser() user: AuthenticatedUser,
    @Param('challengeId') challengeId: string,
  ) {
    return this.teams.respondChallenge(user.id, challengeId, true);
  }

  @UseGuards(AuthGuard)
  @Post('teams/challenges/:challengeId/decline')
  declineChallenge(
    @CurrentUser() user: AuthenticatedUser,
    @Param('challengeId') challengeId: string,
  ) {
    return this.teams.respondChallenge(user.id, challengeId, false);
  }
}
