import { Controller, Post, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { PrismaService } from '../prisma/prisma.service';
import { PresenceService } from './presence.service';

@ApiTags('presence')
@ApiBearerAuth()
@Controller('presence')
export class PresenceController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: PresenceService,
  ) {}

  /** Cheap HTTP keepalive so presence works even when the websocket proxy is down. */
  @SkipThrottle()
  @Post('heartbeat')
  async heartbeat(@CurrentUser() user: AuthenticatedUser) {
    if (!user?.id) throw new UnauthorizedException('Authentication required');
    const lastSeenAt = new Date();
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastSeenAt },
    });
    return { ok: true, presence: this.presence.stateFor(user.id, lastSeenAt) };
  }
}
