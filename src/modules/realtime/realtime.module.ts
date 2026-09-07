import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeGatewayEmitter } from './realtime-emitter.interface';

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
    { provide: RealtimeGatewayEmitter, useExisting: RealtimeGateway },
  ],
  exports: [RealtimeGatewayEmitter],
})
export class RealtimeModule {}
