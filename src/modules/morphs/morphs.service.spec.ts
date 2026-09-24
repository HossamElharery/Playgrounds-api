import { MorphsService } from './morphs.service';
import { MORPH_CATALOG } from './morph-catalog';

/**
 * Minimal in-memory stand-in for the Prisma calls MorphsService makes, so the
 * transaction logic (idempotency, cooldown, quota, ownership) is exercised
 * end to end rather than asserted call by call.
 */
function fakePrisma() {
  const profiles = new Map<string, any>();
  const morphs: any[] = [];
  const rolls: any[] = [];
  const squadMembers: { userId: string; squadId: string }[] = [];
  const audits: any[] = [];
  const users = new Map<string, any>([
    ['u1', { id: 'u1', createdAt: new Date('2026-01-01T00:00:00Z') }],
    ['u2', { id: 'u2', createdAt: new Date('2026-01-01T00:00:00Z') }],
  ]);
  let seq = 0;
  const newProfile = (userId: string) => ({
    userId,
    equippedMorphId: 'classic',
    totalRolls: 0,
    rollsSinceEpicOrBetter: 0,
    rollsSinceMisk: 0,
    lastRollAt: null,
    bonusRolls: 0,
    updatedAt: new Date(),
  });
  const applyNumber = (current: number, v: any) =>
    typeof v === 'object' && v !== null
      ? 'increment' in v
        ? current + v.increment
        : current - v.decrement
      : v;
  const matchRoll = (r: any, where: any) =>
    r.userId === where.userId &&
    (where.quotaKind === undefined || r.quotaKind === where.quotaKind) &&
    (!where.createdAt ||
      (r.createdAt >= where.createdAt.gte && r.createdAt < where.createdAt.lt));

  const prisma: any = {
    profiles,
    morphs,
    rolls,
    squadMembers,
    audits,
    $executeRaw: jest.fn(
      async (sql: TemplateStringsArray, ...values: any[]) => {
        if (sql.join('?').includes('INSERT INTO "UserMorphProfile"')) {
          const userId = values[0];
          if (!profiles.has(userId)) profiles.set(userId, newProfile(userId));
        }
        return 1;
      },
    ),
    $queryRaw: jest.fn(async () => [
      { count: BigInt(new Set(rolls.map((r) => r.userId)).size) },
    ]),
    $transaction: jest.fn(async (fn: (tx: any) => Promise<unknown>) =>
      fn(prisma),
    ),
    user: {
      findUnique: jest.fn(
        async ({ where }: any) => users.get(where.id) ?? null,
      ),
    },
    userMorphProfile: {
      findUnique: jest.fn(async ({ where }: any) =>
        profiles.has(where.userId) ? { ...profiles.get(where.userId) } : null,
      ),
      findUniqueOrThrow: jest.fn(async ({ where, include }: any) => {
        const p: any = { ...profiles.get(where.userId) };
        if (include?.user)
          p.user = {
            createdAt: users.get(where.userId)?.createdAt ?? new Date(),
          };
        return p;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const p = profiles.get(where.userId);
        for (const [k, v] of Object.entries(data)) {
          p[k] =
            k === 'totalRolls' || k === 'bonusRolls' ? applyNumber(p[k], v) : v;
        }
        return { ...p };
      }),
    },
    userMorph: {
      findMany: jest.fn(async ({ where }: any) =>
        morphs.filter((m) => m.userId === where.userId),
      ),
      findUnique: jest.fn(async ({ where }: any) => {
        const k = where.userId_morphId;
        return (
          morphs.find(
            (m) => m.userId === k.userId && m.morphId === k.morphId,
          ) ?? null
        );
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `m${++seq}`,
          timesObtained: 1,
          firstObtainedAt: new Date(),
          lastObtainedAt: new Date(),
          seenAt: null,
          ...data,
        };
        morphs.push(row);
        return row;
      }),
      createMany: jest.fn(async ({ data }: any) => {
        let count = 0;
        for (const row of data) {
          const dup = morphs.some(
            (m) => m.userId === row.userId && m.morphId === row.morphId,
          );
          if (dup) continue;
          await prisma.userMorph.create({ data: row });
          count++;
        }
        return { count };
      }),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const k = where.userId_morphId;
        const found = morphs.find(
          (m) => m.userId === k.userId && m.morphId === k.morphId,
        );
        if (found) {
          found.timesObtained = applyNumber(
            found.timesObtained,
            update.timesObtained,
          );
          found.lastObtainedAt = update.lastObtainedAt;
          return found;
        }
        return prisma.userMorph.create({ data: create });
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const m of morphs) {
          if (
            m.userId === where.userId &&
            where.morphId.in.includes(m.morphId) &&
            m.seenAt === null
          ) {
            m.seenAt = data.seenAt;
            count++;
          }
        }
        return { count };
      }),
    },
    morphRoll: {
      findUnique: jest.fn(async ({ where }: any) => {
        const k = where.userId_clientRollId;
        return (
          rolls.find(
            (r) => r.userId === k.userId && r.clientRollId === k.clientRollId,
          ) ?? null
        );
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `r${++seq}`, createdAt: new Date(), ...data };
        rolls.push(row);
        return row;
      }),
      count: jest.fn(
        async ({ where }: any) =>
          rolls.filter((r) => matchRoll(r, where)).length,
      ),
      groupBy: jest.fn(async ({ by }: any) => {
        const key = by[0];
        const counts = new Map<string, number>();
        for (const r of rolls)
          counts.set(r[key], (counts.get(r[key]) ?? 0) + 1);
        return [...counts].map(([k, n]) => ({ [key]: k, _count: { _all: n } }));
      }),
    },
    squadMember: {
      findFirst: jest.fn(async ({ where }: any) => {
        const m = squadMembers.find((s) => s.userId === where.userId);
        return m ? { squadId: m.squadId } : null;
      }),
    },
    auditLogEntry: {
      create: jest.fn(async ({ data }: any) => {
        audits.push(data);
        return data;
      }),
    },
  };
  return prisma;
}

function setup(env: Record<string, string | undefined> = {}) {
  const prisma = fakePrisma();
  const emitter = { emitToRoom: jest.fn(), emitToUser: jest.fn() };
  const vars: Record<string, string | undefined> = {
    LOBBY_MORPHS_ENABLED: 'true',
    ...env,
  };
  const config: any = { get: (k: string) => vars[k] };
  const service = new MorphsService(prisma, emitter as any, config);
  return { prisma, emitter, service };
}

const ids = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Lets the next roll pass the 1.2 s cooldown without real waiting. */
function expireCooldown(prisma: any, userId = 'u1') {
  const p = prisma.profiles.get(userId);
  if (p?.lastRollAt) p.lastRollAt = new Date(p.lastRollAt.getTime() - 5000);
}

describe('MorphsService', () => {
  describe('roll', () => {
    it('grants a new morph, equips it and reports progress', async () => {
      const { service, prisma } = setup();
      const res = await service.roll('u1', ids(1));
      expect(MORPH_CATALOG.some((d) => d.id === res.morphId)).toBe(true);
      expect(res.isNew).toBe(true);
      expect(res.timesObtained).toBe(1);
      expect(res.equippedMorphId).toBe(res.morphId);
      expect(res.progress).toEqual({ owned: 1, total: 16 });
      expect(res.quota).toEqual({
        remainingFree: null,
        bonusRolls: 0,
        resetsAt: null,
      });
      const profile = prisma.profiles.get('u1');
      expect(profile.equippedMorphId).toBe(res.morphId);
      expect(profile.totalRolls).toBe(1);
      expect(prisma.rolls[0]).toMatchObject({
        morphId: res.morphId,
        wasNew: true,
        quotaKind: 'FREE',
        catalogVersion: 1,
      });
      expect(prisma.$executeRaw).toHaveBeenCalled();
    });

    it('increments timesObtained when the morph is already owned', async () => {
      const { service, prisma } = setup();
      // Own every catalog morph so any result is a repeat.
      for (const d of MORPH_CATALOG) {
        prisma.morphs.push({
          id: d.id,
          userId: 'u1',
          morphId: d.id,
          source: 'ROLL',
          timesObtained: 2,
          seenAt: new Date(),
        });
      }
      const res = await service.roll('u1', ids(2));
      expect(res.isNew).toBe(false);
      expect(res.timesObtained).toBe(3);
      expect(res.progress).toEqual({ owned: 16, total: 16 });
    });

    it('is idempotent per clientRollId (same result, no side effects)', async () => {
      const { service, prisma, emitter } = setup();
      const first = await service.roll('u1', ids(3));
      emitter.emitToUser.mockClear();
      const again = await service.roll('u1', ids(3));
      expect(again.rollId).toBe(first.rollId);
      expect(again.morphId).toBe(first.morphId);
      expect(again.isNew).toBe(true);
      expect(prisma.rolls).toHaveLength(1);
      expect(prisma.profiles.get('u1').totalRolls).toBe(1);
      expect(emitter.emitToUser).not.toHaveBeenCalled();
    });

    it('returns 429 MORPH_COOLDOWN with retryAfterMs inside the cooldown', async () => {
      const { service, prisma } = setup();
      await service.roll('u1', ids(4));
      const err: any = await service.roll('u1', ids(5)).catch((e) => e);
      expect(err.getStatus()).toBe(429);
      const body = err.getResponse();
      expect(body.code).toBe('MORPH_COOLDOWN');
      expect(body.result.retryAfterMs).toBeGreaterThan(0);
      expect(body.result.retryAfterMs).toBeLessThanOrEqual(1200);
      expect(prisma.rolls).toHaveLength(1);
    });

    it('with MORPH_DAILY_FREE_ROLLS=2 allows two rolls then 429 MORPH_QUOTA_EXHAUSTED', async () => {
      const { service, prisma } = setup({ MORPH_DAILY_FREE_ROLLS: '2' });
      const a = await service.roll('u1', ids(6));
      expect(a.quota.remainingFree).toBe(1);
      expireCooldown(prisma);
      const b = await service.roll('u1', ids(7));
      expect(b.quota.remainingFree).toBe(0);
      expect(b.quota.resetsAt).toEqual(expect.any(String));
      expireCooldown(prisma);
      const err: any = await service.roll('u1', ids(8)).catch((e) => e);
      expect(err.getStatus()).toBe(429);
      expect(err.getResponse().code).toBe('MORPH_QUOTA_EXHAUSTED');
      expect(err.getResponse().result.resetsAt).toBe(b.quota.resetsAt);
      expect(prisma.rolls).toHaveLength(2);
    });

    it('consumes a bonus roll once free rolls are gone', async () => {
      const { service, prisma } = setup({ MORPH_DAILY_FREE_ROLLS: '1' });
      await service.roll('u1', ids(9));
      prisma.profiles.get('u1').bonusRolls = 2;
      expireCooldown(prisma);
      const res = await service.roll('u1', ids(10));
      expect(prisma.rolls[1].quotaKind).toBe('BONUS');
      expect(prisma.profiles.get('u1').bonusRolls).toBe(1);
      expect(res.quota).toMatchObject({ remainingFree: 0, bonusRolls: 1 });
    });

    it('broadcasts to the squad room only when the roller is in a squad', async () => {
      const { service, prisma, emitter } = setup();
      const solo = await service.roll('u1', ids(11));
      expect(emitter.emitToRoom).not.toHaveBeenCalled();
      expect(emitter.emitToUser).toHaveBeenCalledWith('u1', {
        type: 'morph.self.updated',
        equippedMorphId: solo.morphId,
        rollId: solo.rollId,
      });

      prisma.squadMembers.push({ userId: 'u1', squadId: 'sq1' });
      expireCooldown(prisma);
      const res = await service.roll('u1', ids(12));
      expect(emitter.emitToRoom).toHaveBeenCalledTimes(1);
      expect(emitter.emitToRoom).toHaveBeenCalledWith('squad:sq1', {
        type: 'squad.member.morph',
        squadId: 'sq1',
        userId: 'u1',
        morphId: res.morphId,
        tier: res.tier,
        reason: 'roll',
        rollId: res.rollId,
        isNew: res.isNew,
        at: expect.any(String),
      });
      expect(prisma.rolls[1].squadId).toBe('sq1');
    });

    it('never returns the currently equipped morph', async () => {
      const { service, prisma } = setup();
      for (let i = 0; i < 40; i++) {
        const before = prisma.profiles.get('u1')?.equippedMorphId ?? 'classic';
        const res = await service.roll('u1', ids(100 + i));
        expect(res.morphId).not.toBe(before);
        expireCooldown(prisma);
      }
    });
  });

  describe('equip', () => {
    it('404s an unknown id', async () => {
      const { service } = setup();
      const err: any = await service.equip('u1', 'unicorn').catch((e) => e);
      expect(err.getStatus()).toBe(404);
      expect(err.getResponse().code).toBe('MORPH_UNKNOWN');
    });

    it('403s a morph the user does not own', async () => {
      const { service } = setup();
      const err: any = await service.equip('u1', 'dino').catch((e) => e);
      expect(err.getStatus()).toBe(403);
      expect(err.getResponse().code).toBe('MORPH_NOT_OWNED');
    });

    it('is a no-op without broadcast when already equipped', async () => {
      const { service, emitter } = setup();
      await expect(service.equip('u1', 'classic')).resolves.toEqual({
        equippedMorphId: 'classic',
        changed: false,
      });
      expect(emitter.emitToRoom).not.toHaveBeenCalled();
      expect(emitter.emitToUser).not.toHaveBeenCalled();
    });

    it('equips an owned morph and broadcasts reason equip', async () => {
      const { service, prisma, emitter } = setup();
      prisma.morphs.push({
        id: 'x',
        userId: 'u1',
        morphId: 'dino',
        source: 'ROLL',
        timesObtained: 1,
        seenAt: null,
      });
      prisma.squadMembers.push({ userId: 'u1', squadId: 'sq1' });
      await expect(service.equip('u1', 'dino')).resolves.toEqual({
        equippedMorphId: 'dino',
        changed: true,
      });
      expect(prisma.profiles.get('u1').equippedMorphId).toBe('dino');
      expect(emitter.emitToRoom).toHaveBeenCalledWith('squad:sq1', {
        type: 'squad.member.morph',
        squadId: 'sq1',
        userId: 'u1',
        morphId: 'dino',
        tier: 'EPIC',
        reason: 'equip',
        at: expect.any(String),
      });
      // Back to classic is always allowed (tier null).
      await service.equip('u1', 'classic');
      expect(emitter.emitToRoom).toHaveBeenLastCalledWith(
        'squad:sq1',
        expect.objectContaining({ morphId: 'classic', tier: null }),
      );
    });
  });

  describe('me', () => {
    it('returns { enabled: false } and touches nothing while the flag is off', async () => {
      const { service, prisma } = setup({ LOBBY_MORPHS_ENABLED: undefined });
      await expect(service.me('u1')).resolves.toEqual({ enabled: false });
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
      expect(prisma.profiles.size).toBe(0);
    });

    it('includes classic as owned but not in progress, and hides unknown ids', async () => {
      const { service, prisma } = setup();
      prisma.morphs.push(
        {
          id: 'a',
          userId: 'u1',
          morphId: 'potato',
          source: 'ROLL',
          timesObtained: 2,
          firstObtainedAt: new Date(),
          seenAt: null,
        },
        {
          id: 'b',
          userId: 'u1',
          morphId: 'retired_morph',
          source: 'ROLL',
          timesObtained: 1,
          firstObtainedAt: new Date(),
          seenAt: null,
        },
      );
      const me: any = await service.me('u1');
      expect(me.enabled).toBe(true);
      expect(me.owned.map((o: any) => o.morphId)).toEqual([
        'classic',
        'potato',
      ]);
      expect(me.owned[0]).toMatchObject({
        source: 'DEFAULT',
        tier: null,
        isNew: false,
      });
      expect(me.owned[1]).toMatchObject({
        tier: 'COMMON',
        timesObtained: 2,
        isNew: true,
      });
      expect(me.progress).toEqual({ owned: 1, total: 16 });
      expect(me.odds).toEqual({ COMMON: 7800, EPIC: 1900, MISK: 300 });
      expect(me.pity).toEqual({ epicEvery: 10, miskEvery: 50 });
      expect(me.cooldownMs).toBe(1200);
      expect(me.equippedMorphId).toBe('classic');
      // Never deleted.
      expect(prisma.morphs).toHaveLength(2);
    });
  });

  it('markSeen is bounded to 50 ids and only touches the caller’s rows', async () => {
    const { service, prisma } = setup();
    prisma.morphs.push(
      { id: 'a', userId: 'u1', morphId: 'potato', seenAt: null },
      { id: 'b', userId: 'u2', morphId: 'potato', seenAt: null },
    );
    const many = Array.from({ length: 80 }, (_, i) => `m${i}`).concat('potato');
    await service.markSeen('u1', many);
    const call = prisma.userMorph.updateMany.mock.calls[0][0];
    expect(call.where.morphId.in.length).toBe(50);
    await service.markSeen('u1', ['potato']);
    expect(prisma.morphs[0].seenAt).not.toBeNull();
    expect(prisma.morphs[1].seenAt).toBeNull();
  });

  describe('admin', () => {
    it('grant adds a GRANT morph without equipping it and writes an audit entry', async () => {
      const { service, prisma, emitter } = setup();
      await expect(
        service.grant('admin1', 'u2', 'golden_pharaoh'),
      ).resolves.toEqual({
        userId: 'u2',
        morphId: 'golden_pharaoh',
        granted: true,
      });
      expect(prisma.morphs[0]).toMatchObject({
        userId: 'u2',
        morphId: 'golden_pharaoh',
        source: 'GRANT',
      });
      expect(prisma.profiles.get('u2')).toBeUndefined();
      expect(prisma.audits[0]).toMatchObject({
        actorUserId: 'admin1',
        action: 'admin.morph.grant',
        targetId: 'u2',
      });
      expect(emitter.emitToUser).toHaveBeenCalledWith('u2', {
        type: 'morph.self.updated',
        equippedMorphId: 'classic',
      });
      await expect(
        service.grant('admin1', 'u2', 'golden_pharaoh'),
      ).resolves.toMatchObject({ granted: false });
      expect(prisma.morphs).toHaveLength(1);
    });

    it('grant rejects unknown morphs and users', async () => {
      const { service } = setup();
      expect(
        (
          await service.grant('a', 'u2', 'classic').catch((e) => e)
        ).getResponse().code,
      ).toBe('MORPH_UNKNOWN');
      expect(
        (
          await service.grant('a', 'nobody', 'potato').catch((e) => e)
        ).getResponse().code,
      ).toBe('USER_NOT_FOUND');
    });

    it('stats aggregates rolls per tier and morph', async () => {
      const { service, prisma } = setup();
      prisma.rolls.push(
        { userId: 'u1', tier: 'COMMON', morphId: 'potato' },
        { userId: 'u1', tier: 'MISK', morphId: 'tuktuk' },
        { userId: 'u2', tier: 'COMMON', morphId: 'potato' },
      );
      const s = await service.stats(7);
      expect(s).toMatchObject({
        days: 7,
        totalRolls: 3,
        perTier: { COMMON: 2, EPIC: 0, MISK: 1 },
        perMorph: { potato: 2, tuktuk: 1 },
        uniqueRollers: 2,
        miskPulls: 1,
      });
    });
  });
});
