import { ExportService, MAX_EXPORT_DAYS } from './export.service';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';

const owner: AuthenticatedUser = { id: 'o1', phone: '', name: 'O', roles: ['owner'] };
const stranger: AuthenticatedUser = { id: 'o2', phone: '', name: 'X', roles: ['owner'] };
const staff: AuthenticatedUser = { id: 's1', phone: '', name: 'S', roles: ['staff'] };

const totals = {
  bookings: 3,
  collectedRevenue: 100000,
  matchenaRevenue: 60000,
  ownRevenue: 40000,
  commission: 6000,
  takeHome: 94000,
  expenses: 20000,
  retainedFromCancelled: 5000,
  netProfit: 79000,
  outstanding: 5000,
  expected: 0,
  cashCollected: 40000,
  onlineCollected: 60000,
};

function build(perms: string[] = []) {
  const prisma: any = {
    venue: { findUnique: jest.fn(async () => ({ id: 'v1', ownerId: 'o1', currency: 'EGP' })) },
    staffMember: {
      findUnique: jest.fn(async () => ({ id: 'st', ownerId: 'o1', permissions: perms, venueIds: ['v1'], title: null })),
    },
    booking: { findMany: jest.fn(async () => []) },
    payment: { findMany: jest.fn(async () => []) },
    user: { findMany: jest.fn(async () => []) },
    cashShift: { findMany: jest.fn(async () => []) },
    venueExpense: { findMany: jest.fn(async () => []) },
    pricingDiscount: { findMany: jest.fn(async () => []) },
    auditLogEntry: { create: jest.fn(async () => ({})) },
  };
  const summary: any = {
    getSummary: jest.fn(async () => ({
      range: { from: '2026-03-01', to: '2026-03-31', timezone: 'Africa/Cairo', key: 'custom' },
      currency: 'EGP',
      totals,
      cashbook: { received: 70000, forPeriod: 40000, advance: 25000, late: 5000, fromCancelled: 0, refunds: 0, byMethod: [] },
      byDay: [{ date: '2026-03-01', bookings: 1, revenue: 100000 }],
      byUnit: [],
      bySource: [],
      topCustomers: [],
    })),
  };
  const ledger: any = { getBalance: jest.fn(async () => 1234), listEntries: jest.fn(async () => ({ items: [] })) };
  return { svc: new ExportService(prisma, summary, {} as any, ledger), prisma };
}

describe('ExportService', () => {
  it('the Summary sheet is exactly the on-screen summary (the numbers cannot disagree)', async () => {
    const { svc } = build();
    const sheets = await svc.sheets(owner, 'v1', '2026-03-01', '2026-03-31', 'en');
    const rows = Object.fromEntries(sheets[0].rows.map(([k, v]) => [k, v]));
    const NET = 'Net profit (games + kept deposits − commission − expenses)';
    expect(rows['Games revenue (games played in the period)']).toBe(1000);
    expect(rows['Matchena commission']).toBe(60);
    expect(rows['Take-home after commission']).toBe(940);
    expect(rows['Kept from cancelled bookings (deposits)']).toBe(50);
    expect(rows['Expenses']).toBe(200);
    // Profit says out loud what it is made of: games earned + deposits kept − commission − expenses.
    expect(rows[NET]).toBe(790);
    expect(rows[NET]).toBe(
      (rows['Take-home after commission'] as number) +
        (rows['Kept from cancelled bookings (deposits)'] as number) -
        (rows['Expenses'] as number),
    );
    // The two bases are both on the sheet, and the received money splits into exactly its parts.
    expect(rows['Money received (by day received)']).toBe(700);
    expect(
      (rows['of which: for games in the period'] as number) +
        (rows['of which: advance for later games'] as number) +
        (rows['of which: collected for earlier games'] as number) +
        (rows['of which: kept from cancelled bookings'] as number),
    ).toBe(700);
    expect(sheets.map((s) => s.name)).toEqual([
      'Summary', 'Bookings', 'Money received', 'Daily', 'By court', 'By source', 'Top customers', 'Expenses', 'Matchena account', 'Discounts',
    ]);
  });

  it('follows the UI language for headers', async () => {
    const { svc } = build();
    const sheets = await svc.sheets(owner, 'v1', '2026-03-01', '2026-03-31', 'ar');
    expect(sheets[0].name).toBe('ملخص');
  });

  it('leaves the account sheet out for staff without account.view', async () => {
    const { svc } = build(['reports.view']);
    const names = (await svc.sheets(staff, 'v1', '2026-03-01', '2026-03-31', 'en')).map((s) => s.name);
    expect(names).not.toContain('Matchena account');
  });

  it('refuses a stranger, a reversed range and a period longer than a year; audits a real export', async () => {
    const { svc, prisma } = build();
    await expect(svc.build(stranger, { venueId: 'v1', from: '2026-03-01', to: '2026-03-31' })).rejects.toBeDefined();
    await expect(svc.build(owner, { venueId: 'v1', from: '2026-03-31', to: '2026-03-01' })).rejects.toBeDefined();
    await expect(svc.build(owner, { venueId: 'v1', from: '2025-01-01', to: '2026-12-31' })).rejects.toBeDefined();
    expect(MAX_EXPORT_DAYS).toBe(366);
    const out = await svc.build(owner, { venueId: 'v1', from: '2026-03-01', to: '2026-03-31', format: 'xlsx', lang: 'en' });
    expect(out.filename).toBe('matchena-2026-03-01_2026-03-31.xlsx');
    expect(prisma.auditLogEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'report.exported' }) }),
    );
  });
});
