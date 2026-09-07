import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Transporter } from 'nodemailer';
import { MAIL_TRANSPORT } from './email.tokens';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    @Inject(MAIL_TRANSPORT) private readonly transport: Transporter,
    private readonly config: ConfigService,
  ) {}

  async sendEmail(to: string, subject: string, html: string): Promise<void> {
    const info = await this.transport.sendMail({
      to,
      subject,
      html,
      from: this.config.get<string>('MAIL_FROM'),
    });
    if (info.message) {
      this.logger.debug(`[dev email:no-smtp] to=${to} subject="${subject}"`);
    }
  }
}
