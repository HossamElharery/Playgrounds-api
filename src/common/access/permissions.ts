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
  'account.view',
  'account.remit',
  'venue.manage',
  'pricing.manage',
  'promotions.manage',
  'tournaments.manage',
  'reviews.reply',
  'team.manage',
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export interface PermissionDef {
  key: PermissionKey;
  group: 'schedule' | 'money' | 'venue' | 'growth' | 'team';
  labelAr: string;
  labelEn: string;
  hintAr: string;
  hintEn: string;
  /** Turning this on only makes sense together with these. */
  requires?: PermissionKey[];
}

export const PERMISSION_CATALOG: PermissionDef[] = [
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
    hintAr: 'قفل ملعب لفترة (صيانة/خاص) ومساعد الجدول.',
    hintEn: 'Block a court for maintenance or private use; schedule assistant.',
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
    labelAr: 'يعدّل بيانات الملاعب',
    labelEn: 'Edit venue & courts',
    hintAr: 'الاسم والصور والوصف وإضافة وتعديل الملاعب.',
    hintEn: 'Name, photos, description, add or edit courts.',
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
    key: 'reception',
    labelAr: 'استقبال',
    labelEn: 'Reception',
    permissions: ['bookings.view', 'bookings.create', 'bookings.checkin', 'payments.record', 'customers.view'],
  },
  {
    key: 'accountant',
    labelAr: 'محاسب',
    labelEn: 'Accountant',
    permissions: ['bookings.view', 'payments.record', 'reports.view', 'expenses.manage', 'account.view', 'account.remit'],
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
    ],
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
