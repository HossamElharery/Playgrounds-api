import { createHash } from 'crypto';
import type { ConfigService } from '@nestjs/config';

const ARABIC_INDIC = /[٠-٩]/g;
const EXT_ARABIC_INDIC = /[۰-۹]/g;

function asciiDigits(text: string): string {
  return text
    .replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(EXT_ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/**
 * What may be kept of a player's sentence. Emails, links and anything that
 * looks like a phone or card number (six or more digits, even when spaced or
 * dashed) are replaced before the text goes anywhere near a table.
 */
export function redactText(input: string, max = 300): string {
  if (typeof input !== 'string') return '';
  return asciiDigits(input)
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
    .replace(/(?:https?:\/\/|www\.)\S+/gi, '[link]')
    .replace(/\+?\d[\d\s\-().]{4,}\d/g, (m) => (m.replace(/\D/g, '').length >= 6 ? '[number]' : m))
    .replace(/\d{6,}/g, '[number]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** The salt behind every stored identity hash. Falls back to the access-token secret, so no new variable is required. */
export function identitySalt(config: Pick<ConfigService, 'get'> | undefined): string {
  return (
    config?.get<string>('AI_HASH_SALT') ||
    config?.get<string>('JWT_ACCESS_SECRET') ||
    config?.get<string>('JWT_SECRET') ||
    'matchena-ai'
  );
}

/** A short, salted, one-way reference: enough to group one visitor's messages, useless for finding the visitor. */
export function identityRef(salt: string, value: string, length = 12): string {
  return createHash('sha256').update(`${salt}|${value}`).digest('hex').slice(0, length);
}

/** `ip:1.2.3.4` and `dev:abc` never reach a table as written; a user id already is a pseudonym. */
export function storedQuotaKey(salt: string, key: string): string {
  const [kind, ...rest] = key.split(':');
  const value = rest.join(':');
  return kind === 'ip' || kind === 'dev' ? `${kind}:${identityRef(salt, value)}` : key.slice(0, 80);
}
