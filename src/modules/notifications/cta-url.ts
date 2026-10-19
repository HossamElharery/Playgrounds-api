import { BadRequestException } from '@nestjs/common';
import { ValidateBy, buildMessage } from 'class-validator';

export function isSafeNotificationCtaUrl(raw: string): boolean {
  const value = raw.trim();
  if (!value) return false;
  if (value.startsWith('/') && !value.startsWith('//')) {
    return !value.includes('://') && !/[\s<>]/.test(value);
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function sanitizeNotificationCtaUrl(raw?: string): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!isSafeNotificationCtaUrl(value)) {
    throw new BadRequestException(
      'Button URL must be an in-app path starting with / or an http(s) link',
    );
  }
  if (value.startsWith('/') && !value.startsWith('//')) {
    return value.slice(0, 500);
  }
  return new URL(value).toString().slice(0, 500);
}

export function IsNotificationCtaUrl() {
  return ValidateBy({
    name: 'isNotificationCtaUrl',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' && isSafeNotificationCtaUrl(value),
      defaultMessage: buildMessage(
        () =>
          'Button URL must be an in-app path starting with / or an http(s) link',
      ),
    },
  });
}

/**
 * Web Push opens its link as a plain URL, outside the app router, so it needs the
 * language prefix the app routes under (`/ar/owner/...`). FCM and the in-app inbox
 * add the prefix themselves and keep the raw link.
 */
export function localizedPushUrl(deepLink: string | null | undefined, lang: 'ar' | 'en'): string | undefined {
  if (!deepLink) return undefined;
  if (!deepLink.startsWith('/') || deepLink.startsWith('//')) return deepLink;
  if (/^\/(?:ar|en)(?:[/?#]|$)/.test(deepLink)) return deepLink;
  return `/${lang}${deepLink}`;
}
