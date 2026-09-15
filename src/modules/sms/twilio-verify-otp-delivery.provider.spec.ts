import { ConfigService } from '@nestjs/config';
import { TwilioVerifyOtpDeliveryProvider } from './twilio-verify-otp-delivery.provider';

describe('TwilioVerifyOtpDeliveryProvider', () => {
  const originalFetch = global.fetch;
  let provider: TwilioVerifyOtpDeliveryProvider;

  beforeEach(() => {
    provider = new TwilioVerifyOtpDeliveryProvider(
      new ConfigService({
        TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
        TWILIO_AUTH_TOKEN: 'test-auth-token-value',
        TWILIO_VERIFY_SERVICE_SID: `VA${'b'.repeat(32)}`,
      }),
    );
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('starts an SMS verification without exposing the locally generated code', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ status: 'pending' }), { status: 201 }),
      );

    await provider.send('+201001234567', '1234');

    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toContain('/Verifications');
    expect(String(options.body)).toContain('To=%2B201001234567');
    expect(String(options.body)).toContain('Channel=sms');
    expect(String(options.body)).not.toContain('Code=');
  });

  it('accepts only codes approved by Twilio Verify', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ status: 'approved' }), { status: 200 }),
      );

    await expect(provider.verify('+201001234567', '654321')).resolves.toBe(
      true,
    );
  });

  it('treats a rejected verification check as an invalid code', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'pending', code: 20404 }), {
        status: 404,
      }),
    );

    await expect(provider.verify('+201001234567', '000000')).resolves.toBe(
      false,
    );
  });
});
