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

  isConfigured(): boolean {
    return !!this.config.get<string>('SMTP_HOST')?.trim();
  }

  async sendEmail(to: string, subject: string, html: string): Promise<void> {
    const info = await this.transport.sendMail({
      to,
      subject,
      html,
      from: this.config.get<string>('MAIL_FROM') || 'Matchena <no-reply@matchena.com>',
    });
    if ((info as { message?: unknown }).message) {
      this.logger.warn(
        `SMTP is not configured — email was not delivered. to=${to} subject="${subject}"`,
      );
    }
  }

  async sendPasswordReset(to: string, code: string, lang: 'ar' | 'en'): Promise<void> {
    const subject =
      lang === 'ar' ? 'رمز إعادة تعيين كلمة المرور — ماتشنا' : 'Your Matchena password reset code';
    await this.sendEmail(to, subject, this.resetTemplate(code, lang));
  }

  async sendWelcome(to: string, name: string, lang: 'ar' | 'en'): Promise<void> {
    const subject = lang === 'ar' ? 'أهلًا بك في ماتشنا' : 'Welcome to Matchena';
    await this.sendEmail(to, subject, this.welcomeTemplate(name, lang));
  }

  private wrap(inner: string): string {
    return `<!DOCTYPE html>
<html>
<body style="margin:0;background:#eef3ee;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef3ee;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#ffffff;border-radius:24px;border:1px solid #d5e4d7;padding:32px 28px;">
        <tr><td>
          <p style="margin:0 0 4px;color:#0f6b3e;font-size:22px;font-weight:800;letter-spacing:-0.02em;">Matchena <span style="opacity:.45;font-size:14px;font-weight:600;">ماتشنا</span></p>
          ${inner}
          <p style="margin:28px 0 0;color:#8a9a90;font-size:12px;line-height:1.5;">© Matchena · matchena.com</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  }

  private resetTemplate(code: string, lang: 'ar' | 'en'): string {
    const dir = lang === 'ar' ? 'rtl' : 'ltr';
    const title = lang === 'ar' ? 'إعادة تعيين كلمة المرور' : 'Reset your password';
    const lead =
      lang === 'ar'
        ? 'استخدم الرمز التالي خلال 10 دقائق. لو ما طلبتش العملية دي، تجاهل الرسالة.'
        : 'Use this code within 10 minutes. If you did not request it, you can ignore this email.';
    return this.wrap(`
      <div dir="${dir}">
        <h1 style="margin:16px 0 8px;font-size:20px;color:#102018;">${title}</h1>
        <p style="margin:0 0 20px;color:#4b5c52;line-height:1.55;font-size:15px;">${lead}</p>
        <p style="margin:0;padding:18px 12px;text-align:center;font-size:32px;letter-spacing:0.4em;font-weight:800;color:#0f6b3e;background:#eef7f0;border-radius:16px;">${code}</p>
      </div>`);
  }

  private welcomeTemplate(name: string, lang: 'ar' | 'en'): string {
    const dir = lang === 'ar' ? 'rtl' : 'ltr';
    const safe = name.replace(/[<>&"]/g, '');
    const title = lang === 'ar' ? `أهلًا ${safe}` : `Welcome, ${safe}`;
    const lead =
      lang === 'ar'
        ? 'حسابك جاهز. احجز ملعب، انضم لماتش، أو كمّل ملفك من التطبيق.'
        : 'Your account is ready. Book a pitch, join a match, or finish your profile in the app.';
    return this.wrap(`
      <div dir="${dir}">
        <h1 style="margin:16px 0 8px;font-size:20px;color:#102018;">${title}</h1>
        <p style="margin:0;color:#4b5c52;line-height:1.55;font-size:15px;">${lead}</p>
      </div>`);
  }
}
