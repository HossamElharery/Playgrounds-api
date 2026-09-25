import { Module, OnModuleInit } from '@nestjs/common';
import { SquadModule } from '../squad/squad.module';
import { SquadService } from '../squad/squad.service';
import { LobbyWorldController } from './lobby-world.controller';
import { LobbyWorldGateway } from './lobby-world.gateway';
import { LobbyWorldService } from './lobby-world.service';

@Module({
  imports: [SquadModule],
  providers: [LobbyWorldService, LobbyWorldGateway],
  controllers: [LobbyWorldController],
  exports: [LobbyWorldService],
})
export class LobbyWorldModule implements OnModuleInit {
  constructor(
    private readonly squads: SquadService,
    private readonly world: LobbyWorldService,
  ) {}

  /** Positions die with the membership (left, kicked, dropped) or the squad itself. */
  onModuleInit(): void {
    this.squads.membershipEnded$.subscribe(
      ({ squadId, userId, squadEmptied }) => {
        if (squadEmptied) this.world.squadEmptied(squadId);
        else this.world.memberLeft(squadId, userId);
      },
    );
  }
}
