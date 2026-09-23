import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Transporter } from 'nodemailer';
import { MAIL_TRANSPORT } from './email.tokens';

type EmailContent = {
  subject: string;
  preheader: string;
  heading: string;
  intro: string;
  bodyHtml: string;
  bodyText: string;
  footer?: string;
};

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    @Inject(MAIL_TRANSPORT) private readonly transport: Transporter,
    private readonly config: ConfigService,
  ) {}

  async sendVerificationCode(
    to: string,
    code: string,
    expiresInMinutes: number,
  ): Promise<void> {
    this.logDevCode(to, 'verification', code);
    await this.sendTemplate(to, {
      subject: `${code} is your Matchena verification code`,
      preheader: `Verify your Matchena email. This code expires in ${expiresInMinutes} minutes.`,
      heading: 'Confirm your email · أكّد بريدك الإلكتروني',
      intro:
        'Use this one-time code to finish creating your Matchena account. استخدم هذا الرمز لإكمال إنشاء حسابك.',
      bodyHtml: this.codeBlock(code, expiresInMinutes),
      bodyText: `Your Matchena verification code is ${code}. It expires in ${expiresInMinutes} minutes.\nرمز تأكيد بريدك في ماتشنا هو ${code} وينتهي خلال ${expiresInMinutes} دقائق.`,
      footer: 'If you did not request this code, you can safely ignore this email.',
    });
  }

  async sendPasswordResetCode(
    to: string,
    code: string,
    expiresInMinutes: number,
  ): Promise<void> {
    this.logDevCode(to, 'password-reset', code);
    await this.sendTemplate(to, {
      subject: `${code} is your Matchena password reset code`,
      preheader: `Reset your Matchena password. This code expires in ${expiresInMinutes} minutes.`,
      heading: 'Reset your password · إعادة تعيين كلمة المرور',
      intro:
        'Enter this one-time code in Matchena to choose a new password. أدخل هذا الرمز في ماتشنا لاختيار كلمة مرور جديدة.',
      bodyHtml: this.codeBlock(code, expiresInMinutes),
      bodyText: `Your Matchena password reset code is ${code}. It expires in ${expiresInMinutes} minutes.\nرمز إعادة تعيين كلمة مرور ماتشنا هو ${code} وينتهي خلال ${expiresInMinutes} دقائق.`,
      footer:
        'If you did not request a password reset, ignore this email and keep your password private.',
    });
  }

  async sendWelcome(to: string, name: string): Promise<void> {
    const safeName = this.escapeHtml(name);
    const siteUrl = this.config.get<string>('SITE_URL', 'https://matchena.com');
    await this.sendTemplate(to, {
      subject: 'Welcome to Matchena · أهلًا بك في ماتشنا',
      preheader: 'Your verified Matchena account is ready.',
      heading: `Welcome, ${safeName} · أهلًا بك`,
      intro:
        'Your email is verified and your account is ready. بريدك الإلكتروني اتأكد وحسابك جاهز.',
      bodyHtml: `<p style="margin:0 0 20px;color:#cbd5e1;line-height:1.8">Find a match, join your community, and book your next game.</p><a href="${this.escapeHtml(siteUrl)}" style="display:inline-block;background:#a3ff12;color:#07120b;text-decoration:none;font-weight:800;padding:13px 22px;border-radius:999px">Open Matchena · افتح ماتشنا</a>`,
      bodyText: `Welcome to Matchena, ${name}. Your email is verified and your account is ready. Open ${siteUrl}`,
    });
  }

  async sendPasswordChanged(to: string): Promise<void> {
    await this.sendTemplate(to, {
      subject: 'Your Matchena password was changed',
      preheader: 'Security notice for your Matchena account.',
      heading: 'Password changed · تم تغيير كلمة المرور',
      intro:
        'Your Matchena password was changed successfully. تم تغيير كلمة مرور حسابك في ماتشنا بنجاح.',
      bodyHtml:
        '<p style="margin:0;color:#cbd5e1;line-height:1.8">All existing sessions were signed out. If this was not you, contact support immediately.</p>',
      bodyText:
        'Your Matchena password was changed and all existing sessions were signed out. If this was not you, contact support immediately.',
    });
  }

  private codeBlock(code: string, expiresInMinutes: number): string {
    return `<div style="margin:24px 0;padding:20px;border:1px solid #365314;border-radius:16px;background:#0b1a10;text-align:center"><div style="font-size:34px;line-height:1;font-weight:900;letter-spacing:9px;color:#a3ff12">${this.escapeHtml(code)}</div><div style="margin-top:12px;color:#94a3b8;font-size:13px">Expires in ${expiresInMinutes} minutes · صالح لمدة ${expiresInMinutes} دقائق</div></div>`;
  }

  async sendFinanceNotice(to: string, subject: string, body: string): Promise<void> {
    await this.sendTemplate(to, {
      subject,
      preheader: subject,
      heading: `${subject} · إشعار مالي`,
      intro: body,
      bodyHtml: '',
      bodyText: body,
    });
  }

  async sendSupportInquiry(inquiry: {
    fullName: string;
    email: string;
    phone?: string;
    message: string;
  }): Promise<void> {
    const to =
      this.config.get<string>('MAIL_REPLY_TO')?.trim() || 'support@matchena.com';
    const safeName = this.escapeHtml(inquiry.fullName);
    const safeEmail = this.escapeHtml(inquiry.email);
    const safePhone = inquiry.phone ? this.escapeHtml(inquiry.phone) : '';
    const safeMessage = this.escapeHtml(inquiry.message).replace(/\n/g, '<br>');
    const phoneHtml = safePhone
      ? `<p style="margin:0 0 8px;color:#cbd5e1;line-height:1.8"><strong style="color:#f8fafc">Phone</strong> · ${safePhone}</p>`
      : '';
    const text = [
      'New Matchena contact form message',
      `Name: ${inquiry.fullName}`,
      `Email: ${inquiry.email}`,
      inquiry.phone ? `Phone: ${inquiry.phone}` : null,
      '',
      inquiry.message,
    ]
      .filter((line): line is string => line != null)
      .join('\n');
    await this.sendTemplate(
      to,
      {
        subject: `Contact · ${inquiry.fullName}`,
        preheader: inquiry.message.replace(/\s+/g, ' ').slice(0, 90),
        heading: 'New contact message · رسالة تواصل جديدة',
        intro: `${safeName} wrote from the Matchena contact page.`,
        bodyHtml: `${phoneHtml}<p style="margin:0 0 8px;color:#cbd5e1;line-height:1.8"><strong style="color:#f8fafc">Email</strong> · <a href="mailto:${safeEmail}" style="color:#a3ff12">${safeEmail}</a></p><div style="margin:18px 0 0;padding:16px 18px;border:1px solid #365314;border-radius:16px;background:#0b1a10;color:#e2e8f0;line-height:1.8">${safeMessage}</div>`,
        bodyText: text,
        footer: 'Reply to this email to answer the sender directly.',
      },
      { replyTo: inquiry.email },
    );
  }

  private async sendTemplate(
    to: string,
    content: EmailContent,
    extras?: { replyTo?: string },
  ): Promise<void> {
    const from = this.config.get<string>(
      'MAIL_FROM',
      'Matchena <no-reply@matchena.com>',
    );
    const replyTo =
      extras?.replyTo ||
      this.config.get<string>('MAIL_REPLY_TO') ||
      'support@matchena.com';
    const info = await this.transport.sendMail({
      to,
      subject: content.subject,
      html: this.render(content),
      text: content.bodyText,
      from,
      replyTo,
    });
    if (info.message) {
      this.logger.debug(`[dev email:no-smtp] to=${to} subject="${content.subject}"`);
    }
  }

  /** Local `.env` leaves SMTP empty, so mail never leaves this machine. Print
   *  the code the same way console SMS OTP does, otherwise register/reset
   *  cannot be tested without production credentials. */
  private logDevCode(to: string, kind: string, code: string): void {
    if (this.config.get<string>('SMTP_HOST')) return;
    this.logger.log(`[dev email:no-smtp] ${kind} for ${to}: ${code}`);
  }

  private render(content: EmailContent): string {
    // Absolute URL: email clients never resolve relative paths, and most
    // strip <svg> outright — a hosted raster PNG of the approved wordmark
    // is the only version that reliably renders across Gmail/Outlook/Apple
    // Mail. Falls back to the plain-text wordmark via `alt` when images are
    // blocked (the default in most clients until the recipient allows them).
    const siteUrl = this.config
      .get<string>('SITE_URL', 'https://matchena.com')
      .replace(/\/$/, '');
    const logoUrl = `${siteUrl}/assets/brand/matchena/matchena-email-logo-white.png`;
    return `<!doctype html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${this.escapeHtml(content.subject)}</title></head><body style="margin:0;background:#050b07;font-family:Arial,'Helvetica Neue',sans-serif;color:#f8fafc"><div style="display:none;max-height:0;overflow:hidden;opacity:0">${this.escapeHtml(content.preheader)}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#050b07;padding:32px 12px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#0a120d;border:1px solid #1f3a28;border-radius:22px;overflow:hidden"><tr><td style="padding:22px 30px;border-bottom:1px solid #1f3a28"><img src="${logoUrl}" width="132" height="18" alt="Matchena · ماتشنا" style="display:block;height:18px;width:auto;border:0;outline:none;text-decoration:none"></td></tr><tr><td style="padding:34px 30px"><h1 style="margin:0 0 16px;font-size:25px;line-height:1.35;color:#f8fafc">${content.heading}</h1><p style="margin:0;color:#cbd5e1;line-height:1.8">${content.intro}</p>${content.bodyHtml}${content.footer ? `<p style="margin:26px 0 0;color:#94a3b8;font-size:13px;line-height:1.7">${content.footer}</p>` : ''}</td></tr><tr><td style="padding:18px 30px;background:#07100a;color:#64748b;font-size:12px;line-height:1.6">Matchena · Your game starts here<br>هذه رسالة آلية لحماية حسابك.</td></tr></table></td></tr></table></body></html>`;
  }

  private escapeHtml(value: string): string {
    return value.replace(/[&<>'"]/g, (char) => {
      const entities: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;',
      };
      return entities[char];
    });
  }
}
