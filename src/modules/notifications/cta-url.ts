import { BadRequestException } from '@nestjs/common';

export function sanitizeNotificationCtaUrl(raw?: string): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (value.startsWith('/') && !value.startsWith('//')) {
    if (value.includes('://') || /[\s<>]/.test(value)) {
      throw new BadRequestException('Invalid button URL');
    }
    return value.slice(0, 500);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BadRequestException('Invalid button URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BadRequestException('Invalid button URL');
  }
  return parsed.toString().slice(0, 500);
}
