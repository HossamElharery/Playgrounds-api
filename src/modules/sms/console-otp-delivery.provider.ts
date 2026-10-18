import { Injectable, Logger } from '@nestjs/common';
import { OtpDelivery } from './otp-delivery.interface';

@Injectable()
export class ConsoleOtpDeliveryProvider implements OtpDelivery {
  private readonly logger = new Logger('OTP');

  async send(target: string, code: string): Promise<void> {
    this.logger.log(`OTP for ${target}: ${code}`);
  }
}
