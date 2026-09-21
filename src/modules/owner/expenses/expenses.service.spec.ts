import { ExpensesService, monthlyDate, recurringDates } from './expenses.service';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';

const owner: AuthenticatedUser = { id: 'o1', phone: '', name: 'O', roles: ['owner'] };

describe('monthly recurrence', () => {
  it('keeps the day, clamps to short months', () => {
    expect(monthlyDate('2026-01-31', 1)).toBe('2026-02-28');
    expect(monthlyDate('2028-01-31', 1)).toBe('2028-02-29');
    expect(monthlyDate('2026-01-31', 2)).toBe('2026-03-31');
    expect(monthlyDate('2026-11-15', 3)).toBe('2027-02-15');
  });

  it('lists the copies after the template up to today, honouring "until"', () => {
    expect(recurringDates('2026-01-10', '2026-04-09')).toEqual(['2026-02-10', '2026-03-10']);
    expect(recurringDates('2026-01-10', '2026-06-30', '2026-03-05')).toEqual(['2026-02-10', '2026-03-10']);
    expect(recurringDates('2026-05-10', '2026-05-30')).toEqual([]);
  });
});

function build() {
  const rows: any[] = [];
  let n = 0;
  const prisma: any = {
    venue: {
      findUnique: jest.fn(async () => ({ id: 'v1', ownerId: 'o1', priceFromCurrency: 'EGP', country: { timezone: 'Africa/Cairo' } })),
    },
    venueExpense: {
      create: jest.fn(async ({ data }: any) => { const r = { id: `e${++n}`, recurringParentId: null, recurringUntil: null, categoryLabel: null, note: null, createdAt: new Date(), ...data }; rows.push(r); return r; }),
      findMany: jest.fn(async ({ where }: any) => rows.filter((r) => (!where.recurringMonthly || r.recurringMonthly) && (where.recurringParentId === undefined || r.recurringParentId === where.recurringParentId) && (!where.incurredOn?.lt || r.incurredOn < where.incurredOn.lt) && (!where.venueId || r.venueId === where.venueId))),
      createMany: jest.fn(async ({ data }: any) => {
        let count = 0;
        for (const d of data) if (!rows.some((r) => r.recurringParentId === d.recurringParentId && r.incurredOn === d.incurredOn)) { rows.push({ id: `e${++n}`, recurringMonthly: false, ...d }); count++; }
        return { count };
      }),
      groupBy: jest.fn(async ({ where }: any) => {
        const m = new Map<string, any>();
        for (const r of rows.filter((x) => x.venueId === where.venueId && x.incurredOn >= where.incurredOn.gte && x.incurredOn <= where.incurredOn.lte)) {
          const k = r.category; const cur = m.get(k) ?? { category: k, categoryLabel: r.categoryLabel ?? null, _sum: { amount: 0 }, _count: { _all: 0 } };
          cur._sum.amount += r.amount; cur._count._all++; m.set(k, cur);
        }
        return [...m.values()];
      }),
    },
  };
  return { svc: new ExpensesService(prisma), rows };
}

describe('ExpensesService', () => {
  it('generates each missing month once, however often it is read', async () => {
    const { svc, rows } = build();
    jest.useFakeTimers().setSystemTime(new Date('2026-04-20T10:00:00Z'));
    try {
      await svc.create(owner, { venueId: 'v1', category: 'rent', amount: 500000, incurredOn: '2026-01-15', recurringMonthly: true });
      expect(rows.map((r) => r.incurredOn).sort()).toEqual(['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15']);
      await svc.materialize('v1'); await svc.materialize('v1');
      expect(rows).toHaveLength(4);
    } finally { jest.useRealTimers(); }
  });

  it('totals per category for the range (the profit invariant: net = take-home − Σ expenses)', async () => {
    const { svc } = build();
    await svc.create(owner, { venueId: 'v1', category: 'electricity', amount: 30000, incurredOn: '2026-03-02' });
    await svc.create(owner, { venueId: 'v1', category: 'salaries', amount: 120000, incurredOn: '2026-03-28' });
    await svc.create(owner, { venueId: 'v1', category: 'other', categoryLabel: 'Nets', amount: 5000, incurredOn: '2026-04-02' });
    const t = await svc.totals('v1', '2026-03-01', '2026-03-31');
    expect(t.total).toBe(150000);
    expect(t.byCategory.map((c) => c.category)).toEqual(['salaries', 'electricity']);
    const takeHome = 400000;
    expect(takeHome - t.total).toBe(250000);
  });

  it('"other" needs a name', async () => {
    const { svc } = build();
    await expect(svc.create(owner, { venueId: 'v1', category: 'other', amount: 1, incurredOn: '2026-03-02' })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'CATEGORY_LABEL_REQUIRED' }),
    });
  });
});
