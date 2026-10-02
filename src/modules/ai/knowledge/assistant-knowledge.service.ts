import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type AssistantKnowledge } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { KNOWLEDGE, type KnowledgeEntry } from './default-knowledge';
import { filterKnowledgeByFlags } from './knowledge-flags';
import { checkKnowledge, type KnowledgeCheck, type KnowledgeInput, type KnowledgeValue, type KnowledgeWarning } from './knowledge.validation';

/** The filter forwards `code` and `result`, so the editor can show each field's problem next to the field. */
export function validationError(errors: Record<string, string>): BadRequestException {
  return new BadRequestException({ message: 'VALIDATION_FAILED', code: 'VALIDATION_FAILED', result: { errors } });
}

const CACHE_MS = 60_000;
const ERROR_CACHE_MS = 15_000;
const POSITION_STEP = 10;

export interface KnowledgeRow extends KnowledgeValue {
  position: number;
  updatedAt: string | null;
  updatedById: string | null;
  /** This id exists in the built-in pack. */
  inFile: boolean;
  /** …and the stored text differs from the built-in one (an admin edited it). */
  editedFromFile: boolean;
}

export interface KnowledgeRevisionView {
  id: string;
  action: string;
  actorUserId: string | null;
  createdAt: string;
  snapshot: Record<string, unknown>;
}

function toEntry(r: AssistantKnowledge): KnowledgeEntry {
  return {
    id: r.id,
    topicAr: r.topicAr,
    topicEn: r.topicEn,
    ar: r.ar,
    en: r.en,
    cta: r.ctaTarget ? { target: r.ctaTarget, labelAr: r.ctaLabelAr ?? '', labelEn: r.ctaLabelEn ?? '' } : undefined,
    when: r.flag ?? undefined,
  };
}

function fileValue(e: KnowledgeEntry): KnowledgeValue {
  return {
    id: e.id,
    topicAr: e.topicAr,
    topicEn: e.topicEn,
    ar: e.ar,
    en: e.en,
    ctaTarget: e.cta?.target ?? null,
    ctaLabelAr: e.cta?.labelAr ?? null,
    ctaLabelEn: e.cta?.labelEn ?? null,
    flag: e.when ?? null,
    active: true,
  };
}

const COMPARED = ['topicAr', 'topicEn', 'ar', 'en', 'ctaTarget', 'ctaLabelAr', 'ctaLabelEn', 'flag'] as const;

function snapshotOf(r: AssistantKnowledge): Record<string, unknown> {
  return {
    id: r.id,
    topicAr: r.topicAr,
    topicEn: r.topicEn,
    ar: r.ar,
    en: r.en,
    ctaTarget: r.ctaTarget,
    ctaLabelAr: r.ctaLabelAr,
    ctaLabelEn: r.ctaLabelEn,
    flag: r.flag,
    active: r.active,
    position: r.position,
  };
}

/**
 * The platform facts Captain may state. Edited by an admin in the database,
 * read through a 60-second cache, and never a single point of failure: an
 * empty table or an unreachable database serves the built-in pack instead.
 */
@Injectable()
export class AssistantKnowledgeService implements OnModuleInit {
  private readonly logger = new Logger(AssistantKnowledgeService.name);
  private cache: { exp: number; entries: KnowledgeEntry[]; source: 'db' | 'file' } | null = null;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.seedMissing();
  }

  // -------------------------------------------------------------- read ----

  /** Every active entry, whatever deployment flags say. */
  async entries(): Promise<KnowledgeEntry[]> {
    return (await this.load()).entries;
  }

  /** Where the answers currently come from (the admin screen shows it). */
  async source(): Promise<'db' | 'file'> {
    return (await this.load()).source;
  }

  /** What this deployment may actually promise: a lobby feature that is switched off is left out. */
  async forPlayers(): Promise<KnowledgeEntry[]> {
    return this.forDeployment((await this.load()).entries);
  }

  forDeployment(entries: KnowledgeEntry[]): KnowledgeEntry[] {
    return filterKnowledgeByFlags(entries, (name) => this.config.get<string>(name));
  }

  invalidate(): void {
    this.cache = null;
  }

  private async load(): Promise<NonNullable<typeof this.cache>> {
    const now = Date.now();
    if (this.cache && this.cache.exp > now) return this.cache;
    if (!this.prisma) return (this.cache = { exp: now + CACHE_MS, entries: KNOWLEDGE, source: 'file' });
    try {
      const rows = await this.prisma.assistantKnowledge.findMany({
        where: { active: true },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
      });
      this.cache = rows.length
        ? { exp: now + CACHE_MS, entries: rows.map(toEntry), source: 'db' }
        : { exp: now + CACHE_MS, entries: KNOWLEDGE, source: 'file' };
    } catch (err) {
      this.logger.warn(`[knowledge] table unreadable, serving the built-in pack: ${String(err)}`);
      this.cache = { exp: now + ERROR_CACHE_MS, entries: KNOWLEDGE, source: 'file' };
    }
    return this.cache;
  }

  // -------------------------------------------------------------- seed ----

  /**
   * Adds the built-in entries the table has never had. An entry that already
   * exists is left exactly as the admin made it, and one that has any history
   * (including a deletion) is not brought back.
   */
  async seedMissing(): Promise<number> {
    if (!this.prisma) return 0;
    const prisma = this.prisma;
    try {
      const ids = KNOWLEDGE.map((e) => e.id);
      const [existing, known] = await Promise.all([
        prisma.assistantKnowledge.findMany({ where: { id: { in: ids } }, select: { id: true } }),
        prisma.assistantKnowledgeRevision.findMany({ where: { knowledgeId: { in: ids } }, select: { knowledgeId: true }, distinct: ['knowledgeId'] }),
      ]);
      const skip = new Set([...existing.map((r) => r.id), ...known.map((r) => r.knowledgeId)]);
      let seeded = 0;
      for (const [index, e] of KNOWLEDGE.entries()) {
        if (skip.has(e.id)) continue;
        const v = fileValue(e);
        try {
          await prisma.$transaction(async (tx) => {
            const row = await tx.assistantKnowledge.create({ data: { ...v, position: index * POSITION_STEP } });
            await tx.assistantKnowledgeRevision.create({ data: { knowledgeId: e.id, action: 'seed', snapshot: snapshotOf(row) as Prisma.InputJsonValue } });
          });
          seeded += 1;
        } catch (err) {
          // Another instance seeded it a moment earlier.
          if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
        }
      }
      if (seeded) {
        this.logger.log(`[knowledge] seeded ${seeded} built-in entr${seeded === 1 ? 'y' : 'ies'}`);
        this.invalidate();
      }
      return seeded;
    } catch (err) {
      this.logger.warn(`[knowledge] seeding skipped: ${String(err)}`);
      return 0;
    }
  }

  // ------------------------------------------------------------- admin ----

  private db(): PrismaService {
    if (!this.prisma) throw new BadRequestException('database not available');
    return this.prisma;
  }

  private row(r: AssistantKnowledge): KnowledgeRow {
    const file = KNOWLEDGE.find((e) => e.id === r.id);
    const fv = file ? fileValue(file) : null;
    const value = { ...snapshotOf(r) } as Record<string, unknown>;
    return {
      id: r.id,
      topicAr: r.topicAr,
      topicEn: r.topicEn,
      ar: r.ar,
      en: r.en,
      ctaTarget: r.ctaTarget,
      ctaLabelAr: r.ctaLabelAr,
      ctaLabelEn: r.ctaLabelEn,
      flag: r.flag,
      active: r.active,
      position: r.position,
      updatedAt: r.updatedAt.toISOString(),
      updatedById: r.updatedById,
      inFile: !!file,
      editedFromFile: !!fv && COMPARED.some((k) => (fv[k] ?? null) !== (value[k] ?? null)),
    };
  }

  async listAll(): Promise<{ source: 'db' | 'file'; items: KnowledgeRow[] }> {
    const rows = await this.db().assistantKnowledge.findMany({ orderBy: [{ position: 'asc' }, { id: 'asc' }] });
    return { source: await this.source(), items: rows.map((r) => this.row(r)) };
  }

  async getOne(id: string): Promise<{ item: KnowledgeRow; revisions: KnowledgeRevisionView[] }> {
    const db = this.db();
    const [row, revisions] = await Promise.all([
      db.assistantKnowledge.findUnique({ where: { id } }),
      db.assistantKnowledgeRevision.findMany({ where: { knowledgeId: id }, orderBy: { createdAt: 'desc' }, take: 30 }),
    ]);
    if (!row) throw new NotFoundException('knowledge entry not found');
    return { item: this.row(row), revisions: revisions.map((r) => this.revisionView(r)) };
  }

  /** Revisions of an entry that no longer exists (to restore a deleted one). */
  async deletedEntries(): Promise<{ id: string; deletedAt: string; revisionId: string; snapshot: Record<string, unknown> }[]> {
    const db = this.db();
    const deletes = await db.assistantKnowledgeRevision.findMany({ where: { action: 'delete' }, orderBy: { createdAt: 'desc' }, take: 50 });
    const alive = new Set((await db.assistantKnowledge.findMany({ select: { id: true } })).map((r) => r.id));
    const seen = new Set<string>();
    const out: { id: string; deletedAt: string; revisionId: string; snapshot: Record<string, unknown> }[] = [];
    for (const d of deletes) {
      if (alive.has(d.knowledgeId) || seen.has(d.knowledgeId)) continue;
      seen.add(d.knowledgeId);
      out.push({ id: d.knowledgeId, deletedAt: d.createdAt.toISOString(), revisionId: d.id, snapshot: d.snapshot as Record<string, unknown> });
    }
    return out;
  }

  private revisionView(r: { id: string; action: string; actorUserId: string | null; createdAt: Date; snapshot: Prisma.JsonValue }): KnowledgeRevisionView {
    return { id: r.id, action: r.action, actorUserId: r.actorUserId, createdAt: r.createdAt.toISOString(), snapshot: (r.snapshot ?? {}) as Record<string, unknown> };
  }

  /** Validation for the editor's live feedback, without saving. */
  async check(input: KnowledgeInput, opts: { creating: boolean }): Promise<KnowledgeCheck> {
    const others = await this.db().assistantKnowledge.findMany({ where: { active: true }, select: { id: true, topicAr: true, topicEn: true } });
    return checkKnowledge(input, { requireId: opts.creating, others: opts.creating ? others : others.filter((o) => o.id !== input.id) });
  }

  private refuse(check: KnowledgeCheck): never {
    throw validationError(check.errors);
  }

  async create(input: KnowledgeInput, actorUserId: string): Promise<{ item: KnowledgeRow; warnings: KnowledgeWarning[] }> {
    const db = this.db();
    const check = await this.check(input, { creating: true });
    if (!check.value) this.refuse(check);
    const v = check.value;
    const last = await db.assistantKnowledge.aggregate({ _max: { position: true } });
    try {
      const row = await db.$transaction(async (tx) => {
        const created = await tx.assistantKnowledge.create({ data: { ...v, position: (last._max.position ?? 0) + POSITION_STEP, updatedById: actorUserId } });
        await tx.assistantKnowledgeRevision.create({ data: { knowledgeId: v.id, action: 'create', snapshot: snapshotOf(created) as Prisma.InputJsonValue, actorUserId } });
        await tx.auditLogEntry.create({ data: { actorUserId, action: 'ai.knowledge.create', targetType: 'assistant_knowledge', targetId: v.id } });
        return created;
      });
      this.invalidate();
      return { item: this.row(row), warnings: check.warnings };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw validationError({ id: 'duplicate_id' });
      }
      throw err;
    }
  }

  async update(id: string, input: KnowledgeInput, actorUserId: string): Promise<{ item: KnowledgeRow; warnings: KnowledgeWarning[] }> {
    const db = this.db();
    const current = await db.assistantKnowledge.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('knowledge entry not found');
    // A DTO instance carries every declared field, the unsent ones as `undefined`; only what was actually sent changes.
    const sent = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
    const merged = { ...snapshotOf(current), ...sent, id };
    const check = await this.check(merged, { creating: false });
    if (!check.value) this.refuse(check);
    const { id: _id, ...data } = check.value;
    void _id;
    const changed = COMPARED.filter((k) => (current[k] ?? null) !== (data[k] ?? null)).concat(current.active !== data.active ? (['active'] as never[]) : []);
    const row = await db.$transaction(async (tx) => {
      const updated = await tx.assistantKnowledge.update({ where: { id }, data: { ...data, updatedById: actorUserId } });
      await tx.assistantKnowledgeRevision.create({ data: { knowledgeId: id, action: 'update', snapshot: snapshotOf(updated) as Prisma.InputJsonValue, actorUserId } });
      await tx.auditLogEntry.create({ data: { actorUserId, action: 'ai.knowledge.update', targetType: 'assistant_knowledge', targetId: id, metadata: { changed } as Prisma.InputJsonValue } });
      return updated;
    });
    this.invalidate();
    return { item: this.row(row), warnings: check.warnings };
  }

  async remove(id: string, actorUserId: string): Promise<void> {
    const db = this.db();
    const current = await db.assistantKnowledge.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('knowledge entry not found');
    await db.$transaction(async (tx) => {
      await tx.assistantKnowledgeRevision.create({ data: { knowledgeId: id, action: 'delete', snapshot: snapshotOf(current) as Prisma.InputJsonValue, actorUserId } });
      await tx.assistantKnowledge.delete({ where: { id } });
      await tx.auditLogEntry.create({ data: { actorUserId, action: 'ai.knowledge.delete', targetType: 'assistant_knowledge', targetId: id } });
    });
    this.invalidate();
  }

  /** Puts an entry back to the way a stored revision had it (also brings a deleted entry back). */
  async restore(id: string, revisionId: string, actorUserId: string): Promise<KnowledgeRow> {
    const db = this.db();
    const rev = await db.assistantKnowledgeRevision.findFirst({ where: { id: revisionId, knowledgeId: id } });
    if (!rev) throw new NotFoundException('revision not found');
    const snap = rev.snapshot as Record<string, unknown>;
    const check = checkKnowledge({ ...snap, id }, { requireId: true });
    if (!check.value) this.refuse(check);
    const { id: _id, ...data } = check.value;
    void _id;
    const position = typeof snap['position'] === 'number' ? (snap['position'] as number) : 0;
    const row = await db.$transaction(async (tx) => {
      const saved = await tx.assistantKnowledge.upsert({
        where: { id },
        create: { id, ...data, position, updatedById: actorUserId },
        update: { ...data, updatedById: actorUserId },
      });
      await tx.assistantKnowledgeRevision.create({ data: { knowledgeId: id, action: 'restore', snapshot: snapshotOf(saved) as Prisma.InputJsonValue, actorUserId } });
      await tx.auditLogEntry.create({ data: { actorUserId, action: 'ai.knowledge.restore', targetType: 'assistant_knowledge', targetId: id, metadata: { revisionId } as Prisma.InputJsonValue } });
      return saved;
    });
    this.invalidate();
    return this.row(row);
  }

  /** Back to the built-in wording for an entry that exists in the pack. */
  async resetToDefault(id: string, actorUserId: string): Promise<KnowledgeRow> {
    const file = KNOWLEDGE.find((e) => e.id === id);
    if (!file) throw validationError({ id: 'not_in_default_pack' });
    const db = this.db();
    const v = fileValue(file);
    const current = await db.assistantKnowledge.findUnique({ where: { id }, select: { position: true } });
    const row = await db.$transaction(async (tx) => {
      const saved = await tx.assistantKnowledge.upsert({
        where: { id },
        create: { ...v, position: KNOWLEDGE.indexOf(file) * POSITION_STEP, updatedById: actorUserId },
        update: { ...v, updatedById: actorUserId },
      });
      await tx.assistantKnowledgeRevision.create({ data: { knowledgeId: id, action: 'reset', snapshot: snapshotOf(saved) as Prisma.InputJsonValue, actorUserId } });
      await tx.auditLogEntry.create({ data: { actorUserId, action: 'ai.knowledge.reset', targetType: 'assistant_knowledge', targetId: id } });
      return saved;
    });
    void current;
    this.invalidate();
    return this.row(row);
  }

  async reorder(ids: string[], actorUserId: string): Promise<void> {
    const db = this.db();
    const rows = await db.assistantKnowledge.findMany({ select: { id: true } });
    const known = new Set(rows.map((r) => r.id));
    const ordered = ids.filter((id) => known.has(id));
    if (!ordered.length) throw validationError({ ids: 'required' });
    await db.$transaction([
      ...ordered.map((id, i) => db.assistantKnowledge.update({ where: { id }, data: { position: i * POSITION_STEP, updatedById: actorUserId } })),
      db.auditLogEntry.create({ data: { actorUserId, action: 'ai.knowledge.reorder', targetType: 'assistant_knowledge', targetId: 'all' } }),
    ]);
    this.invalidate();
  }
}
