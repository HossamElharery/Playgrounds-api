import { Injectable, Logger } from '@nestjs/common';
import { OtpDelivery } from './otp-delivery.interface';

/**
 * Dev default: logs the OTP to the server console instead of sending a real
 * SMS/email. Lets the whole auth flow work with zero paid provider account.
 * Swap for a real provider (Twilio/etc.) by implementing OtpDelivery and
 * pointing OTP_PROVIDER at it in sms.module.ts — nothing else changes,
 * since the OTP is NEVER returned in an HTTP response (see auth.service.ts).
 */
@Injectable()
export class ConsoleOtpDeliveryProvider implements OtpDelivery {
  private readonly logger = new Logger('OTP');

  async send(target: string, code: string): Promise<void> {
    this.logger.log(`OTP for ${target}: ${code}`);
  }
}
