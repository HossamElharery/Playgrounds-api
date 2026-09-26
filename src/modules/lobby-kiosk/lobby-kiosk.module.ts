import { Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Subscription } from 'rxjs';
import { LobbyWorldModule } from '../lobby-world/lobby-world.module';
import { LobbyWorldService } from '../lobby-world/lobby-world.service';
import { SquadModule } from '../squad/squad.module';
import { SquadService } from '../squad/squad.service';
import { KIOSK_BALL_BOX } from './kiosk-layout';
import { lobbyKioskEnabled } from './lobby-kiosk-flags';
import { LobbyKioskGateway } from './lobby-kiosk.gateway';
import { LobbyKioskService } from './lobby-kiosk.service';

@Module({
  imports: [SquadModule, LobbyWorldModule],
  providers: [LobbyKioskService, LobbyKioskGateway],
  exports: [LobbyKioskService],
})
export class LobbyKioskModule implements OnModuleInit, OnModuleDestroy {
  private readonly subs = new Subscription();

  constructor(
    private readonly config: ConfigService,
    private readonly squads: SquadService,
    private readonly kiosk: LobbyKioskService,
    private readonly world: LobbyWorldService,
  ) {}

  /**
   * Squads already announce leave / empty on `membershipEnded$` (the same path
   * Lobby World uses). The kiosk drops its memory there instead of a second leave hook.
   * While the flag is on, the ball treats the booth as a solid.
   */
  onModuleInit(): void {
    this.subs.add(
      this.squads.membershipEnded$.subscribe(({ squadId, userId, squadEmptied }) => {
        if (squadEmptied) this.kiosk.squadEmptied(squadId);
        else this.kiosk.memberLeft(squadId, userId);
      }),
    );
    if (lobbyKioskEnabled(this.config)) this.world.setBallBoxes([KIOSK_BALL_BOX]);
  }

  onModuleDestroy(): void {
    this.subs.unsubscribe();
  }
}
