import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { CAMO_PROTOCOL_VERSION } from './camo-constants';
import {
  camoDailyEnabled,
  camoDraining,
  camoEnabled,
  camoPublicMatchEnabled,
  camoVoiceEnabled,
} from './camo-flags';
import {
  CamoHost,
  type CamoUser,
  type HostPolicy,
  type HostSink,
  type JoinResult,
} from './camo-host';
import { CamoProgressService } from './camo-progress.service';
import { CamoPuzzleService } from './camo-puzzle.service';
import { CamoModerationService } from './camo-moderation.service';
import { CamoSettingsService } from './camo-settings.service';
import { ranking, type CamoMatch } from './camo-rules';
import { isShutdownDraining } from '../../common/lifecycle/shutdown-state';
import type { CosmeticState } from './camo-progress';

const GUEST_MORPH = 'guest';
const CLASSIC = 'classic';

export interface CamoFeatures {
  enabled: boolean;
  publicMatch: boolean;
  voice: boolean;
  daily: boolean;
  drain: boolean;
  protocolVersion: number;
  /** The rooms players can be matched into right now. */
  rooms: string[];
}

@Injectable()
export class CamoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CamoService.name);
  readonly host: CamoHost;
  /** Flags as the game reads them: admin overrides on top of the environment. */
  readonly flags: { get<T = string>(key: string): T | undefined };
  private sink: HostSink | null = null;
  private readonly blocked = new Map<string, Set<string>>();
  private readonly denied = new Map<string, string | null>();
  private readonly userCache = new Map<
    string,
    { at: number; user: CamoUser }
  >();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly settingsService: CamoSettingsService,
    readonly moderation: CamoModerationService,
    readonly puzzles: CamoPuzzleService,
    readonly progress: CamoProgressService,
  ) {
    this.flags = this.settingsService.flagSource(this.config);
    const policy: HostPolicy = {
      avoid: (a, b) =>
        !!(this.blocked.get(a)?.has(b) || this.blocked.get(b)?.has(a)),
      denied: (u) => this.denied.get(u) ?? null,
    };
    this.host = new CamoHost({
      maxMatches: this.settingsService.current.maxMatches,
      now: () => Date.now(),
      sink: { emit: (u, e, p, v) => this.sink?.emit(u, e, p, v) },
      policy,
      rooms: () => this.settingsService.current.enabledRooms,
      voiceOn: () => camoVoiceEnabled(this.flags),
      votes: () => this.settingsService.current,
      onModeration: (e) => this.moderation.record(e),
      onMatchEnd: (m) =>
        void (m.puzzle
          ? this.puzzles.finished(m)
          : m.tutorial || m.creator
            ? undefined
            : this.persist(m)),
    });
  }

  private settingsTimer: NodeJS.Timeout | null = null;

  onModuleInit(): void {
    void this.settingsService.load();
    // other API instances and the admin tab write the settings: pick changes up every 30 s
    this.settingsTimer = setInterval(
      () => void this.settingsService.load(true),
      30_000,
    );
    this.settingsTimer.unref?.();
    this.host.start();
  }

  onModuleDestroy(): void {
    if (this.settingsTimer) clearInterval(this.settingsTimer);
    this.host.dispose();
  }

  settings(): ReturnType<CamoSettingsService['load']> extends Promise<infer T>
    ? T
    : never {
    return this.settingsService.current;
  }

  attachSink(sink: HostSink | null): void {
    this.sink = sink;
    this.puzzles.notifyCreator = sink
      ? (u, p) => sink.emit(u, 'camo.challenge.result', p)
      : null;
  }

  features(): CamoFeatures {
    return {
      enabled: camoEnabled(this.flags),
      publicMatch: camoPublicMatchEnabled(this.flags),
      voice: camoVoiceEnabled(this.flags),
      daily: camoDailyEnabled(this.flags),
      drain: camoDraining(this.flags),
      protocolVersion: CAMO_PROTOCOL_VERSION,
      rooms: this.settingsService.current.enabledRooms,
    };
  }

  /** Counts for the room cards and the dashboard/home «n بيلعبوا دلوقتي». */
  live(): { total: number; matches: number; rooms: Record<string, number> } {
    const rooms: Record<string, number> = {};
    let total = 0;
    for (const m of this.host.matches.values()) {
      const n = m.players.filter((p) => !p.isBot && p.connected).length;
      total += n;
      rooms[m.roomId] = (rooms[m.roomId] ?? 0) + n;
    }
    return { total, matches: this.host.matches.size, rooms };
  }

  /** The player as the game sees them: name, body (equipped morph, the guest, or classic) and look. */
  async userFor(userId: string): Promise<CamoUser | null> {
    const hit = this.userCache.get(userId);
    if (hit && Date.now() - hit.at < 60_000) return hit.user;
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        isGuest: true,
        status: true,
        avatarConfig: true,
        morphProfile: { select: { equippedMorphId: true } },
      },
    });
    if (!u || u.status !== 'active') return null;
    const unsupported = this.settingsService.current.camoUnsupported;
    let morphId = u.isGuest
      ? GUEST_MORPH
      : (u.morphProfile?.equippedMorphId ?? CLASSIC);
    // Server-side safety net: a body that failed the M0 tests plays as classic in the match only.
    if (unsupported.includes(morphId)) morphId = CLASSIC;
    const looks: Record<
      string,
      { level: number; equipped: CosmeticState['equipped'] }
    > = await this.progress.looksOf([u.id]).catch(() => ({}));
    const lk = looks[u.id];
    const user: CamoUser = {
      userId: u.id,
      name: u.name,
      morphId,
      guest: u.isGuest,
      look: morphId === CLASSIC ? u.avatarConfig : undefined,
      flair: lk ? { lv: lk.level, eq: lk.equipped } : { lv: 1, eq: {} },
    };
    this.userCache.set(userId, { at: Date.now(), user });
    return user;
  }

  /** Loads what the join policy needs for this user (blocks both ways, active camo bans) before the sync host call. */
  async prepare(userId: string): Promise<void> {
    const now = new Date();
    const [blocks, avoid, ban] = await Promise.all([
      this.prisma.userBlock.findMany({
        where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
        select: { blockerId: true, blockedId: true },
        take: 500,
      }),
      this.prisma.camoMatchmakingAvoid.findMany({
        where: {
          OR: [{ userId }, { avoidUserId: userId }],
          until: { gt: now },
        },
        select: { userId: true, avoidUserId: true },
      }),
      this.prisma.camoSanction.findFirst({
        where: {
          userId,
          kind: 'camo_ban',
          OR: [{ until: null }, { until: { gt: now } }],
        },
        select: { id: true },
      }),
    ]);
    const set = new Set<string>();
    for (const b of blocks)
      set.add(b.blockerId === userId ? b.blockedId : b.blockerId);
    for (const a of avoid)
      set.add(a.userId === userId ? a.avoidUserId : a.userId);
    this.blocked.set(userId, set);
    this.denied.set(userId, ban ? 'camo_ban' : null);
  }

  drainResult(): JoinResult | null {
    return camoDraining(this.flags) || isShutdownDraining()
      ? { ok: false, reason: 'drain' }
      : null;
  }

  /** Stores a finished match and the players' running stats. Bots earn nothing and are not counted as real players. */
  private async persist(m: CamoMatch): Promise<void> {
    try {
      const board = new Map(ranking(m).map((r) => [r.eid, r.rank]));
      await this.prisma.camoMatch.create({
        data: {
          id: m.id,
          roomId: m.roomId,
          mode: m.mode,
          isPrivate: m.isPrivate,
          code: m.code,
          rounds: m.rounds.length,
          botCount: m.players.filter((p) => p.isBot).length,
          startedAt: new Date(m.startedAt || m.createdAt),
          endedAt: new Date(m.endedAt ?? Date.now()),
          players: {
            create: m.players.map((p) => ({
              userId: p.userId,
              isBot: p.isBot,
              name: p.name,
              morphId: p.morphId,
              roles: p.match.roles,
              points: p.total,
              caught: p.match.caught,
              cardsGiven: p.match.cardsGiven,
              yellows: p.match.yellows,
              bestSurvivalMs: p.match.bestSurvivalMs,
              rank: board.get(p.eid) ?? 0,
              awards: p.match.awards,
              won: board.get(p.eid) === 1,
            })),
          },
        },
      });
      for (const p of m.players) {
        if (p.isBot || !p.userId) continue;
        const won = board.get(p.eid) === 1;
        await this.prisma.camoStats.upsert({
          where: { userId: p.userId },
          create: {
            userId: p.userId,
            matches: 1,
            wins: won ? 1 : 0,
            caughtCount: p.match.caught,
            cardsGiven: p.match.cardsGiven,
            yellows: p.match.yellows,
            bestSurvivalMs: p.match.bestSurvivalMs,
            streak: won ? 1 : 0,
          },
          update: {
            matches: { increment: 1 },
            wins: { increment: won ? 1 : 0 },
            caughtCount: { increment: p.match.caught },
            cardsGiven: { increment: p.match.cardsGiven },
            yellows: { increment: p.match.yellows },
            streak: won ? { increment: 1 } : 0,
          },
        });
        await this.progress.award(p, won, m.id);
        await this.prisma
          .$executeRaw`UPDATE "CamoStats" SET "bestSurvivalMs" = GREATEST("bestSurvivalMs", ${p.match.bestSurvivalMs}) WHERE "userId" = ${p.userId}`;
      }
      await this.progress.recordMatch(
        m.players
          .filter((p) => !p.isBot && p.userId)
          .map((p) => ({ userId: p.userId!, won: board.get(p.eid) === 1 })),
      );
    } catch (err) {
      this.logger.error(
        `could not store match ${m.id}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
