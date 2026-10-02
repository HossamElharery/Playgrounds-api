import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type AiAskerKind, type AiFeedback, type AiQuestionOutcome, type AiQuestionStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AssistantKnowledgeService } from '../knowledge/assistant-knowledge.service';
import { CaptainNluService } from '../../search/captain/captain-nlu.service';
import { buildPagination } from '../../../common/dto/page-query.dto';
import { dayDate, fromMicros, utcDayString, addDays } from '../ai-day';
import { clusterQuestions } from './question-clusters';
import { AiAdminKnowledgeService, type PreviewResult } from './ai-admin-knowledge.service';

export interface QuestionFilters {
  outcome?: AiQuestionOutcome;
  lang?: 'ar' | 'en';
  userKind?: AiAskerKind;
  status?: AiQuestionStatus;
  feedback?: AiFeedback;
  q?: string;
  from?: string;
  to?: string;
  page: number;
  perPage: number;
}

const INBOX_DAYS = 30;
const INBOX_MAX_ROWS = 600;
const VERIFY_SAMPLES = 3;
const BULK_MAX = 200;

type Row = Prisma.AiQuestionLogGetPayload<object>;

function present(r: Row) {
  return {
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    surface: r.surface,
    userKind: r.userKind,
    text: r.textRedacted,
    lang: r.lang,
    intent: r.intent,
    outcome: r.outcome,
    detail: r.detail,
    factIds: r.factIds,
    reading: r.reading,
    model: r.model,
    ms: r.ms,
    costUsd: Number(fromMicros(r.costMicros).toFixed(6)),
    feedback: r.feedback,
    status: r.status,
    resolvedNote: r.resolvedNote,
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    resolvedKnowledgeId: r.resolvedKnowledgeId,
    verifiedOk: r.verifiedOk,
  };
}

/** What players asked Captain, as the admin works through it. */
@Injectable()
export class AiAdminQuestionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly knowledge: AssistantKnowledgeService,
    private readonly nlu: CaptainNluService,
    private readonly tools: AiAdminKnowledgeService,
  ) {}

  async list(f: QuestionFilters) {
    const where: Prisma.AiQuestionLogWhereInput = {
      ...(f.outcome ? { outcome: f.outcome } : {}),
      ...(f.lang ? { lang: f.lang } : {}),
      ...(f.userKind ? { userKind: f.userKind } : {}),
      ...(f.status ? { status: f.status } : {}),
      ...(f.feedback ? { feedback: f.feedback } : {}),
      ...(f.q ? { textRedacted: { contains: f.q.slice(0, 80), mode: 'insensitive' as const } } : {}),
      ...((f.from || f.to)
        ? {
            createdAt: {
              ...(f.from ? { gte: new Date(f.from) } : {}),
              ...(f.to ? { lt: new Date(new Date(f.to).getTime() + 86_400_000) } : {}),
            },
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.aiQuestionLog.count({ where }),
      this.prisma.aiQuestionLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (f.page - 1) * f.perPage, take: f.perPage }),
    ]);
    return { items: rows.map(present), pagination: buildPagination(f.page, f.perPage, total) };
  }

  /** The worklist: questions Captain could not answer or players marked 👎, grouped by similarity, biggest first. */
  async inbox() {
    const since = new Date(Date.now() - INBOX_DAYS * 86_400_000);
    const open: Prisma.AiQuestionLogWhereInput = {
      createdAt: { gte: since },
      status: { in: ['new', 'reviewed'] },
      OR: [{ outcome: 'unanswered' }, { feedback: 'down' }],
    };
    const [rows, unansweredNew, downNew, resolvedWeek] = await Promise.all([
      this.prisma.aiQuestionLog.findMany({ where: open, orderBy: { createdAt: 'desc' }, take: INBOX_MAX_ROWS }),
      this.prisma.aiQuestionLog.count({ where: { ...open, OR: [{ outcome: 'unanswered' }] } }),
      this.prisma.aiQuestionLog.count({ where: { ...open, OR: [{ feedback: 'down' }] } }),
      this.prisma.aiQuestionLog.count({ where: { status: 'resolved', resolvedAt: { gte: new Date(Date.now() - 7 * 86_400_000) } } }),
    ]);
    const clusters = clusterQuestions(rows.map((r) => ({ id: r.id, text: r.textRedacted, createdAt: r.createdAt, row: r })));
    return {
      counts: { unanswered: unansweredNew, down: downNew, resolvedWeek },
      clusters: clusters.map((c) => ({
        sample: present(c.sample.row),
        size: c.items.length,
        unanswered: c.items.filter((i) => i.row.outcome === 'unanswered').length,
        down: c.items.filter((i) => i.row.feedback === 'down').length,
        firstAt: c.items[c.items.length - 1].createdAt.toISOString(),
        lastAt: c.items[0].createdAt.toISOString(),
        items: c.items.slice(0, 30).map((i) => ({ id: i.id, text: i.text, createdAt: i.createdAt.toISOString(), outcome: i.row.outcome, feedback: i.row.feedback, lang: i.row.lang })),
        ids: c.items.map((i) => i.id),
      })),
    };
  }

  async getOne(id: string) {
    const row = await this.prisma.aiQuestionLog.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('question not found');
    return present(row);
  }

  /** "Reviewed", "ignore", or back to new — for one question or a whole cluster. */
  async setStatus(ids: string[], status: AiQuestionStatus, note: string | undefined, actorUserId: string) {
    const unique = [...new Set(ids)].slice(0, BULK_MAX);
    if (!unique.length) throw new BadRequestException('ids required');
    const resolved = status === 'resolved';
    const res = await this.prisma.aiQuestionLog.updateMany({
      where: { id: { in: unique } },
      data: {
        status,
        resolvedNote: note ? note.slice(0, 500) : null,
        resolvedAt: resolved ? new Date() : null,
        resolvedById: resolved ? actorUserId : null,
      },
    });
    return { updated: res.count };
  }

  /**
   * Marks questions resolved and, when an entry answers them, asks the real
   * question again to prove the entry is now chosen. A failed test leaves the
   * question resolved (the entry exists) but says so, so the admin can fix the topic.
   */
  async resolve(id: string, body: { knowledgeId?: string; note?: string; ids?: string[]; verify?: boolean }, actorUserId: string) {
    const ids = [...new Set([id, ...(body.ids ?? [])])].slice(0, BULK_MAX);
    const rows = await this.prisma.aiQuestionLog.findMany({ where: { id: { in: ids } } });
    if (!rows.length) throw new NotFoundException('question not found');
    await this.prisma.aiQuestionLog.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: {
        status: 'resolved',
        resolvedAt: new Date(),
        resolvedById: actorUserId,
        resolvedNote: body.note ? body.note.slice(0, 500) : null,
        resolvedKnowledgeId: body.knowledgeId ?? null,
      },
    });
    await this.prisma.auditLogEntry.create({
      data: { actorUserId, action: 'ai.question.resolve', targetType: 'ai_question', targetId: id, metadata: { count: rows.length, knowledgeId: body.knowledgeId ?? null } as Prisma.InputJsonValue },
    });

    let verification: Awaited<ReturnType<AiAdminQuestionsService['verify']>> | null = null;
    if (body.knowledgeId && body.verify !== false) {
      this.knowledge.invalidate();
      const distinct = [...new Map(rows.map((r) => [r.textRedacted, r])).values()].slice(0, VERIFY_SAMPLES);
      verification = await this.verify(body.knowledgeId, distinct.map((r) => ({ text: r.textRedacted, lang: (r.lang as 'ar' | 'en' | null) ?? undefined, player: r.userKind === 'player' })));
      await this.prisma.aiQuestionLog.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { verifiedOk: verification.ok } });
    }
    return { resolved: rows.length, verification };
  }

  /** Asks each sample again against the live knowledge: did Captain choose `knowledgeId`? */
  async verify(knowledgeId: string, samples: { text: string; lang?: 'ar' | 'en'; player: boolean }[]) {
    const entries = await this.knowledge.forPlayers();
    const results: { text: string; ok: boolean; intent: string | null; factIds: string[] }[] = [];
    let modelAnswered = false;
    for (const s of samples) {
      const reading = await this.nlu.read({
        text: s.text,
        lang: s.lang ?? (/[؀-ۿ]/.test(s.text) ? 'ar' : 'en'),
        loggedIn: s.player,
        hasCoords: false,
        history: [],
        context: null,
        knowledge: entries,
        skipBudget: true,
      });
      if (reading) modelAnswered = true;
      results.push({ text: s.text, ok: !!reading?.factIds.includes(knowledgeId), intent: reading?.intent ?? null, factIds: reading?.factIds ?? [] });
    }
    return { ok: results.length > 0 && results.every((r) => r.ok), passed: results.filter((r) => r.ok).length, total: results.length, modelAnswered, results };
  }

  /** Re-asks one logged question against the live knowledge, to see what Captain would do with it today. */
  async retest(id: string): Promise<PreviewResult> {
    const row = await this.prisma.aiQuestionLog.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('question not found');
    return this.tools.preview({ text: row.textRedacted, lang: (row.lang as 'ar' | 'en' | null) ?? undefined, loggedIn: row.userKind === 'player' });
  }

  /** Numbers for the page header. */
  async counts() {
    const today = dayDate(utcDayString());
    const week = dayDate(addDays(utcDayString(), -6));
    const [today_, week_] = await Promise.all([
      this.prisma.aiQuestionLog.count({ where: { createdAt: { gte: today } } }),
      this.prisma.aiQuestionLog.count({ where: { createdAt: { gte: week } } }),
    ]);
    return { today: today_, week: week_ };
  }
}
