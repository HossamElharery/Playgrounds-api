import { BadRequestException, HttpStatus } from '@nestjs/common';
import { ApiException } from '../errors/api-exception';
import { zonedDayBounds } from './timezone.util';

export type OwnerRangeKey =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_7_days'
  | 'this_month'
  | 'last_month'
  | 'custom';

export interface ResolvedOwnerRange {
  from: string;
  to: string;
  start: Date;
  end: Date;
  timezone: string;
  range: OwnerRangeKey;
}

function zonedYmd(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

export function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return next.toISOString().slice(0, 10);
}

export function eachYmd(from: string, to: string): string[] {
  const out: string[] = [];
  let cursor = from;
  while (cursor <= to) {
    out.push(cursor);
    cursor = addDaysYmd(cursor, 1);
  }
  return out;
}

/** Egypt week starts Saturday. JS: 0=Sun … 6=Sat. Days since last Saturday. */
function daysSinceSaturday(jsWeekday: number): number {
  return (jsWeekday + 1) % 7;
}

export function resolveOwnerRange(
  range: OwnerRangeKey | string,
  timeZone: string,
  from?: string,
  to?: string,
  now = new Date(),
): ResolvedOwnerRange {
  const today = zonedYmd(now, timeZone);
  let startYmd = today;
  let endYmd = today;

  switch (range) {
    case 'today':
      break;
    case 'yesterday':
      startYmd = addDaysYmd(today, -1);
      endYmd = startYmd;
      break;
    case 'last_7_days':
      startYmd = addDaysYmd(today, -6);
      break;
    case 'this_week': {
      const { dayOfWeek } = zonedDayBounds(today, timeZone);
      startYmd = addDaysYmd(today, -daysSinceSaturday(dayOfWeek));
      endYmd = addDaysYmd(startYmd, 6);
      break;
    }
    case 'this_month':
      startYmd = `${today.slice(0, 7)}-01`;
      break;
    case 'last_month': {
      const [y, m] = today.split('-').map(Number);
      const lastMonth = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
      startYmd = `${lastMonth}-01`;
      const thisMonthStart = `${today.slice(0, 7)}-01`;
      endYmd = addDaysYmd(thisMonthStart, -1);
      break;
    }
    case 'custom': {
      if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        throw new BadRequestException('from and to (YYYY-MM-DD) are required for custom range');
      }
      startYmd = from;
      endYmd = to;
      break;
    }
    default:
      throw new BadRequestException('Invalid range');
  }

  if (endYmd < startYmd) {
    throw new BadRequestException('to must be on or after from');
  }
  const start = zonedDayBounds(startYmd, timeZone).start;
  const end = zonedDayBounds(endYmd, timeZone).end;
  if (end.getTime() - start.getTime() > 366 * 86_400_000) {
    throw new ApiException(HttpStatus.BAD_REQUEST, 'RANGE_TOO_LARGE', 'Range cannot exceed 366 days');
  }
  return { from: startYmd, to: endYmd, start, end, timezone: timeZone, range: range as OwnerRangeKey };
}
