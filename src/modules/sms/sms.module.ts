import { Module } from '@nestjs/common';
import { OTP_DELIVERY } from './otp-delivery.interface';
import { ConsoleOtpDeliveryProvider } from './console-otp-delivery.provider';

@Module({
  providers: [
    ConsoleOtpDeliveryProvider,
    { provide: OTP_DELIVERY, useExisting: ConsoleOtpDeliveryProvider },
  ],
  exports: [OTP_DELIVERY],
})
export class SmsModule {}
