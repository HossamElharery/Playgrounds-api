import { AssistantKnowledgeService } from './assistant-knowledge.service';
import { KNOWLEDGE } from './default-knowledge';

const config = (env: Record<string, string> = {}) => ({ get: (k: string) => env[k] }) as never;

/** A tiny in-memory stand-in for the three tables the service touches. */
function fakeDb(initial: Record<string, unknown>[] = [], revisions: { knowledgeId: string; action?: string; snapshot?: unknown; id?: string; createdAt?: Date }[] = []) {
  const rows = new Map<string, Record<string, unknown>>(initial.map((r) => [r['id'] as string, { updatedAt: new Date(), createdAt: new Date(), position: 0, active: true, ...r }]));
  const revs = [...revisions];
  const audit: unknown[] = [];
  const knowledge = {
    findMany: jest.fn(async (args: { where?: { active?: boolean; id?: { in: string[] } }; select?: unknown } = {}) => {
      let list = [...rows.values()];
      if (args.where?.active !== undefined) list = list.filter((r) => r.active === args.where!.active);
      if (args.where?.id) list = list.filter((r) => args.where!.id!.in.includes(r.id as string));
      return list.sort((a, b) => (a.position as number) - (b.position as number));
    }),
    findUnique: jest.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = { updatedAt: new Date(), createdAt: new Date(), active: true, ...data };
      rows.set(data['id'] as string, row);
      return row;
    }),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = { ...rows.get(where.id)!, ...data, updatedAt: new Date() };
      rows.set(where.id, row);
      return row;
    }),
    upsert: jest.fn(async ({ where, create, update }: { where: { id: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
      const row = { ...(rows.get(where.id) ?? { updatedAt: new Date(), createdAt: new Date(), active: true, ...create }), ...(rows.has(where.id) ? update : {}), updatedAt: new Date() };
      rows.set(where.id, row);
      return row;
    }),
    delete: jest.fn(async ({ where }: { where: { id: string } }) => {
      rows.delete(where.id);
    }),
    aggregate: jest.fn(async () => ({ _max: { position: Math.max(0, ...[...rows.values()].map((r) => r.position as number)) } })),
  };
  const revision = {
    findMany: jest.fn(async (args: { where?: { knowledgeId?: string | { in: string[] }; action?: string } } = {}) =>
      revs.filter((r) => {
        const k = args.where?.knowledgeId;
        if (typeof k === 'string' && r.knowledgeId !== k) return false;
        if (k && typeof k === 'object' && !k.in.includes(r.knowledgeId)) return false;
        if (args.where?.action && r.action !== args.where.action) return false;
        return true;
      }),
    ),
    findFirst: jest.fn(async ({ where }: { where: { id: string; knowledgeId: string } }) => revs.find((r) => r.id === where.id && r.knowledgeId === where.knowledgeId) ?? null),
    create: jest.fn(async ({ data }: { data: { knowledgeId: string; action: string; snapshot: unknown } }) => {
      revs.push({ id: `rev${revs.length + 1}`, createdAt: new Date(), ...data });
    }),
  };
  const db: Record<string, unknown> = {
    assistantKnowledge: knowledge,
    assistantKnowledgeRevision: revision,
    auditLogEntry: { create: jest.fn(async ({ data }: { data: unknown }) => void audit.push(data)) },
    $transaction: jest.fn(async (arg: unknown) => (typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(db) : Promise.all(arg as Promise<unknown>[]))),
  };
  return { db, rows, revs, audit };
}

const entry = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  topicAr: 'موضوع ' + id,
  topicEn: 'topic ' + id,
  ar: 'نص ' + id,
  en: 'text ' + id,
  ctaTarget: null,
  ctaLabelAr: null,
  ctaLabelEn: null,
  flag: null,
  active: true,
  ...over,
});

describe('AssistantKnowledgeService', () => {
  describe('seeding', () => {
    it('adds the whole built-in pack to an empty table, once', async () => {
      const { db, rows } = fakeDb();
      const s = new AssistantKnowledgeService(config(), db as never);
      expect(await s.seedMissing()).toBe(KNOWLEDGE.length);
      expect(rows.size).toBe(KNOWLEDGE.length);
      expect(await s.seedMissing()).toBe(0);
    });

    it('never overwrites an entry the admin has edited', async () => {
      const { db, rows } = fakeDb([entry('how_booking', { ar: 'نص عدّله الأدمن' })]);
      const s = new AssistantKnowledgeService(config(), db as never);
      await s.seedMissing();
      expect(rows.get('how_booking')?.['ar']).toBe('نص عدّله الأدمن');
      expect(rows.size).toBe(KNOWLEDGE.length);
    });

    it('does not bring back an entry the admin deleted', async () => {
      const { db, rows } = fakeDb([], [{ knowledgeId: 'no_show', action: 'delete', snapshot: {} }]);
      const s = new AssistantKnowledgeService(config(), db as never);
      await s.seedMissing();
      expect(rows.has('no_show')).toBe(false);
      expect(rows.size).toBe(KNOWLEDGE.length - 1);
    });

    it('survives a database that is not ready', async () => {
      const { db } = fakeDb();
      (db['assistantKnowledge'] as { findMany: jest.Mock }).findMany.mockRejectedValue(new Error('no table'));
      const s = new AssistantKnowledgeService(config(), db as never);
      await expect(s.seedMissing()).resolves.toBe(0);
    });
  });

  describe('reading', () => {
    it('serves the active entries from the table, in order, cached for a minute', async () => {
      const { db } = fakeDb([entry('b', { position: 20 }), entry('a', { position: 10 }), entry('off', { active: false })]);
      const s = new AssistantKnowledgeService(config(), db as never);
      expect((await s.entries()).map((e) => e.id)).toEqual(['a', 'b']);
      await s.entries();
      expect((db['assistantKnowledge'] as { findMany: jest.Mock }).findMany).toHaveBeenCalledTimes(1);
      s.invalidate();
      await s.entries();
      expect((db['assistantKnowledge'] as { findMany: jest.Mock }).findMany).toHaveBeenCalledTimes(2);
    });

    it('falls back to the built-in pack when the table is empty or unreachable', async () => {
      const empty = new AssistantKnowledgeService(config(), fakeDb().db as never);
      expect(await empty.source()).toBe('file');
      expect((await empty.entries()).length).toBe(KNOWLEDGE.length);

      const { db } = fakeDb();
      (db['assistantKnowledge'] as { findMany: jest.Mock }).findMany.mockRejectedValue(new Error('db down'));
      const broken = new AssistantKnowledgeService(config(), db as never);
      expect((await broken.entries()).length).toBe(KNOWLEDGE.length);
      expect(await broken.source()).toBe('file');
    });

    it('leaves out a lobby entry whose feature is switched off in this deployment', async () => {
      const { db } = fakeDb([entry('plain'), entry('morphy', { flag: 'morphs' }), entry('ballish', { flag: 'ball' })]);
      const off = new AssistantKnowledgeService(config(), db as never);
      expect((await off.forPlayers()).map((e) => e.id)).toEqual(['plain']);
      const on = new AssistantKnowledgeService(config({ LOBBY_MORPHS_ENABLED: 'true', LOBBY_BALL_ENABLED: 'true' }), db as never);
      // The ball needs movement too, exactly like the lobby.
      expect((await on.forPlayers()).map((e) => e.id).sort()).toEqual(['morphy', 'plain']);
    });
  });

  describe('editing', () => {
    it('creates an entry with a revision and an audit line, and makes it live at once', async () => {
      const { db, revs, audit } = fakeDb([entry('a')]);
      const s = new AssistantKnowledgeService(config(), db as never);
      await s.entries();
      const out = await s.create({ id: 'fresh', topicAr: 'موضوع جديد عن الحجز', topicEn: 'A fresh topic', ar: 'نص', en: 'text' }, 'admin1');
      expect(out.item.id).toBe('fresh');
      expect(revs.map((r) => r.action)).toContain('create');
      expect(audit).toContainEqual(expect.objectContaining({ action: 'ai.knowledge.create', actorUserId: 'admin1' }));
      expect((await s.entries()).map((e) => e.id)).toContain('fresh');
    });

    it('refuses an invalid entry with per-field codes and writes nothing', async () => {
      const { db, rows } = fakeDb();
      const s = new AssistantKnowledgeService(config(), db as never);
      await expect(s.create({ id: 'Bad Id', topicAr: 'x' }, 'admin1')).rejects.toMatchObject({ response: { code: 'VALIDATION_FAILED', result: { errors: expect.objectContaining({ id: 'invalid_id' }) } } });
      expect(rows.size).toBe(0);
    });

    it('changes only the fields that were sent (a partial update must not blank the rest)', async () => {
      const { db, rows, revs } = fakeDb([entry('a', { topicAr: 'موضوع أصلي طويل', topicEn: 'original topic long' })]);
      const s = new AssistantKnowledgeService(config(), db as never);
      // What a DTO instance looks like: every declared field present, the unsent ones undefined.
      await s.update('a', { id: undefined, topicAr: undefined, topicEn: undefined, ar: 'نص معدّل', en: undefined, ctaTarget: undefined, flag: undefined, active: undefined }, 'admin1');
      expect(rows.get('a')).toMatchObject({ ar: 'نص معدّل', en: 'text a', topicAr: 'موضوع أصلي طويل' });
      expect(revs.at(-1)?.action).toBe('update');
    });

    it('can switch an entry off without deleting it, and it stops being served', async () => {
      const { db } = fakeDb([entry('a'), entry('b')]);
      const s = new AssistantKnowledgeService(config(), db as never);
      await s.update('a', { active: false }, 'admin1');
      expect((await s.entries()).map((e) => e.id)).toEqual(['b']);
    });

    it('keeps a deleted entry restorable, and does not reseed it', async () => {
      const { db, rows } = fakeDb([entry('how_booking')]);
      const s = new AssistantKnowledgeService(config(), db as never);
      await s.remove('how_booking', 'admin1');
      expect(rows.has('how_booking')).toBe(false);
      expect((await s.deletedEntries()).map((d) => d.id)).toEqual(['how_booking']);
      await s.seedMissing();
      expect(rows.has('how_booking')).toBe(false);
      const [deleted] = await s.deletedEntries();
      await s.restore('how_booking', deleted.revisionId, 'admin1');
      expect(rows.has('how_booking')).toBe(true);
    });

    it('resets an entry to the built-in wording', async () => {
      const { db, rows } = fakeDb([entry('how_booking', { ar: 'غيّرته' })]);
      const s = new AssistantKnowledgeService(config(), db as never);
      await s.resetToDefault('how_booking', 'admin1');
      expect(rows.get('how_booking')?.['ar']).toBe(KNOWLEDGE.find((k) => k.id === 'how_booking')?.ar);
      await expect(s.resetToDefault('not_in_pack', 'admin1')).rejects.toBeDefined();
    });

    it('marks which entries were edited away from the built-in text', async () => {
      const original = KNOWLEDGE[0];
      const { db } = fakeDb([
        entry(original.id, { topicAr: original.topicAr, topicEn: original.topicEn, ar: original.ar, en: original.en, ctaTarget: original.cta?.target ?? null, ctaLabelAr: original.cta?.labelAr ?? null, ctaLabelEn: original.cta?.labelEn ?? null }),
        entry(KNOWLEDGE[1].id, { ar: 'edited' }),
        entry('custom'),
      ]);
      const { items } = await new AssistantKnowledgeService(config(), db as never).listAll();
      const by = Object.fromEntries(items.map((i) => [i.id, i]));
      expect(by[original.id]).toMatchObject({ inFile: true, editedFromFile: false });
      expect(by[KNOWLEDGE[1].id]).toMatchObject({ inFile: true, editedFromFile: true });
      expect(by['custom']).toMatchObject({ inFile: false, editedFromFile: false });
    });
  });
});
