import { BadRequestException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, VenueExpense } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { assertVenueAccess } from '../../../common/access/owner-access';
import { ApiException } from '../../../common/errors/api-exception';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';
import { addDays, isLocalDate, zonedDate } from '../../../common/utils/fixed-series.util';
import { CreateExpenseDto, UpdateExpenseDto } from './expenses.dto';

/** `2026-03-31` + 1 month → `2026-04-30`: the day is kept when the month has it, else clamped. */
export function monthlyDate(anchor: string, monthOffset: number): string {
  const [y, m, d] = anchor.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + monthOffset, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return `${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/**
 * Every date a monthly template should have a copy on, after its own date and up to
 * `today` (and its `until` month). Pure, so the calendar rules are easy to test.
 */
export function recurringDates(anchor: string, today: string, until?: string | null): string[] {
  const out: string[] = [];
  for (let i = 1; i < 240; i++) {
    const date = monthlyDate(anchor, i);
    if (date > today) break;
    if (until && date.slice(0, 7) > until.slice(0, 7)) break;
    out.push(date);
  }
  return out;
}

@Injectable()
export class ExpensesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthenticatedUser, q: { venueId: string; from?: string; to?: string; category?: string }) {
    await assertVenueAccess(this.prisma, user, q.venueId, { write: false });
    await this.materialize(q.venueId);
    const rows = await this.prisma.venueExpense.findMany({
      where: {
        venueId: q.venueId,
        ...(q.category ? { category: q.category } : {}),
        ...(q.from || q.to ? { incurredOn: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
      },
      orderBy: [{ incurredOn: 'desc' }, { createdAt: 'desc' }],
      take: 500,
    });
    return rows.map((r) => this.dto(r));
  }

  async create(user: AuthenticatedUser, dto: CreateExpenseDto) {
    const venue = await assertVenueAccess(this.prisma, user, dto.venueId, { write: true });
    this.validate(dto.category, dto.categoryLabel, dto.incurredOn, dto.recurringUntil);
    const row = await this.prisma.venueExpense.create({
      data: {
        venueId: dto.venueId,
        category: dto.category,
        categoryLabel: dto.category === 'other' ? dto.categoryLabel!.trim() : null,
        amount: dto.amount,
        currency: venue.priceFromCurrency ?? 'EGP',
        incurredOn: dto.incurredOn,
        note: dto.note?.trim() || null,
        recurringMonthly: !!dto.recurringMonthly,
        recurringUntil: dto.recurringMonthly ? (dto.recurringUntil ?? null) : null,
        createdById: user.id,
      },
    });
    if (row.recurringMonthly) await this.materialize(row.venueId);
    return this.dto(row);
  }

  async update(user: AuthenticatedUser, id: string, dto: UpdateExpenseDto) {
    const row = await this.load(user, id);
    const category = dto.category ?? (row.category as CreateExpenseDto['category']);
    const label = dto.categoryLabel ?? row.categoryLabel ?? undefined;
    this.validate(category, label, dto.incurredOn ?? row.incurredOn, dto.recurringUntil);
    const updated = await this.prisma.venueExpense.update({
      where: { id },
      data: {
        category,
        categoryLabel: category === 'other' ? label!.trim() : null,
        ...(dto.amount != null ? { amount: dto.amount } : {}),
        ...(dto.incurredOn ? { incurredOn: dto.incurredOn } : {}),
        ...(dto.note !== undefined ? { note: dto.note.trim() || null } : {}),
        // Only a template can repeat; a monthly copy is edited on its own.
        ...(row.recurringParentId == null && dto.recurringMonthly != null ? { recurringMonthly: dto.recurringMonthly } : {}),
        ...(dto.recurringUntil !== undefined ? { recurringUntil: dto.recurringUntil } : {}),
      },
    });
    return this.dto(updated);
  }

  async remove(user: AuthenticatedUser, id: string) {
    await this.load(user, id);
    await this.prisma.venueExpense.delete({ where: { id } });
    return { ok: true };
  }

  /** Totals for a local-date range (inclusive) — shared with the profit summary and the exports. */
  async totals(venueId: string, from: string, to: string) {
    await this.materialize(venueId);
    const rows = await this.prisma.venueExpense.groupBy({
      by: ['category', 'categoryLabel'],
      where: { venueId, incurredOn: { gte: from, lte: to } },
      _sum: { amount: true },
      _count: { _all: true },
    });
    const byCategory = rows
      .map((r) => ({ category: r.category, label: r.categoryLabel, amount: r._sum.amount ?? 0, count: r._count._all }))
      .sort((a, b) => b.amount - a.amount);
    return { total: byCategory.reduce((s, r) => s + r.amount, 0), byCategory };
  }

  /** Creates the missing monthly copies of every template of a venue (idempotent, race-safe). */
  async materialize(venueId: string): Promise<number> {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: { country: { select: { timezone: true } } },
    });
    const today = zonedDate(new Date(), venue?.country?.timezone ?? 'Africa/Cairo');
    const templates = await this.prisma.venueExpense.findMany({
      where: { venueId, recurringMonthly: true, recurringParentId: null, incurredOn: { lt: today } },
    });
    let created = 0;
    for (const t of templates) {
      const data: Prisma.VenueExpenseCreateManyInput[] = recurringDates(t.incurredOn, today, t.recurringUntil).map((date) => ({
        venueId,
        category: t.category,
        categoryLabel: t.categoryLabel,
        amount: t.amount,
        currency: t.currency,
        incurredOn: date,
        note: t.note,
        recurringParentId: t.id,
        createdById: t.createdById,
      }));
      if (!data.length) continue;
      created += (await this.prisma.venueExpense.createMany({ data, skipDuplicates: true })).count;
    }
    return created;
  }

  private validate(category: string, label: string | undefined, incurredOn: string, until?: string) {
    if (!isLocalDate(incurredOn)) throw new BadRequestException('incurredOn must be a valid date');
    if (until && !isLocalDate(until)) throw new BadRequestException('recurringUntil must be a valid date');
    if (category === 'other' && !label?.trim()) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'CATEGORY_LABEL_REQUIRED', 'Name the expense when the category is "other"');
    }
    if (incurredOn > addDays(zonedDate(new Date(), 'UTC'), 366)) {
      throw new BadRequestException('incurredOn is too far in the future');
    }
  }

  private async load(user: AuthenticatedUser, id: string): Promise<VenueExpense> {
    const row = await this.prisma.venueExpense.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Expense not found');
    await assertVenueAccess(this.prisma, user, row.venueId, { write: true });
    return row;
  }

  private dto(r: VenueExpense) {
    return {
      id: r.id,
      venueId: r.venueId,
      category: r.category,
      categoryLabel: r.categoryLabel,
      amount: r.amount,
      currency: r.currency,
      incurredOn: r.incurredOn,
      note: r.note,
      recurringMonthly: r.recurringMonthly,
      recurringUntil: r.recurringUntil,
      isMonthlyCopy: r.recurringParentId != null,
    };
  }
}
