import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeGatewayEmitter } from './realtime-emitter.interface';
import { VoiceScopeRegistry } from './voice-scope.registry';
import { SlotChangeRelay } from './slot-change-relay.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_ACCESS_SECRET'),
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [
    RealtimeGateway,
    SlotChangeRelay,
    VoiceScopeRegistry,
    { provide: RealtimeGatewayEmitter, useExisting: RealtimeGateway },
  ],
  exports: [RealtimeGatewayEmitter, VoiceScopeRegistry],
})
export class RealtimeModule {}
