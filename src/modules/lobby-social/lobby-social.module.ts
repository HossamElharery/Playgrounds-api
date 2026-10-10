import { Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Subscription } from 'rxjs';
import { SquadModule } from '../squad/squad.module';
import { SquadService } from '../squad/squad.service';
import { LobbySocialService } from './lobby-social.service';
import { LobbySocialGateway } from './lobby-social.gateway';
import { PresenceModule } from '../presence/presence.module';
import { PresenceService } from '../presence/presence.service';
import { SocialContentController, SocialContentService } from './social-content.controller';

@Module({ imports: [SquadModule, PresenceModule], controllers:[SocialContentController], providers: [LobbySocialService, LobbySocialGateway, SocialContentService], exports: [LobbySocialService] })
export class LobbySocialModule implements OnModuleInit, OnModuleDestroy {
  private readonly sub = new Subscription();
  constructor(private readonly squads: SquadService, private readonly social: LobbySocialService, private readonly presence: PresenceService) {}
  onModuleInit(): void {
    this.sub.add(this.squads.membershipEnded$.subscribe(({ squadId, userId }) => {
      void this.social.memberLeft(squadId, userId).catch(() => undefined);
    }));
    this.sub.add(this.presence.connection$.subscribe(({userId, connected}) => {
      void this.social.connectionChanged(userId, connected).catch(() => undefined);
    }));
  }
  onModuleDestroy(): void { this.sub?.unsubscribe(); }
}
