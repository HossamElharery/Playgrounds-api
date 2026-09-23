import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailService } from './email.service';

describe('EmailService', () => {
  const sendMail = jest.fn().mockResolvedValue({ messageId: 'm1' });
  const config = {
    get: (key: string, fallback?: unknown) =>
      ({
        MAIL_FROM: 'Matchena <no-reply@matchena.com>',
        MAIL_REPLY_TO: 'support@matchena.com',
        SITE_URL: 'https://matchena.com',
      })[key] ?? fallback,
  } as ConfigService;
  const service = new EmailService({ sendMail } as never, config);

  beforeEach(() => sendMail.mockClear());

  it('sends a bilingual verification template with text fallback', async () => {
    await service.sendVerificationCode('player@example.com', '1234', 5);

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'player@example.com',
        from: 'Matchena <no-reply@matchena.com>',
        replyTo: 'support@matchena.com',
        subject: expect.stringContaining('1234'),
        text: expect.stringContaining('1234'),
        html: expect.stringContaining('Confirm your email'),
      }),
    );
    expect(sendMail.mock.calls[0][0].html).toContain('أكّد بريدك الإلكتروني');
  });

  it('logs the verification code when SMTP is not configured', async () => {
    const logger = { log: jest.spyOn(Logger.prototype, 'log').mockImplementation() };
    const local = {
      get: (key: string, fallback?: unknown) =>
        ({
          MAIL_FROM: 'Matchena <no-reply@matchena.com>',
          MAIL_REPLY_TO: 'support@matchena.com',
        })[key] ?? fallback,
    } as ConfigService;
    sendMail.mockResolvedValueOnce({ message: '{}' });
    const service = new EmailService({ sendMail } as never, local);

    await service.sendVerificationCode('player@example.com', '4321', 5);

    expect(logger.log).toHaveBeenCalledWith(
      '[dev email:no-smtp] verification for player@example.com: 4321',
    );
    logger.log.mockRestore();
  });

  it('escapes user-provided names in welcome email HTML', async () => {
    await service.sendWelcome('player@example.com', '<img src=x>');

    const html = sendMail.mock.calls[0][0].html as string;
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).not.toContain('<img src=x>');
  });

  it('emails the support inbox and sets Reply-To to the sender', async () => {
    await service.sendSupportInquiry({
      fullName: 'Omar <script>',
      email: 'omar@mail.com',
      message: 'Need help with a booking.',
    });

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'support@matchena.com',
        replyTo: 'omar@mail.com',
        subject: 'Contact · Omar <script>',
        text: expect.stringContaining('Need help with a booking.'),
      }),
    );
    const html = sendMail.mock.calls[0][0].html as string;
    expect(html).toContain('Omar &lt;script&gt;');
    expect(html).not.toContain('Omar <script>');
    expect(html).not.toContain('Phone');
  });
});

