import { Controller, Get, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../../common/guards/auth.guard';
import { lobbyKioskEnabled } from '../lobby-kiosk/lobby-kiosk-flags';
import { lobbyBallEnabled, lobbyMovementEnabled } from './lobby-world-flags';

@ApiTags('lobby')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('lobby')
export class LobbyWorldController {
  constructor(private readonly config: ConfigService) {}

  /**
   * Which Lobby World stages are live. Guests may ask (they sit in lobbies too).
   * `kiosk` is independent of movement: the dock can open the panel when walking is off.
   */
  @Get('features')
  features(): { movement: boolean; ball: boolean; kiosk: boolean } {
    return {
      movement: lobbyMovementEnabled(this.config),
      ball: lobbyBallEnabled(this.config),
      kiosk: lobbyKioskEnabled(this.config),
    };
  }
}
