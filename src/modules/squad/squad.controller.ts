import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../../common/guards/auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { SquadService } from './squad.service';
import { InviteToSquadDto } from './dto/invite.dto';

@ApiTags('squad')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('squad')
export class SquadController {
  constructor(private readonly squad: SquadService) {}

  @Get('invites')
  myInvites(@CurrentUser() user: AuthenticatedUser) {
    return this.squad.incomingInvites(user.id);
  }

  @Get('ice-servers')
  iceServers() {
    return this.squad.iceServers();
  }

  @Get('mine')
  mine(@CurrentUser() user: AuthenticatedUser) {
    return this.squad.mySquad(user.id);
  }

  @Get(':squadId/join-requests')
  listJoinRequests(
    @CurrentUser() user: AuthenticatedUser,
    @Param('squadId') squadId: string,
  ) {
    return this.squad.joinRequests(user.id, squadId);
  }

  @Post('invites')
  invite(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: InviteToSquadDto,
  ) {
    return this.squad.invite(user.id, dto.toUserId);
  }

  @Post('invites/:id/accept')
  accept(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.squad.respondInvite(user.id, id, true);
  }

  @Post('invites/:id/decline')
  decline(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.squad.respondInvite(user.id, id, false);
  }

  @Post('join-requests/:id/approve')
  approveJoin(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.squad.resolveJoinRequest(user.id, id, true);
  }

  @Post('join-requests/:id/decline')
  declineJoin(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.squad.resolveJoinRequest(user.id, id, false);
  }

  @Post(':squadId/kick/:userId')
  kick(
    @CurrentUser() user: AuthenticatedUser,
    @Param('squadId') squadId: string,
    @Param('userId') userId: string,
  ) {
    return this.squad.kick(user.id, squadId, userId);
  }

  @Post(':squadId/make-leader/:userId')
  makeLeader(
    @CurrentUser() user: AuthenticatedUser,
    @Param('squadId') squadId: string,
    @Param('userId') userId: string,
  ) {
    return this.squad.makeLeader(user.id, squadId, userId);
  }

  @Patch(':squadId/mute/:userId')
  muteMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('squadId') squadId: string,
    @Param('userId') userId: string,
    @Body('muted') muted: boolean,
  ) {
    return this.squad.setMemberMuted(user.id, squadId, userId, muted);
  }

  @Patch(':squadId/mic')
  toggleMic(
    @CurrentUser() user: AuthenticatedUser,
    @Param('squadId') squadId: string,
    @Body('muted') muted: boolean,
  ) {
    return this.squad.toggleOwnMic(user.id, squadId, muted);
  }

  @Post(':squadId/leave')
  leave(
    @CurrentUser() user: AuthenticatedUser,
    @Param('squadId') squadId: string,
  ) {
    return this.squad.leave(user.id, squadId);
  }
}
