import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GatewayTimeoutException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { GamingHub, Prisma } from '@prisma/client';
import { randomBytes, randomInt } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AuthenticatedUser } from '../../../../common/types/authenticated-user.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import { GamingCommandService, jsonValue } from '../gaming-command.service';
import { GamingCommandDto } from '../gaming-operations.dto';
import {
  ConsoleHubService,
  HubRpcError,
  hashHubSecret,
} from './console-hub.service';
import {
  HUB_ERROR_CODES,
  HUB_SOCKET_PATH,
  isOlderVersion,
} from './hub-protocol';
import {
  ClaimHubDto,
  PairConsoleDto,
  PsnLinkDto,
  RenameHubDto,
} from './gaming-devices.dto';
import { publicSocketUrl } from './public-url';

export const CLAIM_TTL_MS = 15 * 60_000;
const MAX_ACTIVE_CODES = 5;
/** Unambiguous characters only (no 0/O, 1/I/L): the code is read off a screen and typed. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

export const newClaimCode = () => {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++)
    out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
};
export const formatClaimCode = (code: string) =>
  `${code.slice(0, 4)}-${code.slice(4)}`;
/** Accepts "abcd-efgh", " ABCD EFGH ", O→0 style typos are not guessed: the alphabet has none. */
export const normalizeClaimCode = (raw: string) =>
  raw.toUpperCase().replace(/[^A-Z0-9]/g, '');

export interface HubView {
  id: string;
  name: string | null;
  online: boolean;
  lastSeenAt: Date | null;
  hostname: string | null;
  platform: string | null;
  hubVersion: string | null;
  psnLinked: boolean;
  /** newest released Hub version, and whether this hub is behind it */
  latestVersion: string | null;
  updateAvailable: boolean;
}

export interface HubRelease {
  version: string;
  platforms: Record<string, { url: string; sha256: string; size: number }>;
}

export const hubView = (
  h: GamingHub,
  online: boolean,
  latest: string | null = null,
): HubView => ({
  id: h.id,
  name: h.name,
  online,
  lastSeenAt: h.lastSeenAt,
  hostname: h.hostname,
  platform: h.platform,
  hubVersion: h.hubVersion,
  psnLinked: h.psnLinked,
  latestVersion: latest,
  updateAvailable: isOlderVersion(h.hubVersion, latest),
});

/**
 * Owner-facing side of the Matchena Hub: one-time connect codes, the claim that turns a code into a
 * hub token, and the operations that need the hub to act (PlayStation sign-in, pairing, checks).
 * The console state itself is applied by GamingDevicesService, which owns the reconcile loop.
 */
@Injectable()
export class GamingHubsService {
  private readonly logger = new Logger(GamingHubsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hubs: ConsoleHubService,
    private readonly commands: GamingCommandService,
    private readonly config: ConfigService,
  ) {}

  /** File name -> download type. Only these names are ever served. */
  static readonly DOWNLOAD_FILES: Record<string, string> = {
    'MatchenaHub-win-x64.exe': 'application/vnd.microsoft.portable-executable',
    'MatchenaHub-macos.zip': 'application/zip',
    'MatchenaHub-linux-x64.tar.gz': 'application/gzip',
    // raw binaries: fetched by the install script (curl does not mark them as "downloaded from the internet")
    'MatchenaHub-macos-arm64': 'application/octet-stream',
    'MatchenaHub-macos-x64': 'application/octet-stream',
    'MatchenaHub-linux-x64': 'application/octet-stream',
  };

  /**
   * Where the owner page sends people to get the Hub. By default the API serves the files itself from
   * HUB_RELEASE_DIR (uploads/hub); set HUB_DOWNLOAD_BASE to host them elsewhere (CDN, releases page).
   */
  downloads() {
    const base = this.downloadBase();
    const api = this.apiBase();
    return {
      installCommand: `curl -fsSL ${api}/api/v1/gaming/hub/install.sh | sh`,
      win: `${base}/MatchenaHub-win-x64.exe`,
      mac: `${base}/MatchenaHub-macos.zip`,
      linux: `${base}/MatchenaHub-linux-x64.tar.gz`,
    };
  }

  private apiBase() {
    const socket = publicSocketUrl(this.config, '');
    return `${socket.secure ? 'https' : 'http'}://${socket.host}`;
  }

  private downloadBase() {
    const external = this.config.get<string>('HUB_DOWNLOAD_BASE')?.trim();
    return external
      ? external.replace(/\/+$/, '')
      : `${this.apiBase()}/api/v1/gaming/hub/download`;
  }

  /** Only for a test server: the installed Hub must talk to the server that served this script. */
  private devEnvLines() {
    const host = new URL(this.apiBase()).hostname;
    return host === 'matchena.com' || host.endsWith('.matchena.com')
      ? ''
      : `MATCHENA_API_URL="${this.apiBase()}" `;
  }

  /** One-line installer for macOS / Linux: picks the right build, installs it and starts it. */
  installScript() {
    const base = this.downloadBase();
    return `#!/bin/sh
# Matchena Hub installer (macOS / Linux). Downloads the Hub, starts it, and opens Matchena to finish.
set -e
BASE="${base}"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) FILE=MatchenaHub-macos-arm64 ;;
  Darwin-x86_64) FILE=MatchenaHub-macos-x64 ;;
  Linux-x86_64) FILE=MatchenaHub-linux-x64 ;;
  *) echo "This computer type is not supported: $(uname -s) $(uname -m)"; exit 1 ;;
esac
DIR="$HOME/.matchena-hub-download"
mkdir -p "$DIR"
echo "Downloading Matchena Hub..."
curl -fL --progress-bar "$BASE/$FILE" -o "$DIR/$FILE.part"
chmod +x "$DIR/$FILE.part"
mv "$DIR/$FILE.part" "$DIR/$FILE"
if [ "$(uname -s)" = "Darwin" ]; then xattr -dr com.apple.quarantine "$DIR" 2>/dev/null || true; fi
echo "Starting Matchena Hub..."
${this.devEnvLines()}"$DIR/$FILE"
echo "Done. Matchena opens in your browser; keep this computer on and connected to the same network as the consoles."
`;
  }

  private static readonly PLATFORM_FILES: Record<string, string> = {
    'win32-x64': 'MatchenaHub-win-x64.exe',
    'darwin-arm64': 'MatchenaHub-macos-arm64',
    'darwin-x64': 'MatchenaHub-macos-x64',
    'linux-x64': 'MatchenaHub-linux-x64',
  };

  /**
   * The newest released Hub, from latest.json next to the installers (written by `npm run release:pack`
   * in matchena-hub). Hubs and the owner page both read this to know an update exists.
   */
  latest(): HubRelease | null {
    try {
      const dir = path.resolve(
        this.config.get<string>('HUB_RELEASE_DIR')?.trim() ||
          path.join(process.cwd(), 'uploads', 'hub'),
      );
      const raw = JSON.parse(
        fs.readFileSync(path.join(dir, 'latest.json'), 'utf8'),
      ) as {
        version?: unknown;
        files?: Record<string, { sha256?: unknown; size?: unknown }>;
      };
      if (
        typeof raw.version !== 'string' ||
        !/^\d+(\.\d+){0,3}$/.test(raw.version)
      )
        return null;
      const base = this.downloadBase();
      const platforms: HubRelease['platforms'] = {};
      for (const [key, file] of Object.entries(
        GamingHubsService.PLATFORM_FILES,
      )) {
        const f = raw.files?.[key];
        if (
          f &&
          typeof f.sha256 === 'string' &&
          /^[a-f0-9]{64}$/.test(f.sha256) &&
          typeof f.size === 'number'
        )
          platforms[key] = {
            url: `${base}/${file}`,
            sha256: f.sha256,
            size: f.size,
          };
      }
      return Object.keys(platforms).length
        ? { version: raw.version, platforms }
        : null;
    } catch {
      return null;
    }
  }

  /** Ask a hub to update itself now (it downloads, verifies and restarts). */
  async update(user: AuthenticatedUser, hubId: string, dto: GamingCommandDto) {
    await this.access(user, dto.venueId);
    const hub = await this.ownedHub(this.prisma, dto.venueId, hubId);
    const latest = this.latest();
    if (!latest || !isOlderVersion(hub.hubVersion, latest.version))
      throw new BadRequestException({ code: 'UPDATE_NOT_AVAILABLE' });
    await this.callHub(hubId, 'update', {}, 150_000);
    return { ok: true };
  }

  /** Absolute path of a releasable file, or null when the name is not allowed or the file is not there. */
  downloadPath(file: string): string | null {
    if (
      !Object.prototype.hasOwnProperty.call(
        GamingHubsService.DOWNLOAD_FILES,
        file,
      )
    )
      return null;
    const dir = path.resolve(
      this.config.get<string>('HUB_RELEASE_DIR')?.trim() ||
        path.join(process.cwd(), 'uploads', 'hub'),
    );
    const full = path.join(dir, file);
    return fs.existsSync(full) ? full : null;
  }

  async list(venueId: string): Promise<HubView[]> {
    const rows = await this.prisma.gamingHub.findMany({
      where: { venueId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const latest = this.latest()?.version ?? null;
    return rows.map((h) => hubView(h, this.hubs.isOnline(h.id), latest));
  }

  // ---- connect code + claim ----

  createCode(user: AuthenticatedUser, dto: GamingCommandDto) {
    return this.commands.command(
      user,
      'devices.manage',
      'devices.hub-code',
      dto,
      async (tx, now) => {
        await tx.gamingHubClaim.deleteMany({
          where: {
            venueId: dto.venueId,
            OR: [
              { expiresAt: { lt: now } },
              {
                usedAt: { not: null },
                createdAt: { lt: new Date(now.getTime() - 86_400_000) },
              },
            ],
          },
        });
        const active = await tx.gamingHubClaim.count({
          where: { venueId: dto.venueId, usedAt: null, expiresAt: { gt: now } },
        });
        if (active >= MAX_ACTIVE_CODES)
          throw new BadRequestException({ code: 'TOO_MANY_CODES' });
        const code = newClaimCode();
        const expiresAt = new Date(now.getTime() + CLAIM_TTL_MS);
        await tx.gamingHubClaim.create({
          data: {
            venueId: dto.venueId,
            codeHash: hashHubSecret(code),
            createdBy: user.id,
            expiresAt,
          },
        });
        return {
          code: formatClaimCode(code),
          expiresAt,
          apiUrl: this.apiBase(),
        };
      },
    );
  }

  /** Public: a Hub exchanges the code for its own token. Every failure looks the same. */
  async claim(dto: ClaimHubDto) {
    const code = normalizeClaimCode(dto.code);
    const invalid = () => new BadRequestException({ code: 'CLAIM_INVALID' });
    if (code.length !== CODE_LENGTH) throw invalid();
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const claim = await this.prisma.gamingHubClaim.findUnique({
      where: { codeHash: hashHubSecret(code) },
    });
    if (!claim || claim.usedAt || claim.expiresAt <= now) throw invalid();
    const burned = await this.prisma.gamingHubClaim.updateMany({
      where: { id: claim.id, usedAt: null },
      data: { usedAt: now },
    });
    if (burned.count !== 1) throw invalid();
    const venue = await this.prisma.venue.findUnique({
      where: { id: claim.venueId },
      select: { nameAr: true, nameEn: true },
    });
    const hub = await this.prisma.gamingHub.create({
      data: {
        venueId: claim.venueId,
        tokenHash: hashHubSecret(token),
        hostname: dto.hostname?.trim().slice(0, 80) || null,
        platform: dto.platform?.trim().slice(0, 24) || null,
        hubVersion: dto.hubVersion?.trim().slice(0, 24) || null,
        name: dto.hostname?.trim().slice(0, 60) || null,
      },
    });
    await this.commands
      .event(
        this.prisma as unknown as Prisma.TransactionClient,
        claim.venueId,
        hub.id,
        null,
        'device.changed',
      )
      .catch(() => undefined);
    return {
      token,
      wsUrl: publicSocketUrl(this.config, HUB_SOCKET_PATH).url,
      venueName: venue?.nameEn || venue?.nameAr || '',
    };
  }

  @Cron('0 31 4 * * *')
  async pruneClaims() {
    await this.prisma.gamingHubClaim
      .deleteMany({
        where: { expiresAt: { lt: new Date(Date.now() - 86_400_000) } },
      })
      .catch((e) =>
        this.logger.warn(`claim prune failed: ${(e as Error).message}`),
      );
  }

  // ---- hub management ----

  rename(user: AuthenticatedUser, hubId: string, dto: RenameHubDto) {
    return this.commands.command(
      user,
      'devices.manage',
      `devices.hub-rename:${hubId}`,
      dto,
      async (tx) => {
        const hub = await this.ownedHub(tx, dto.venueId, hubId);
        const updated = await tx.gamingHub.update({
          where: { id: hub.id },
          data: { name: dto.name.trim() || null },
        });
        await this.commands.event(
          tx,
          dto.venueId,
          hub.id,
          null,
          'device.changed',
        );
        return hubView(
          updated,
          this.hubs.isOnline(updated.id),
          this.latest()?.version ?? null,
        );
      },
    );
  }

  remove(user: AuthenticatedUser, hubId: string, dto: GamingCommandDto) {
    return this.commands.command(
      user,
      'devices.manage',
      `devices.hub-remove:${hubId}`,
      dto,
      async (tx) => {
        const hub = await this.ownedHub(tx, dto.venueId, hubId);
        // Consoles that are set up (linked or on a station) stay, so a replacement PC's Hub adopts them with
        // their station and settings; leftovers that were never linked are just discovery noise.
        await tx.gamingDevice.deleteMany({
          where: { hubId: hub.id, paired: false, unitId: null },
        });
        await tx.gamingHub.delete({ where: { id: hub.id } });
        await this.commands.event(
          tx,
          dto.venueId,
          hub.id,
          null,
          'device.changed',
        );
        setTimeout(() => this.hubs.disconnect(hub.id, 'removed'), 0);
        return { id: hub.id };
      },
    );
  }

  // ---- operations that need the hub ----

  async scan(user: AuthenticatedUser, hubId: string, dto: GamingCommandDto) {
    await this.access(user, dto.venueId);
    await this.ownedHub(this.prisma, dto.venueId, hubId);
    const data = await this.callHub(hubId, 'scan', {}, 15_000);
    return { ok: true, count: typeof data.count === 'number' ? data.count : 0 };
  }

  async psnUrl(user: AuthenticatedUser, hubId: string, venueId: string) {
    await this.access(user, venueId);
    await this.ownedHub(this.prisma, venueId, hubId);
    const data = await this.callHub(hubId, 'psn.url', {}, 10_000);
    if (typeof data.url !== 'string' || !data.url.startsWith('https://'))
      throw new BadRequestException({ code: 'HUB_ERROR' });
    return { url: data.url };
  }

  async psnLink(user: AuthenticatedUser, hubId: string, dto: PsnLinkDto) {
    await this.access(user, dto.venueId);
    await this.ownedHub(this.prisma, dto.venueId, hubId);
    // The redirect address carries a one-time sign-in code: it goes to the hub and nowhere else.
    await this.callHub(
      hubId,
      'psn.link',
      { redirectUrl: dto.redirectUrl },
      30_000,
    );
    await this.prisma.gamingHub.update({
      where: { id: hubId },
      data: { psnLinked: true },
    });
    await this.event(dto.venueId, hubId);
    return { linked: true };
  }

  async pair(user: AuthenticatedUser, deviceId: string, dto: PairConsoleDto) {
    await this.access(user, dto.venueId);
    const device = await this.ownedConsole(dto.venueId, deviceId);
    await this.callHub(
      device.hubId!,
      'pair',
      { consoleId: device.externalId, pin: dto.pin },
      60_000,
    );
    await this.prisma.gamingDevice.update({
      where: { id: device.id },
      data: { paired: true, appliedKey: null, configuredAt: null },
    });
    await this.prisma.gamingDeviceLog
      .create({
        data: {
          deviceId: device.id,
          venueId: device.venueId,
          kind: 'paired',
          actorId: user.id,
        },
      })
      .catch(() => undefined);
    await this.event(dto.venueId, device.id);
    return { ok: true };
  }

  /**
   * Setup self-test: reach the console, put it in rest mode, wake it again. Each step reports on its
   * own so the owner is told exactly what to fix (usually a rest-mode setting on the console).
   */
  async check(
    user: AuthenticatedUser,
    deviceId: string,
    dto: GamingCommandDto,
  ) {
    await this.access(user, dto.venueId);
    const device = await this.ownedConsole(dto.venueId, deviceId);
    const data = await this.callHub(
      device.hubId!,
      'check',
      { consoleId: device.externalId },
      150_000,
    );
    const steps = Array.isArray(data.steps)
      ? (data.steps as unknown[])
          .map((s) => {
            const v = (s ?? {}) as Record<string, unknown>;
            return {
              key: typeof v.key === 'string' ? v.key.slice(0, 20) : '',
              ok: v.ok === true,
              ...(typeof v.ms === 'number' ? { ms: Math.round(v.ms) } : {}),
              ...(typeof v.code === 'string'
                ? { code: v.code.slice(0, 40) }
                : {}),
            };
          })
          .slice(0, 6)
      : [];
    const ok = steps.length > 0 && steps.every((s) => s.ok);
    await this.prisma.gamingDevice.update({
      where: { id: device.id },
      data: { appliedKey: null, ...(ok ? { configuredAt: new Date() } : {}) },
    });
    await this.prisma.gamingDeviceLog
      .create({
        data: {
          deviceId: device.id,
          venueId: device.venueId,
          kind: 'check',
          actorId: user.id,
          detail: jsonValue({ ok, steps }),
        },
      })
      .catch(() => undefined);
    await this.event(dto.venueId, device.id);
    return { ok, steps };
  }

  /** Best effort: tell the hub to drop a console's credentials (device removed by the owner). */
  async forget(hubId: string | null, consoleId: string) {
    if (!hubId || !this.hubs.isOnline(hubId)) return;
    await this.hubs
      .call(hubId, 'forget', { consoleId }, 8_000)
      .catch(() => undefined);
  }

  // ---- helpers ----

  private access(user: AuthenticatedUser, venueId: string) {
    return this.commands.access(
      this.prisma,
      user,
      venueId,
      'devices.manage',
      true,
    );
  }

  private async ownedHub(
    db: Prisma.TransactionClient | PrismaService,
    venueId: string,
    hubId: string,
  ) {
    const hub = await db.gamingHub.findFirst({ where: { id: hubId, venueId } });
    if (!hub) throw new ForbiddenException({ code: 'HUB_NOT_ACCESSIBLE' });
    return hub;
  }

  private async ownedConsole(venueId: string, id: string) {
    const device = await this.prisma.gamingDevice.findFirst({
      where: { id, venueId, provider: 'ps' },
    });
    if (!device || !device.hubId)
      throw new ForbiddenException({ code: 'DEVICE_NOT_ACCESSIBLE' });
    return device;
  }

  private async callHub(
    hubId: string,
    op: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ) {
    try {
      return await this.hubs.call(hubId, op, args, timeoutMs);
    } catch (error) {
      if (!(error instanceof HubRpcError)) throw error;
      if (error.code === 'HUB_OFFLINE')
        throw new ConflictException({ code: 'HUB_OFFLINE' });
      if (error.code === 'HUB_TIMEOUT')
        throw new GatewayTimeoutException({ code: 'HUB_TIMEOUT' });
      throw new BadRequestException({
        code: HUB_ERROR_CODES.has(error.code) ? error.code : 'HUB_ERROR',
      });
    }
  }

  private event(venueId: string, entityId: string) {
    return this.commands
      .event(
        this.prisma as unknown as Prisma.TransactionClient,
        venueId,
        entityId,
        null,
        'device.changed',
      )
      .catch(() => undefined);
  }
}
