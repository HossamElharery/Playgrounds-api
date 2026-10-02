import { BadRequestException, ConflictException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { assertVenueAccess } from '../../../common/access/owner-access';
import { ApiException } from '../../../common/errors/api-exception';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';
import type { WeeklyHours } from '../../../common/utils/weekly-hours.util';
import { PrismaService } from '../../prisma/prisma.service';
import { OwnerBookingsService } from '../owner-bookings.service';
import { BOOKING_FIELDS, suggestMapping, type ColumnMapping } from './import-mapper.util';
import {
  DEFAULT_IMPORT_OPTIONS,
  normalizeBookingRow,
  normalizeCustomerRow,
  type ImportContext,
  type ImportIssue,
  type ImportOptions,
  type NormalizedBooking,
} from './import-rows.util';
import { MAX_IMPORT_ROWS, readSpreadsheet, SpreadsheetError } from './spreadsheet.util';

export type ImportKind = 'bookings' | 'customers';

export interface ImportConfig {
  venueId: string;
  kind: ImportKind;
  /** 1-based row of the headers; detected when absent. */
  headerRow?: number;
  mapping?: ColumnMapping;
  options: ImportOptions;
  /** 1-based sheet rows the owner un-ticked in the preview. */
  skipRows: number[];
}

export type RowStatus = 'ok' | 'warning' | 'error' | 'duplicate' | 'skipped';

export interface PreviewRow {
  /** 1-based row number in the sheet — what the owner sees in Excel. */
  row: number;
  status: RowStatus;
  issues: ImportIssue[];
  view?: {
    date?: string;
    time?: string;
    court?: string;
    durationMinutes?: number;
    price?: number;
    paid?: number;
    paymentStatus?: string;
    customer?: string | null;
    phone?: string | null;
  };
}

const KINDS: ImportKind[] = ['bookings', 'customers'];
const MAX_SHOWN_ROWS = 600;

/** Only what we understand survives; everything else about the request is ignored. */
export function sanitizeConfig(raw: unknown): ImportConfig {
  let obj: Record<string, unknown>;
  try {
    obj = typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown>);
  } catch {
    throw new BadRequestException('config must be valid JSON');
  }
  if (!obj || typeof obj !== 'object') throw new BadRequestException('config is required');
  const venueId = typeof obj.venueId === 'string' ? obj.venueId : '';
  if (!/^[0-9a-f-]{36}$/i.test(venueId)) throw new BadRequestException('venueId is required');
  const kind = KINDS.includes(obj.kind as ImportKind) ? (obj.kind as ImportKind) : 'bookings';

  let mapping: ColumnMapping | undefined;
  if (obj.mapping && typeof obj.mapping === 'object') {
    mapping = {};
    for (const f of BOOKING_FIELDS) {
      const v = (obj.mapping as Record<string, unknown>)[f];
      if (v === null || v === undefined) mapping[f] = null;
      else if (Number.isInteger(v) && (v as number) >= 0 && (v as number) < 60) mapping[f] = v as number;
    }
  }

  const o = (obj.options ?? {}) as Record<string, unknown>;
  const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
  const duration = Number(o.defaultDurationMinutes);
  const options: ImportOptions = {
    ...DEFAULT_IMPORT_OPTIONS,
    ambiguousHours: pick(o.ambiguousHours, ['am', 'pm', 'auto'], DEFAULT_IMPORT_OPTIONS.ambiguousHours),
    whenPaidMissing: pick(o.whenPaidMissing, ['paid', 'unpaid', 'auto'], DEFAULT_IMPORT_OPTIONS.whenPaidMissing),
    defaultMethod: pick(o.defaultMethod, ['cash', 'instapay', 'wallet', 'card'], DEFAULT_IMPORT_OPTIONS.defaultMethod),
    defaultCourtId: typeof o.defaultCourtId === 'string' && /^[0-9a-f-]{36}$/i.test(o.defaultCourtId) ? o.defaultCourtId : undefined,
    defaultDurationMinutes: Number.isInteger(duration) && duration >= 15 && duration <= 720 ? duration : undefined,
    defaultSourceLabel:
      typeof o.defaultSourceLabel === 'string' && o.defaultSourceLabel.trim()
        ? o.defaultSourceLabel.trim().slice(0, 60)
        : DEFAULT_IMPORT_OPTIONS.defaultSourceLabel,
  };
  const skipRows = Array.isArray(obj.skipRows) ? obj.skipRows.filter((n): n is number => Number.isInteger(n) && n > 0).slice(0, MAX_IMPORT_ROWS) : [];
  const headerRow = Number.isInteger(obj.headerRow) && (obj.headerRow as number) >= 1 && (obj.headerRow as number) <= 30 ? (obj.headerRow as number) : undefined;
  return { venueId, kind, headerRow, mapping, options, skipRows };
}

/** The first rows of an owner's sheet are often a title; the header row is the one that reads most like headers. */
export function detectHeaderRow(rows: string[][]): { index: number; matched: number } {
  let best = { index: 0, matched: -1 };
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const { matched } = suggestMapping(rows[i]);
    if (matched > best.matched) best = { index: i, matched };
  }
  return best;
}

@Injectable()
export class ImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bookings: OwnerBookingsService,
  ) {}

  /** Reads the file and tells the owner what would happen. Writes nothing. */
  async preview(user: AuthenticatedUser, file: { buffer: Buffer; originalname?: string } | undefined, rawConfig: unknown) {
    const run = await this.analyse(user, file, rawConfig);
    return {
      fileName: run.fileName,
      sheetName: run.sheetName,
      kind: run.config.kind,
      headerRow: run.headerRow,
      headers: run.headers,
      mapping: run.mapping,
      sample: run.sample,
      courts: run.courts,
      currency: run.currency,
      summary: run.summary,
      rows: run.rows.slice(0, MAX_SHOWN_ROWS),
      rowsShown: Math.min(run.rows.length, MAX_SHOWN_ROWS),
    };
  }

  /** Imports every row that is fine (or only has warnings). Rows with errors are left out and reported. */
  async commit(user: AuthenticatedUser, file: { buffer: Buffer; originalname?: string } | undefined, rawConfig: unknown) {
    const run = await this.analyse(user, file, rawConfig);
    const importable = run.rows.filter((r) => r.status === 'ok' || r.status === 'warning');
    if (!importable.length) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'NOTHING_TO_IMPORT', 'No row in this file can be imported');
    }
    const batch = await this.prisma.venueImportBatch.create({
      data: {
        venueId: run.config.venueId,
        createdById: user.id,
        fileName: file?.originalname?.slice(0, 120) ?? null,
        rowsTotal: run.rows.length,
      },
    });

    let created = 0;
    const failed: { row: number; code: string }[] = [];
    if (run.config.kind === 'customers') {
      for (const r of importable) {
        const c = run.customers.get(r.row)!;
        await this.prisma.venueCustomer.upsert({
          where: { venueId_key: { venueId: run.config.venueId, key: c.key } },
          create: { venueId: run.config.venueId, key: c.key, name: c.name, phone: c.phone, note: c.note, imported: true, importBatchId: batch.id, updatedById: user.id },
          update: {
            ...(c.name ? { name: c.name } : {}),
            ...(c.phone ? { phone: c.phone } : {}),
            ...(c.note ? { note: c.note } : {}),
          },
        });
        created += 1;
      }
    } else {
      const now = Date.now();
      for (const r of importable) {
        const b = run.bookingsByRow.get(r.row)!;
        try {
          await this.prisma.$transaction(
            (tx) =>
              this.bookings.insertManualBooking(tx, {
                userId: user.id,
                venueId: run.config.venueId,
                courtId: b.courtId,
                slotStart: b.startsAt,
                slotEnd: b.endsAt,
                priceAmount: b.priceAmount,
                paymentStatus: b.paymentStatus,
                paidAmount: b.paymentStatus === 'partial' ? b.paidAmount : undefined,
                paymentMethod: b.paymentMethod,
                customerName: b.customerName,
                customerPhone: b.customerPhone,
                sourceKey: b.sourceKey,
                sourceLabel: b.sourceLabel ?? null,
                notes: b.notes,
                // History is not anybody's open drawer, and its money dates from the game, not from today.
                paymentRecordedBy: null,
                paidAt: new Date(Math.min(b.startsAt.getTime(), now)),
                importBatchId: batch.id,
              }),
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          );
          created += 1;
        } catch (e) {
          const code = e instanceof ConflictException ? 'SLOT_TAKEN' : 'FAILED';
          failed.push({ row: r.row, code });
        }
      }
    }

    const skipped = run.rows.length - created;
    await this.prisma.venueImportBatch.update({
      where: { id: batch.id },
      data: {
        bookings: run.config.kind === 'bookings' ? created : 0,
        customers: run.config.kind === 'customers' ? created : 0,
        skipped,
      },
    });
    await this.prisma.auditLogEntry.create({
      data: {
        actorUserId: user.id,
        action: 'owner.import.committed',
        targetType: 'venue',
        targetId: run.config.venueId,
        metadata: { batchId: batch.id, kind: run.config.kind, created, skipped, fileName: file?.originalname ?? null } as Prisma.InputJsonValue,
      },
    });
    return { batchId: batch.id, created, skipped, failed, summary: run.summary };
  }

  async listBatches(user: AuthenticatedUser, venueId: string) {
    await assertVenueAccess(this.prisma, user, venueId, { write: false });
    const rows = await this.prisma.venueImportBatch.findMany({ where: { venueId }, orderBy: { createdAt: 'desc' }, take: 20 });
    const people = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.createdById))] } }, select: { id: true, name: true } });
    const names = new Map(people.map((p) => [p.id, p.name]));
    return rows.map((r) => ({
      id: r.id,
      fileName: r.fileName,
      bookings: r.bookings,
      customers: r.customers,
      skipped: r.skipped,
      createdAt: r.createdAt.toISOString(),
      undoneAt: r.undoneAt?.toISOString() ?? null,
      createdByName: names.get(r.createdById) ?? null,
    }));
  }

  /**
   * Takes a whole import back. Refused once somebody has taken money on one of its bookings
   * since — that money is in a drawer and must not vanish with the booking.
   */
  async undo(user: AuthenticatedUser, batchId: string) {
    const batch = await this.prisma.venueImportBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw new NotFoundException('Import not found');
    await assertVenueAccess(this.prisma, user, batch.venueId, { write: true });
    if (batch.undoneAt) throw new ApiException(HttpStatus.CONFLICT, 'ALREADY_UNDONE', 'This import was already undone');
    const touched = await this.prisma.payment.count({
      where: { booking: { importBatchId: batchId }, recordedByUserId: { not: null } },
    });
    if (touched > 0) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'IMPORT_TOUCHED',
        'Money was taken on some of these bookings after the import, so it cannot be undone as a whole',
      );
    }
    const [deleted] = await this.prisma.$transaction([
      this.prisma.booking.deleteMany({ where: { importBatchId: batchId } }),
      this.prisma.venueCustomer.deleteMany({ where: { importBatchId: batchId } }),
      this.prisma.venueImportBatch.update({ where: { id: batchId }, data: { undoneAt: new Date() } }),
    ]);
    await this.prisma.auditLogEntry.create({
      data: { actorUserId: user.id, action: 'owner.import.undone', targetType: 'venue', targetId: batch.venueId, metadata: { batchId, removed: deleted.count } as Prisma.InputJsonValue },
    });
    return { removed: deleted.count };
  }

  // ---- the shared analysis behind preview and commit ----------------------------------------

  private async analyse(user: AuthenticatedUser, file: { buffer: Buffer; originalname?: string } | undefined, rawConfig: unknown) {
    const config = sanitizeConfig(rawConfig);
    if (!file?.buffer?.length) throw new BadRequestException('Attach an Excel or CSV file');
    const venue = await assertVenueAccess(this.prisma, user, config.venueId, { write: true });

    let table;
    try {
      table = readSpreadsheet(new Uint8Array(file.buffer), file.originalname);
    } catch (e) {
      if (e instanceof SpreadsheetError) throw new ApiException(HttpStatus.BAD_REQUEST, `FILE_${e.code}`, e.message);
      throw e;
    }

    const detected = detectHeaderRow(table.rows);
    const headerIndex = config.headerRow ? config.headerRow - 1 : detected.index;
    const headers = table.rows[headerIndex] ?? [];
    const suggested = suggestMapping(headers);
    // No recognisable header at all: treat the first row as data, columns by position.
    const headerless = detected.matched <= 0 && !config.headerRow;
    const dataStart = headerless ? 0 : headerIndex + 1;
    const mapping: ColumnMapping = config.mapping ?? suggested.mapping;

    const dbVenue = await this.prisma.venue.findUnique({ where: { id: venue.id }, select: { country: { select: { timezone: true } } } });
    const courts = await this.prisma.court.findMany({
      where: { venueId: venue.id },
      select: { id: true, name: true, slotDurationMins: true, pricingRules: true },
      orderBy: { name: 'asc' },
    });
    const ctx: ImportContext = {
      timeZone: dbVenue?.country?.timezone ?? 'Africa/Cairo',
      now: new Date(),
      courts: courts.map((c) => ({ id: c.id, name: c.name, slotDurationMins: c.slotDurationMins, pricingRules: c.pricingRules })),
      weeklyHours: venue.weeklyHours as WeeklyHours | null,
      headers,
      options: config.options,
    };

    const skip = new Set(config.skipRows);
    const rows: PreviewRow[] = [];
    const bookingsByRow = new Map<number, NormalizedBooking>();
    const customers = new Map<number, { name: string | null; phone: string | null; note: string | null; key: string }>();

    for (let i = dataStart; i < table.rows.length && rows.length < MAX_IMPORT_ROWS; i++) {
      const sheetRow = i + 1;
      const cells = table.rows[i];
      if (skip.has(sheetRow)) {
        rows.push({ row: sheetRow, status: 'skipped', issues: [] });
        continue;
      }
      if (config.kind === 'customers') {
        const out = normalizeCustomerRow(cells, mapping);
        if (out.customer) customers.set(sheetRow, out.customer);
        rows.push({
          row: sheetRow,
          status: out.issues.some((x) => x.level === 'error') ? 'error' : out.issues.length ? 'warning' : 'ok',
          issues: out.issues,
          view: out.customer ? { customer: out.customer.name, phone: out.customer.phone } : undefined,
        });
        continue;
      }
      const out = normalizeBookingRow(cells, mapping, ctx);
      const status: RowStatus = out.issues.some((x) => x.level === 'error') ? 'error' : out.issues.length ? 'warning' : 'ok';
      if (out.booking) bookingsByRow.set(sheetRow, out.booking);
      const b = out.booking;
      rows.push({
        row: sheetRow,
        status,
        issues: out.issues,
        view: b
          ? { date: b.date, time: b.time, court: b.courtName, durationMinutes: b.durationMinutes, price: b.priceAmount, paid: b.paidAmount, paymentStatus: b.paymentStatus, customer: b.customerName, phone: b.customerPhone }
          : undefined,
      });
    }

    if (config.kind === 'bookings') await this.markConflicts(venue.id, rows, bookingsByRow);

    const counted = (s: RowStatus) => rows.filter((r) => r.status === s).length;
    const good = rows.filter((r) => r.status === 'ok' || r.status === 'warning');
    const dates = good.map((r) => r.view?.date).filter((d): d is string => !!d).sort();
    const summary = {
      total: rows.length,
      ok: counted('ok'),
      warnings: counted('warning'),
      errors: counted('error'),
      duplicates: counted('duplicate'),
      skipped: counted('skipped'),
      importable: good.length,
      price: good.reduce((s, r) => s + (r.view?.price ?? 0), 0),
      paid: good.reduce((s, r) => s + (r.view?.paid ?? 0), 0),
      dateFrom: dates[0] ?? null,
      dateTo: dates[dates.length - 1] ?? null,
      truncated: table.rows.length - dataStart > MAX_IMPORT_ROWS,
    };

    return {
      config,
      fileName: file.originalname ?? null,
      sheetName: table.sheetName,
      headerRow: headerless ? 0 : headerIndex + 1,
      headers,
      mapping,
      sample: table.rows.slice(dataStart, dataStart + 4),
      courts: courts.map((c) => ({ id: c.id, name: c.name })),
      currency: venue.currency,
      summary,
      rows,
      bookingsByRow,
      customers,
    };
  }

  /**
   * Rows that collide with each other or with what the venue already has. The exact same booking
   * (same court, start and customer) is a harmless duplicate from an earlier import; anything
   * else that overlaps is a real conflict the owner must resolve.
   */
  private async markConflicts(venueId: string, rows: PreviewRow[], byRow: Map<number, NormalizedBooking>) {
    const live = rows.filter((r) => byRow.has(r.row) && r.status !== 'error' && r.status !== 'skipped');
    if (!live.length) return;
    const times = live.map((r) => byRow.get(r.row)!);
    const min = new Date(Math.min(...times.map((t) => t.startsAt.getTime())));
    const max = new Date(Math.max(...times.map((t) => t.endsAt.getTime())));
    const [existing, blocks] = await Promise.all([
      this.prisma.booking.findMany({
        where: { venueId, status: { in: ['held', 'confirmed'] }, slotStart: { lt: max }, slotEnd: { gt: min } },
        select: { courtId: true, slotStart: true, slotEnd: true, guestPhone: true, guestName: true },
      }),
      this.prisma.calendarBlock.findMany({
        where: { venueId, startsAt: { lt: max }, endsAt: { gt: min } },
        select: { courtId: true, startsAt: true, endsAt: true },
      }),
    ]);
    const overlaps = (a: { startsAt: Date; endsAt: Date }, b: { startsAt: Date; endsAt: Date }) => a.startsAt < b.endsAt && a.endsAt > b.startsAt;
    const accepted: { courtId: string; startsAt: Date; endsAt: Date; row: number }[] = [];

    for (const r of live) {
      const b = byRow.get(r.row)!;
      const dup = existing.find(
        (e) =>
          e.courtId === b.courtId &&
          e.slotStart.getTime() === b.startsAt.getTime() &&
          e.slotEnd.getTime() === b.endsAt.getTime() &&
          ((b.customerPhone && e.guestPhone === b.customerPhone) || (!b.customerPhone && (e.guestName ?? '') === (b.customerName ?? ''))),
      );
      if (dup) {
        r.status = 'duplicate';
        r.issues.push({ code: 'DUPLICATE', level: 'warning' });
        continue;
      }
      if (existing.some((e) => e.courtId === b.courtId && overlaps({ startsAt: e.slotStart, endsAt: e.slotEnd }, b))) {
        r.status = 'error';
        r.issues.push({ code: 'OVERLAP_EXISTING', level: 'error' });
        continue;
      }
      if (blocks.some((k) => (k.courtId == null || k.courtId === b.courtId) && overlaps(k, b))) {
        r.status = 'error';
        r.issues.push({ code: 'SLOT_BLOCKED', level: 'error' });
        continue;
      }
      const clash = accepted.find((a) => a.courtId === b.courtId && overlaps(a, b));
      if (clash) {
        r.status = 'error';
        r.issues.push({ code: 'OVERLAP_FILE', level: 'error', detail: String(clash.row) });
        continue;
      }
      accepted.push({ courtId: b.courtId, startsAt: b.startsAt, endsAt: b.endsAt, row: r.row });
    }
  }
}

