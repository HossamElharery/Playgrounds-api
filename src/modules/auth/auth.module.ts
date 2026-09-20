import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { WebAuthnService } from './webauthn.service';
import { SmsModule } from '../sms/sms.module';
import { SquadModule } from '../squad/squad.module';

const JwtModuleConfigured = JwtModule.registerAsync({
  imports: [ConfigModule],
  useFactory: (config: ConfigService) => ({
    secret: config.get<string>('JWT_ACCESS_SECRET'),
    signOptions: {
      expiresIn: config.get<string>('JWT_ACCESS_EXPIRES_IN', '15m') as any,
    },
  }),
  inject: [ConfigService],
});

@Module({
  imports: [SmsModule, forwardRef(() => SquadModule), JwtModuleConfigured],
    providers: [AuthService, WebAuthnService],
    controllers: [AuthController],
    exports: [AuthService, WebAuthnService, JwtModuleConfigured],
})
export class AuthModule {}
