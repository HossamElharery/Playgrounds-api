/**
 * The permission catalogue for venue staff. This is the single source of truth:
 * the API enforces it (AuthGuard + `@RequirePermission`), the team screen renders
 * its checkboxes from `GET /team/catalog`, and the owner dashboard hides what a
 * person cannot use. Owners and admins hold every key implicitly.
 */
export const PERMISSION_KEYS = [
  'bookings.view',
  'bookings.create',
  'bookings.edit',
  'bookings.checkin',
  'payments.record',
  'schedule.manage',
  'customers.view',
  'reports.view',
  'expenses.manage',
  'shifts.review',
  'account.view',
  'account.remit',
  'venue.manage',
  'pricing.manage',
  'promotions.manage',
  'tournaments.manage',
  'reviews.reply',
  'team.manage',
  'discounts.apply',
  'refunds.issue',
  'sessions.start',
  'sessions.end',
  'sessions.transfer',
  'sessions.correct',
  'products.view',
  'products.manage',
  'orders.manage',
  'receipts.print',
  'printer.manage',
  'layout.view',
  'layout.edit',
  'layout.publish',
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export interface PermissionDef {
  key: PermissionKey;
  group: 'schedule' | 'gaming' | 'commerce' | 'money' | 'venue' | 'growth' | 'team';
  labelAr: string;
  labelEn: string;
  hintAr: string;
  hintEn: string;
  /** Turning this on only makes sense together with these. */
  requires?: PermissionKey[];
}

export const PERMISSION_CATALOG: PermissionDef[] = [
  { key: 'discounts.apply', group: 'commerce', labelAr: 'خصم الحساب', labelEn: 'Discount bills', hintAr: 'تسجيل خصم بسبب موثق.', hintEn: 'Apply a discount with an audited reason.', requires: ['orders.manage','payments.record'] },
  { key: 'refunds.issue', group: 'commerce', labelAr: 'استرداد مدفوعات الحساب', labelEn: 'Refund bill payments', hintAr: 'رد دفعة دون حذف أصلها.', hintEn: 'Return payments without deleting originals.', requires: ['payments.record'] },
  { key: 'printer.manage', group: 'commerce', labelAr: 'إعداد الطباعة', labelEn: 'Manage printing', hintAr: 'إعداد الطباعة حسب نطاق المنشأة.', hintEn: 'Manage printing within assigned venues.', requires: ['receipts.print'] },
  { key: 'receipts.print', group: 'commerce', labelAr: 'عرض وطباعة الإيصالات', labelEn: 'View and print receipts', hintAr: 'عرض وطباعة الإيصالات حسب نطاق المنشأة.', hintEn: 'View and print receipts within assigned venues.', requires: ['payments.record'] },
  { key: 'orders.manage', group: 'commerce', labelAr: 'إدارة الحسابات', labelEn: 'Manage bills', hintAr: 'إدارة الحسابات حسب نطاق المنشأة.', hintEn: 'Manage bills within assigned venues.', requires: ['bookings.view', 'payments.record'] },
  { key: 'products.manage', group: 'commerce', labelAr: 'إدارة المنتجات والمخزون', labelEn: 'Manage products and stock', hintAr: 'إدارة المنتجات والمخزون حسب نطاق المنشأة.', hintEn: 'Manage products and stock within assigned venues.', requires: ['products.view'] },
  { key: 'products.view', group: 'commerce', labelAr: 'عرض المنتجات', labelEn: 'View products', hintAr: 'عرض المنتجات حسب نطاق المنشأة.', hintEn: 'View products within assigned venues.', requires: ['bookings.view'] },
  { key: 'sessions.correct', group: 'gaming', labelAr: 'تصحيح وإلغاء الجلسة', labelEn: 'Correct and void sessions', hintAr: 'تصحيح وإلغاء الجلسة حسب نطاق المنشأة.', hintEn: 'Correct and void sessions within assigned venues.', requires: ['sessions.end'] },
  { key: 'sessions.transfer', group: 'gaming', labelAr: 'نقل وتمديد الجلسة', labelEn: 'Transfer and extend sessions', hintAr: 'نقل وتمديد الجلسة حسب نطاق المنشأة.', hintEn: 'Transfer and extend sessions within assigned venues.', requires: ['sessions.start'] },
  { key: 'sessions.end', group: 'gaming', labelAr: 'إنهاء جلسة', labelEn: 'End sessions', hintAr: 'إنهاء جلسة حسب نطاق المنشأة.', hintEn: 'End sessions within assigned venues.', requires: ['bookings.view'] },
  { key: 'sessions.start', group: 'gaming', labelAr: 'بدء جلسة', labelEn: 'Start sessions', hintAr: 'بدء جلسة حسب نطاق المنشأة.', hintEn: 'Start sessions within assigned venues.', requires: ['bookings.view'] },
  { key: 'layout.view', group: 'gaming', labelAr: 'عرض توزيع الأجهزة', labelEn: 'View station layout', hintAr: 'عرض الأدوار والأجهزة دون بيانات مالية.', hintEn: 'See floors and stations without financial data.', requires: ['bookings.view'] },
  { key: 'layout.edit', group: 'gaming', labelAr: 'تعديل توزيع الأجهزة', labelEn: 'Edit station layout', hintAr: 'حفظ مسودة التوزيع دون تغيير الأسعار أو الحسابات.', hintEn: 'Save layout drafts without changing prices or bills.', requires: ['layout.view'] },
  { key: 'layout.publish', group: 'gaming', labelAr: 'نشر توزيع الأجهزة', labelEn: 'Publish station layout', hintAr: 'اعتماد مسودة التوزيع للتشغيل.', hintEn: 'Publish a layout draft for operations.', requires: ['layout.edit'] },

  {
    key: 'bookings.view',
    group: 'schedule',
    labelAr: 'شوف الحجوزات والجدول',
    labelEn: 'See bookings & schedule',
    hintAr: 'شاشة اليوم وقائمة الحجوزات وتفاصيل كل حجز.',
    hintEn: 'Today board, bookings list and booking details.',
  },
  {
    key: 'bookings.create',
    group: 'schedule',
    labelAr: 'يعمل حجز جديد',
    labelEn: 'Create bookings',
    hintAr: 'حجز walk-in أو تليفون أو واتساب، وحجز ثابت.',
    hintEn: 'Walk-in, phone or WhatsApp bookings.',
    requires: ['bookings.view'],
  },
  {
    key: 'bookings.edit',
    group: 'schedule',
    labelAr: 'يعدّل ويلغي الحجوزات',
    labelEn: 'Edit & delete bookings',
    hintAr: 'تغيير الوقت والسعر والبيانات، وحذف واسترجاع الحجوزات اليدوية.',
    hintEn: 'Change time, price and details; delete or restore manual bookings.',
    requires: ['bookings.view'],
  },
  {
    key: 'bookings.checkin',
    group: 'schedule',
    labelAr: 'يسجّل وصول اللاعبين',
    labelEn: 'Check players in',
    hintAr: 'مسح QR، "جه"، و"ما جاش".',
    hintEn: 'Scan QR, mark arrived or no-show.',
    requires: ['bookings.view'],
  },
  {
    key: 'payments.record',
    group: 'schedule',
    labelAr: 'يسجّل دفعات العملاء',
    labelEn: 'Record customer payments',
    hintAr: 'استلام مبلغ كامل أو جزء من حجز.',
    hintEn: 'Take a full or part payment on a booking.',
    requires: ['bookings.view'],
  },
  {
    key: 'schedule.manage',
    group: 'schedule',
    labelAr: 'يقفل مواعيد ويستخدم المساعد',
    labelEn: 'Close slots & use the assistant',
    hintAr: 'قفل ملعب أو جهاز أو ترابيزة لفترة (صيانة/خاص) ومساعد الجدول.',
    hintEn: 'Block a court, station or table for maintenance or private use; schedule assistant.',
    requires: ['bookings.view'],
  },
  {
    key: 'customers.view',
    group: 'schedule',
    labelAr: 'يشوف العملاء',
    labelEn: 'See customers',
    hintAr: 'قايمة العملاء وأرقامهم وعدد حجوزاتهم.',
    hintEn: 'Customer list, phone numbers and booking counts.',
  },
  {
    key: 'reports.view',
    group: 'money',
    labelAr: 'يشوف التقارير والأرباح',
    labelEn: 'See reports & earnings',
    hintAr: 'الإيراد والإشغال والتصدير.',
    hintEn: 'Revenue, occupancy and exports.',
  },
  {
    key: 'expenses.manage',
    group: 'money',
    labelAr: 'يسجّل المصروفات',
    labelEn: 'Record expenses',
    hintAr: 'كهرباء وإيجار ورواتب وغيره، عشان يظهر الربح الفعلي.',
    hintEn: 'Electricity, rent, salaries and more, so real profit can be shown.',
    requires: ['reports.view'],
  },
  {
    key: 'shifts.review',
    group: 'money',
    labelAr: 'يراجع الخزنة والورديات',
    labelEn: 'Review cash drawers & shifts',
    hintAr: 'يشوف فلوس كل موظف ويقفل خزنة مشتركة أو عن موظف، ويراجع الفروقات ويسترد دفعات الغير.',
    hintEn: "See everyone's cash, close a shared drawer or close for someone, review differences, refund others' payments.",
    requires: ['payments.record', 'reports.view'],
  },
  {
    key: 'account.view',
    group: 'money',
    labelAr: 'يشوف الحساب مع ماتشنا',
    labelEn: 'See the Matchena account',
    hintAr: 'الرصيد والعمولة وكشف الحساب.',
    hintEn: 'Balance, commission and ledger.',
  },
  {
    key: 'account.remit',
    group: 'money',
    labelAr: 'يبعت تحويلات لماتشنا',
    labelEn: 'Send remittances',
    hintAr: 'تسجيل مبلغ حوّلته لماتشنا.',
    hintEn: 'Report money paid to Matchena.',
    requires: ['account.view'],
  },
  {
    key: 'venue.manage',
    group: 'venue',
    labelAr: 'يعدّل بيانات المكان',
    labelEn: 'Edit venue details',
    hintAr: 'الاسم والصور والوصف وإضافة وتعديل الملاعب والأجهزة والترابيزات.',
    hintEn: 'Name, photos, description; add or edit courts, stations or tables.',
  },
  {
    key: 'pricing.manage',
    group: 'venue',
    labelAr: 'يعدّل الأسعار',
    labelEn: 'Change prices',
    hintAr: 'أسعار الساعات وقواعد الذروة والعروض بالوقت.',
    hintEn: 'Hourly prices and peak rules.',
  },
  {
    key: 'promotions.manage',
    group: 'growth',
    labelAr: 'يعمل أكواد خصم',
    labelEn: 'Manage promotions',
    hintAr: 'إنشاء وإيقاف أكواد الخصم.',
    hintEn: 'Create and pause promo codes.',
  },
  {
    key: 'tournaments.manage',
    group: 'growth',
    labelAr: 'يدير البطولات',
    labelEn: 'Manage tournaments',
    hintAr: 'إنشاء بطولة وتوليد الجدول.',
    hintEn: 'Create tournaments and generate brackets.',
  },
  {
    key: 'reviews.reply',
    group: 'growth',
    labelAr: 'يرد على التقييمات',
    labelEn: 'Reply to reviews',
    hintAr: 'الرد على تقييمات اللاعبين.',
    hintEn: 'Reply to player reviews.',
  },
  {
    key: 'team.manage',
    group: 'team',
    labelAr: 'يدير الفريق',
    labelEn: 'Manage the team',
    hintAr: 'يضيف ويعدّل ويمسح الموظفين ويحدد صلاحياتهم (بحدود صلاحياته هو).',
    hintEn: 'Add, edit and remove staff and set their permissions (within his own).',
  },
];

export interface PermissionPreset {
  key: string;
  labelAr: string;
  labelEn: string;
  permissions: PermissionKey[];
}

export const PERMISSION_PRESETS: PermissionPreset[] = [
  {
    key: 'bookings_only', labelAr: 'حجوزات فقط', labelEn: 'Bookings only',
    permissions: ['bookings.view', 'bookings.create', 'bookings.edit', 'bookings.checkin'],
  },
  {
    key: 'reception',
    labelAr: 'استقبال',
    labelEn: 'Reception',
    permissions: ['bookings.view', 'bookings.create', 'bookings.checkin', 'payments.record', 'customers.view'],
  },
  {
    key: 'accountant',
    labelAr: 'محاسب',
    labelEn: 'Accountant',
    permissions: ['bookings.view', 'payments.record', 'reports.view', 'expenses.manage', 'shifts.review', 'account.view', 'account.remit'],
  },
  {
    key: 'supervisor',
    labelAr: 'مشرف',
    labelEn: 'Supervisor',
    permissions: [
      'bookings.view',
      'bookings.create',
      'bookings.edit',
      'bookings.checkin',
      'payments.record',
      'schedule.manage',
      'customers.view',
      'reports.view',
      'shifts.review',
    ],
  },
  // Gaming / PlayStation venues: floor operator, till, and a supervisor who can also fix mistakes.
  {
    key: 'gaming_floor', labelAr: 'مشغّل الصالة (ألعاب)', labelEn: 'Gaming floor operator',
    permissions: ['bookings.view', 'sessions.start', 'sessions.end', 'sessions.transfer', 'layout.view', 'products.view', 'orders.manage', 'payments.record', 'receipts.print'],
  },
  {
    key: 'gaming_cashier', labelAr: 'كاشير (ألعاب)', labelEn: 'Gaming cashier',
    permissions: ['bookings.view', 'products.view', 'orders.manage', 'payments.record', 'receipts.print'],
  },
  {
    key: 'gaming_supervisor', labelAr: 'مشرف الألعاب', labelEn: 'Gaming supervisor',
    permissions: ['bookings.view', 'sessions.start', 'sessions.end', 'sessions.transfer', 'sessions.correct', 'layout.view', 'products.view', 'products.manage', 'orders.manage', 'payments.record', 'discounts.apply', 'refunds.issue', 'receipts.print', 'customers.view'],
  },
  {
    key: 'manager',
    labelAr: 'مدير (كل حاجة)',
    labelEn: 'Manager (everything)',
    permissions: [...PERMISSION_KEYS],
  },
  {
    key: 'viewer',
    labelAr: 'مشاهدة فقط',
    labelEn: 'View only',
    permissions: ['bookings.view'],
  },
];

export function isPermissionKey(value: string): value is PermissionKey {
  return (PERMISSION_KEYS as readonly string[]).includes(value);
}

/** Drops unknown keys and pulls in what a key depends on, so a saved set is always coherent. */
export function normalizePermissions(input: readonly string[]): PermissionKey[] {
  const out = new Set<PermissionKey>();
  const add = (key: PermissionKey) => {
    if (out.has(key)) return;
    out.add(key);
    for (const dep of PERMISSION_CATALOG.find((p) => p.key === key)?.requires ?? []) add(dep);
  };
  for (const key of input) if (isPermissionKey(key)) add(key);
  return PERMISSION_KEYS.filter((k) => out.has(k));
}
