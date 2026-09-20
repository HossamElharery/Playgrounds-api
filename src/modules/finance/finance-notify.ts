import type { NotificationsService } from '../notifications/notifications.service';

export const MATCHENA_ACCOUNT_LINK = '/owner/earnings?section=matchena-account';

export function formatMoney(amount: number, currency: string, locale: 'en' | 'ar' = 'en'): string {
  const formatted = new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-EG').format(amount);
  return locale === 'ar' ? `${formatted} ${currency}` : `${formatted} ${currency}`;
}

export async function notifyFinance(
  notifications: NotificationsService,
  input: {
    userId: string;
    titleEn: string;
    titleAr: string;
    bodyEn: string;
    bodyAr: string;
    payload?: Record<string, unknown>;
  },
) {
  return notifications.create({
    userId: input.userId,
    category: 'system',
    titleEn: input.titleEn,
    titleAr: input.titleAr,
    bodyEn: input.bodyEn,
    bodyAr: input.bodyAr,
    deepLink: MATCHENA_ACCOUNT_LINK,
    payload: input.payload,
  });
}
