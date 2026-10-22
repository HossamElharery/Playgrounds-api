import type { ConfigService } from '@nestjs/config';

/** Every flag defaults to OFF: nothing of the game is reachable until the owner turns it on (test first). */
function on(config: Pick<ConfigService, 'get'>, key: string): boolean {
  return (config.get<string>(key) ?? '').trim() === 'true';
}

export const camoEnabled = (c: Pick<ConfigService, 'get'>): boolean => on(c, 'CAMO_ENABLED');
export const camoPublicMatchEnabled = (c: Pick<ConfigService, 'get'>): boolean => camoEnabled(c) && on(c, 'CAMO_PUBLIC_MATCH_ENABLED');
export const camoVoiceEnabled = (c: Pick<ConfigService, 'get'>): boolean => camoEnabled(c) && on(c, 'CAMO_VOICE_ENABLED');
export const camoDailyEnabled = (c: Pick<ConfigService, 'get'>): boolean => camoEnabled(c) && on(c, 'CAMO_DAILY_ENABLED');
/** Drain: no new matches, running ones finish (≤ 5 min), clients see "we'll be back" (section 20b). */
export const camoDraining = (c: Pick<ConfigService, 'get'>): boolean => on(c, 'CAMO_DRAIN');
