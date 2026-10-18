import { createHash } from 'crypto';
import type { ConfigService } from '@nestjs/config';

const ARABIC_INDIC = /[٠-٩]/g;
const EXT_ARABIC_INDIC = /[۰-۹]/g;

function asciiDigits(text: string): string {
  return text
    .replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(EXT_ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x06f0));
}

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

export function identitySalt(config: Pick<ConfigService, 'get'> | undefined): string {
  return (
    config?.get<string>('AI_HASH_SALT') ||
    config?.get<string>('JWT_ACCESS_SECRET') ||
    config?.get<string>('JWT_SECRET') ||
    'matchena-ai'
  );
}

export function identityRef(salt: string, value: string, length = 12): string {
  return createHash('sha256').update(`${salt}|${value}`).digest('hex').slice(0, length);
}

export function storedQuotaKey(salt: string, key: string): string {
  const [kind, ...rest] = key.split(':');
  const value = rest.join(':');
  return kind === 'ip' || kind === 'dev' ? `${kind}:${identityRef(salt, value)}` : key.slice(0, 80);
}
