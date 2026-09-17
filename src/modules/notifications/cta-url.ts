import { BadRequestException } from '@nestjs/common';
import { ValidateBy, buildMessage } from 'class-validator';

/** In-app path (`/en/...`) or http(s) URL. Rejects `javascript:`, spaces, and bare text. */
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
