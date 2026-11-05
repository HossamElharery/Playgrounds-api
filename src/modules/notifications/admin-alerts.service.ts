import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { NotificationsService } from './notifications.service';

export type AdminAlert = {
  /** Stable key per event; each admin gets `${dedupKey}:${adminId}` so a retry never double-notifies. */
  dedupKey?: string;
  titleEn: string;
  titleAr: string;
  bodyEn: string;
  bodyAr: string;
  deepLink: string;
  payload?: Record<string, unknown>;
  /** Send an email as well as the in-app notification (default true). */
  email?: boolean;
};

/**
 * One place that tells every active administrator about something that needs them: an in-app
 * notification (live over the socket + push) and an email. Best effort — it never throws, so
 * the action that triggered it can't fail because a mail server hiccuped.
 */
@Injectable()
export class AdminAlertsService {
  private readonly logger = new Logger(AdminAlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    @Optional() private readonly email?: EmailService,
  ) {}

  async alert(input: AdminAlert): Promise<void> {
    try {
      const admins = await this.prisma.user.findMany({
        where: { roles: { has: 'admin' }, status: 'active' },
        select: { id: true, email: true },
      });
      await Promise.all(
        admins.map(async (admin) => {
          await this.notifications
            .create({
              dedupKey: input.dedupKey ? `${input.dedupKey}:${admin.id}` : undefined,
              userId: admin.id,
              category: 'system',
              titleEn: input.titleEn,
              titleAr: input.titleAr,
              bodyEn: input.bodyEn,
              bodyAr: input.bodyAr,
              deepLink: input.deepLink,
              payload: input.payload,
            })
            .catch((err) => this.logger.warn(`admin notification failed: ${String(err)}`));
          if (input.email !== false && admin.email && this.email) {
            await this.email
              .sendFinanceNotice(
                admin.email,
                input.titleEn,
                `${input.bodyEn}\n${input.titleAr} — ${input.bodyAr}`,
              )
              .catch((err) => this.logger.warn(`admin email failed: ${String(err)}`));
          }
        }),
      );
    } catch (err) {
      this.logger.warn(`admin alert failed: ${String(err)}`);
    }
  }
}
