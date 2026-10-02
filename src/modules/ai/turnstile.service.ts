import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiQuotaService } from './ai-quota.service';
import { AiSettingsService } from './ai-settings.service';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const VERIFY_TIMEOUT_MS = 4_000;
const VERIFIED_FOR_MS = 30 * 60_000;
const BURST_WINDOW_MS = 10_000;
const BURST_LIMIT = 4;
const CHURN_WINDOW_MS = 10 * 60_000;
const CHURN_DEVICES = 4;
const MAP_MAX = 5_000;

export type ChallengeResult = 'ok' | 'failed' | 'error';
export type SuspicionReason = 'volume' | 'burst' | 'device_churn' | 'no_device';

/**
 * Cloudflare Turnstile for visitors who look automated. Dormant until
 * `TURNSTILE_SECRET_KEY` is set: with no key every method says "nothing to do",
 * so nothing changes for anyone. Signed-in players are never challenged, and
 * if Cloudflare cannot be reached the caller lets the visitor through under a
 * tighter allowance instead of blocking them.
 */
@Injectable()
export class TurnstileService {
  private readonly logger = new Logger(TurnstileService.name);
  private readonly secret: string;
  private readonly verified = new Map<string, number>();
  private readonly hits = new Map<string, number[]>();
  private readonly devicesByIp = new Map<string, Map<string, number>>();

  constructor(
    config: ConfigService,
    @Optional() private readonly quota?: AiQuotaService,
    @Optional() private readonly settings?: AiSettingsService,
  ) {
    this.secret = (config.get<string>('TURNSTILE_SECRET_KEY') ?? '').trim();
  }

  get enabled(): boolean {
    return this.secret.length > 0;
  }

  /** The key the "this visitor passed" memory is stored under: the device when the browser sent one, else the address. */
  private passKey(ip: string | undefined, deviceId: string | undefined): string {
    return deviceId ? `dev:${deviceId}` : `ip:${ip || 'unknown'}`;
  }

  isVerified(ip: string | undefined, deviceId: string | undefined, now = Date.now()): boolean {
    const until = this.verified.get(this.passKey(ip, deviceId));
    return !!until && until > now;
  }

  markVerified(ip: string | undefined, deviceId: string | undefined, now = Date.now()): void {
    if (this.verified.size >= MAP_MAX) this.verified.clear();
    this.verified.set(this.passKey(ip, deviceId), now + VERIFIED_FOR_MS);
  }

  /**
   * Does this visitor look like a script? Records the message for the burst
   * and device-churn checks, so call it once per visitor message.
   */
  async suspicion(ip: string | undefined, deviceId: string | undefined, now = Date.now()): Promise<SuspicionReason | null> {
    if (!deviceId) return 'no_device';
    const who = this.passKey(ip, deviceId);

    const recent = (this.hits.get(who) ?? []).filter((t) => now - t < BURST_WINDOW_MS);
    recent.push(now);
    if (this.hits.size >= MAP_MAX) this.hits.clear();
    this.hits.set(who, recent);
    if (recent.length > BURST_LIMIT) return 'burst';

    if (ip) {
      const devices = this.devicesByIp.get(ip) ?? new Map<string, number>();
      for (const [d, t] of devices) if (now - t > CHURN_WINDOW_MS) devices.delete(d);
      devices.set(deviceId, now);
      if (this.devicesByIp.size >= MAP_MAX) this.devicesByIp.clear();
      this.devicesByIp.set(ip, devices);
      if (devices.size >= CHURN_DEVICES) return 'device_churn';
    }

    const threshold = this.settings?.number('turnstileAfterMessages') ?? 5;
    const sent = (await this.quota?.sentToday('captain', who, now)) ?? 0;
    return sent >= threshold ? 'volume' : null;
  }

  /** Asks Cloudflare whether the token a visitor's browser produced is genuine. */
  async verify(token: string, ip?: string): Promise<ChallengeResult> {
    if (!this.enabled) return 'ok';
    if (!token || token.length > 2048) return 'failed';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
    try {
      const body = new URLSearchParams({ secret: this.secret, response: token });
      if (ip) body.set('remoteip', ip);
      const res = await fetch(SITEVERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        this.logger.warn(`[turnstile] siteverify answered HTTP ${res.status}`);
        return 'error';
      }
      const json = (await res.json()) as { success?: boolean; 'error-codes'?: string[] };
      if (json.success === true) return 'ok';
      const codes = json['error-codes'] ?? [];
      // A wrong secret is our configuration problem, not the visitor's: do not punish them for it.
      if (codes.includes('invalid-input-secret') || codes.includes('missing-input-secret')) {
        this.logger.error('[turnstile] TURNSTILE_SECRET_KEY was rejected by Cloudflare — check the key in Coolify');
        return 'error';
      }
      return 'failed';
    } catch (err) {
      this.logger.warn(`[turnstile] could not reach Cloudflare: ${String((err as Error)?.name ?? err)}`);
      return 'error';
    } finally {
      clearTimeout(timer);
    }
  }
}
