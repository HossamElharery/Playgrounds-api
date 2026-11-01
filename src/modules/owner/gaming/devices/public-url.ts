import { ConfigService } from '@nestjs/config';

/**
 * wss://<api host><path> (ws:// for a local http API). Devices and hubs dial the API host directly:
 * the web origin's /api proxy is not guaranteed to pass WebSocket upgrades.
 */
export function publicSocketUrl(config: ConfigService, path: string) {
  const configured =
    config.get<string>('DEVICE_PUBLIC_URL')?.trim() ||
    config.get<string>('API_PUBLIC_URL')?.trim();
  const fallback =
    config.get<string>('NODE_ENV') === 'production'
      ? 'https://api.matchena.com'
      : `http://localhost:${config.get<number>('PORT', 3000)}`;
  let url: URL;
  try {
    url = new URL((configured || fallback).replace(/\/+$/, ''));
  } catch {
    url = new URL(fallback);
  }
  const scheme = url.protocol === 'http:' ? 'ws' : 'wss';
  return {
    url: `${scheme}://${url.host}${path}`,
    host: url.host,
    secure: scheme === 'wss',
  };
}
