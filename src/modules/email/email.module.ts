import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { EmailService } from './email.service';
import { MAIL_TRANSPORT } from './email.tokens';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: MAIL_TRANSPORT,
      useFactory: (config: ConfigService) => {
        const host = config.get<string>('SMTP_HOST');
        if (!host) {
          // Dev default: no SMTP configured -> log instead of sending.
          return nodemailer.createTransport({ jsonTransport: true });
        }
        return nodemailer.createTransport({
          host,
          port: config.get<number>('SMTP_PORT', 587),
          secure: false,
          auth: {
            user: config.get('SMTP_USER'),
            pass: config.get('SMTP_PASS'),
          },
        });
      },
      inject: [ConfigService],
    },
    EmailService,
  ],
  exports: [EmailService],
})
export class EmailModule {}
