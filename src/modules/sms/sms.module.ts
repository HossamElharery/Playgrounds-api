import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OTP_DELIVERY } from './otp-delivery.interface';
import { ConsoleOtpDeliveryProvider } from './console-otp-delivery.provider';
import { TwilioVerifyOtpDeliveryProvider } from './twilio-verify-otp-delivery.provider';

@Module({
  providers: [
    ConsoleOtpDeliveryProvider,
    TwilioVerifyOtpDeliveryProvider,
    {
      provide: OTP_DELIVERY,
      inject: [
        ConfigService,
        ConsoleOtpDeliveryProvider,
        TwilioVerifyOtpDeliveryProvider,
      ],
      useFactory: (
        config: ConfigService,
        consoleProvider: ConsoleOtpDeliveryProvider,
        twilioProvider: TwilioVerifyOtpDeliveryProvider,
      ) =>
        config.get<string>('OTP_PROVIDER', 'console') === 'twilio_verify'
          ? twilioProvider
          : consoleProvider,
    },
  ],
  exports: [OTP_DELIVERY],
})
export class SmsModule {}
