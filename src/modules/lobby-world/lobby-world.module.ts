import { Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Subscription } from 'rxjs';
import { MorphsModule } from '../morphs/morphs.module';
import { MorphsService } from '../morphs/morphs.service';
import { RewardsModule } from '../rewards/rewards.module';
import { GameResultsService } from '../rewards/game-results.service';
import { SquadModule } from '../squad/squad.module';
import { SquadService } from '../squad/squad.service';
import { LobbyWorldController } from './lobby-world.controller';
import { LobbyWorldGateway } from './lobby-world.gateway';
import { LobbyWorldService } from './lobby-world.service';

@Module({
  imports: [SquadModule, MorphsModule, RewardsModule],
  providers: [LobbyWorldService, LobbyWorldGateway],
  controllers: [LobbyWorldController],
  exports: [LobbyWorldService],
})
export class LobbyWorldModule implements OnModuleInit, OnModuleDestroy {
  private readonly subs = new Subscription();

  constructor(
    private readonly squads: SquadService,
    private readonly morphs: MorphsService,
    private readonly world: LobbyWorldService,
    private readonly results: GameResultsService,
  ) {}

  onModuleInit(): void {
    this.world.setGameResultSink((r) => void this.results.record(r));
    this.subs.add(
      this.squads.membershipEnded$.subscribe(
        ({ squadId, userId, squadEmptied }) => {
          if (squadEmptied) this.world.squadEmptied(squadId);
          else this.world.memberLeft(squadId, userId);
        },
      ),
    );
    this.subs.add(
      this.morphs.equipped$.subscribe(({ userId, morphId }) =>
        this.world.setMorph(userId, morphId),
      ),
    );
  }

  onModuleDestroy(): void {
    this.subs.unsubscribe();
  }
}
