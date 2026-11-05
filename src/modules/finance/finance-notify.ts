import type { NotificationsService } from '../notifications/notifications.service';
import { moneyText } from '../../common/money/money-text';

export const MATCHENA_ACCOUNT_LINK = '/owner/earnings?section=matchena-account';

/** `amount` is in the ledger's minor unit (1/100 of the major unit), exactly as stored and as the admin DTOs carry it. */
export function formatMoney(amount: number, currency: string, locale: 'en' | 'ar' = 'en'): string {
  return moneyText(amount, currency, locale);
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
