import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OtpDelivery } from './otp-delivery.interface';

type TwilioVerifyResponse = {
  status?: string;
  code?: number;
  message?: string;
};

@Injectable()
export class TwilioVerifyOtpDeliveryProvider implements OtpDelivery {
  private readonly logger = new Logger(TwilioVerifyOtpDeliveryProvider.name);
  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly serviceSid: string;

  constructor(config: ConfigService) {
    this.accountSid = config.get<string>('TWILIO_ACCOUNT_SID', '');
    this.authToken = config.get<string>('TWILIO_AUTH_TOKEN', '');
    this.serviceSid = config.get<string>('TWILIO_VERIFY_SERVICE_SID', '');
  }

  async send(target: string, _code: string): Promise<void> {
    const response = await this.request('Verifications', {
      To: target,
      Channel: 'sms',
    });
    if (response.status !== 'pending') {
      this.logger.error(
        `Twilio Verify rejected a send request (status=${response.status ?? 'unknown'})`,
      );
      throw new ServiceUnavailableException('Could not send verification code');
    }
  }

  async verify(target: string, code: string): Promise<boolean> {
    const response = await this.request(
      'VerificationCheck',
      { To: target, Code: code },
      true,
    );
    return response.status === 'approved';
  }

  private async request(
    resource: 'Verifications' | 'VerificationCheck',
    body: Record<string, string>,
    invalidCodeIsFalse = false,
  ): Promise<TwilioVerifyResponse> {
    if (!this.accountSid || !this.authToken || !this.serviceSid) {
      throw new ServiceUnavailableException(
        'Verification service is not configured',
      );
    }
    const url = `https://verify.twilio.com/v2/Services/${encodeURIComponent(this.serviceSid)}/${resource}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      this.logger.error(
        'Twilio Verify request failed before receiving a response',
        error,
      );
      throw new ServiceUnavailableException('Verification service unavailable');
    }

    const payload = (await response
      .json()
      .catch(() => ({}))) as TwilioVerifyResponse;
    if (!response.ok) {
      if (invalidCodeIsFalse && response.status === 404) return payload;
      this.logger.error(
        `Twilio Verify request failed (http=${response.status}, code=${payload.code ?? 'unknown'})`,
      );
      throw new ServiceUnavailableException('Verification service unavailable');
    }
    return payload;
  }
}
