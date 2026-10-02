/**
 * The quality cases behind `npm run ai:eval` and the admin "Quality" tab: real
 * sentences (Egyptian Arabic, English, voice-transcript slips) and what a person
 * would expect each to mean. Synthetic — no customer data — so they may be sent
 * to any model being considered.
 */
import { EMPTY_FILTERS } from '../../search/captain/captain-text';
import type { CaptainFilters, CaptainReading } from '../../search/captain/captain.types';
import type { AssistantReading } from '../../owner/assistant/assistant.types';

export const EVAL_SPORTS = [
  { slug: 'football', nameAr: 'كرة القدم', nameEn: 'Football' },
  { slug: 'padel', nameAr: 'بادل', nameEn: 'Padel' },
  { slug: 'squash', nameAr: 'إسكواش', nameEn: 'Squash' },
  { slug: 'playstation', nameAr: 'بلايستيشن', nameEn: 'PlayStation' },
  { slug: 'billiards', nameAr: 'بلياردو', nameEn: 'Billiards' },
];
const EVAL_DISTRICTS = [
  { slug: 'maadi', nameAr: 'المعادي', nameEn: 'Maadi' },
  { slug: 'zamalek', nameAr: 'الزمالك', nameEn: 'Zamalek' },
  { slug: 'nasr-city', nameAr: 'مدينة نصر', nameEn: 'Nasr City' },
  { slug: 'new-cairo', nameAr: 'القاهرة الجديدة', nameEn: 'New Cairo' },
  { slug: 'sheikh-zayed', nameAr: 'الشيخ زايد', nameEn: 'Sheikh Zayed' },
];

export const evalContext = {
  buildPlatformContext: async () =>
    [
      `الرياضات المتاحة (استخدم الـ slug بالظبط): ${EVAL_SPORTS.map((s) => `${s.slug}=${s.nameAr}/${s.nameEn}`).join(', ')}`,
      `المناطق المتاحة (استخدم الـ slug بالظبط): ${EVAL_DISTRICTS.map((d) => `${d.slug}=${d.nameAr}/${d.nameEn}`).join(', ')}`,
      'مرادفات محلية شائعة: بادل=padel, كورة=football, بلاستيشن=playstation, سنوكر=billiards/snooker',
    ].join('\n'),
  listValidSlugs: async () => ({
    sports: new Set(EVAL_SPORTS.map((s) => s.slug)),
    districts: new Set(EVAL_DISTRICTS.map((d) => d.slug)),
  }),
};

// -------------------------------------------------------------- Captain ----

export interface CaptainCase {
  q: string;
  loggedIn?: boolean;
  context?: CaptainFilters;
  history?: { from: 'player' | 'captain'; text: string }[];
  expect: Partial<Record<keyof CaptainReading, unknown>> & { factIdsAny?: string[] };
}

export const PADEL_MAADI: CaptainFilters = { ...EMPTY_FILTERS, sport: 'padel', district: 'maadi' };

export const CAPTAIN_CASES: CaptainCase[] = [
  { q: 'عايز ملعب بادل في المعادي', expect: { intent: 'find_venues', sport: 'padel', district: 'maadi' } },
  { q: 'فين أحسن ملعب كورة في مدينة نصر', expect: { intent: 'find_venues', sport: 'football', district: 'nasr-city' } },
  { q: 'عايز حاجة رخيصة ألعب فيها بلايستيشن', expect: { intent: 'find_venues', sport: 'playstation', cheap: true } },
  { q: 'بادل قريب مني دلوقتي', expect: { intent: 'find_venues', sport: 'padel', nearMe: true } },
  { q: 'ملعب اسكواش تحت 200 جنيه', expect: { intent: 'find_venues', sport: 'squash', priceMax: 200 } },
  { q: 'ملاعب حجز فوري في الزمالك', expect: { intent: 'find_venues', district: 'zamalek', instantOnly: true } },
  { q: 'padel court in new cairo tonight', expect: { intent: 'find_venues', sport: 'padel', district: 'new-cairo', timeHint: 'tonight' } },
  { q: 'cheapest football pitch in sheikh zayed', expect: { intent: 'find_venues', sport: 'football', district: 'sheikh-zayed' } },
  { q: 'أرخص من كده', context: PADEL_MAADI, expect: { intent: 'find_venues', followUp: true, cheap: true } },
  { q: 'وفي الزمالك؟', context: PADEL_MAADI, expect: { intent: 'find_venues', followUp: true, district: 'zamalek' } },
  { q: 'خلاص كورة بدل بادل', context: PADEL_MAADI, expect: { intent: 'find_venues', followUp: true, sport: 'football' } },
  { q: 'الأعلى تقييم', context: PADEL_MAADI, expect: { intent: 'find_venues', followUp: true, sort: 'rating' } },
  { q: 'حجوزاتي', loggedIn: true, expect: { intent: 'my_bookings' } },
  { q: 'عندي حجز إمتى؟', loggedIn: true, expect: { intent: 'my_bookings' } },
  { q: 'when is my next booking', loggedIn: true, expect: { intent: 'my_bookings' } },
  { q: 'ازاي الغي الحجز؟', expect: { intent: 'faq', factIdsAny: ['cancel_policy'] } },
  { q: 'فلوسي هترجع امتى لو لغيت', expect: { intent: 'faq', factIdsAny: ['refund_timing', 'cancel_policy'] } },
  { q: 'طرق الدفع إيه؟ ينفع فودافون كاش', expect: { intent: 'faq', factIdsAny: ['payment_methods'] } },
  { q: 'لو مرحتش للحجز إيه اللي هيحصل', expect: { intent: 'faq', factIdsAny: ['no_show'] } },
  { q: 'إيه هو اللوبي؟', expect: { intent: 'faq', factIdsAny: ['what_is_lobby'] } },
  { q: 'أعزم أصحابي على اللوبي إزاي', loggedIn: true, expect: { intent: 'faq', factIdsAny: ['invite_lobby'] } },
  { q: 'صاحبي معندوش حساب ينفع يدخل؟', loggedIn: true, expect: { intent: 'faq', factIdsAny: ['lobby_guest_link', 'invite_lobby'] } },
  { q: 'المايك مش شغال في اللوبي', loggedIn: true, expect: { intent: 'faq', factIdsAny: ['lobby_mic'] } },
  { q: 'إزاي أكتم حد في اللوبي', loggedIn: true, expect: { intent: 'faq', factIdsAny: ['lobby_leader_tools'] } },
  { q: 'how do I invite friends to the lobby', loggedIn: true, expect: { intent: 'faq', factIdsAny: ['invite_lobby'] } },
  { q: 'can I book without an account', expect: { intent: 'faq', factIdsAny: ['account_needed'] } },
  { q: 'عايز أتواصل مع الدعم', expect: { intent: 'faq', factIdsAny: ['support_contact'] } },
  { q: 'أنا عندي ملعب وعايز أضيفه', expect: { intent: 'faq', factIdsAny: ['for_owners'] } },
  { q: 'عايز أصحاب ألعب معاهم', loggedIn: true, expect: { intent: 'players' } },
  { q: 'افتح الشات', loggedIn: true, expect: { intent: 'chat' } },
  { q: 'تسجيل دخول', expect: { intent: 'login' } },
  { q: 'سلام عليكم', expect: { intent: 'smalltalk' } },
  { q: 'شكرا يا كابتن', expect: { intent: 'smalltalk' } },
  { q: 'ممم', expect: { intent: 'unknown' } },
  { q: 'مين رئيس أمريكا', expect: { intent: 'unknown' } },
  { q: 'وريني كل الأماكن', expect: { intent: 'explore' } },
  { q: 'مين فاز في ماتش الأهلي امبارح', expect: { intent: 'unknown' } },
  { q: 'ملعب بالقرب من التجمع للبادل بس يكون حلو', expect: { intent: 'find_venues', sport: 'padel', district: 'new-cairo' } },
  { q: 'عايز اجيب ملعب لل 5 ادوار اسبوعي', expect: { intent: 'find_venues' } },
  { q: 'يا باشا حاجة في 6 اكتوبر؟ بلياردو', expect: { intent: 'find_venues', sport: 'billiards' } },
];

// ---------------------------------------------------------------- Owner ----

export const EVAL_COURTS = [
  { id: 'ps1', name: 'PS5 Room 1', details: 'playstation PS5 Room 1' },
  { id: 'ps2', name: 'PS5 Room 2', details: 'playstation PS5 Room 2' },
  { id: 'pd1', name: 'ملعب بادل 1', details: 'بادل padel' },
  { id: 'fb5', name: 'ملعب 5x5', details: 'كرة قدم football' },
];
export const EVAL_TODAY = '2026-10-05';
export const EVAL_TOMORROW = '2026-10-06';

export interface OwnerCase {
  q: string;
  draft?: AssistantReading;
  expect: Partial<Record<keyof AssistantReading, unknown>>;
}

export const OWNER_CASES: OwnerCase[] = [
  { q: 'احجز بلايستيشن 1 بكرة الساعة 7 مساء لمحمد ساعتين بـ 400 دفع 200', expect: { intent: 'book', courtIds: ['ps1'], date: EVAL_TOMORROW, fromMins: 1140, durationMinutes: 120, customerName: 'محمد', totalAmount: 400, paidAmount: 200 } },
  { q: 'احجز ملعب البادل بكرة 9 الصبح', expect: { intent: 'book', courtIds: ['pd1'], date: EVAL_TOMORROW, fromMins: 540 } },
  { q: 'احجز الملعب الخماسي الساعة 8 لأحمد وحسن', expect: { intent: 'book', courtIds: ['fb5'], fromMins: 1200 } },
  { q: 'أحمد هيحجز روم 2 النهاردة 6 واتساب', expect: { intent: 'book', courtIds: ['ps2'], date: EVAL_TODAY, fromMins: 1080, sourceKey: 'whatsapp' } },
  { q: 'book PS5 room 1 tomorrow at 9pm for Sara, 300 paid', expect: { intent: 'book', courtIds: ['ps1'], date: EVAL_TOMORROW, fromMins: 1260, customerName: 'Sara', paidAmount: 300 } },
  { q: 'اقفل بلايستيشن 2 بكرة من 6 ل 8', expect: { intent: 'block', courtIds: ['ps2'], date: EVAL_TOMORROW, fromMins: 1080, toMins: 1200 } },
  { q: 'قفل كل الاجهزة النهاردة صيانة', expect: { intent: 'block', date: EVAL_TODAY } },
  { q: 'افتح ملعب البادل بكرة', expect: { intent: 'unblock', courtIds: ['pd1'], date: EVAL_TOMORROW } },
  { q: 'محمد دفع الباقي', expect: { intent: 'pay', customerName: 'محمد' } },
  { q: 'خدت من احمد 200', expect: { intent: 'pay', customerName: 'احمد', paidAmount: 200 } },
  { q: 'الغي حجز محمد بكرة', expect: { intent: 'cancel', customerName: 'محمد', date: EVAL_TOMORROW } },
  { q: 'انقل حجز محمد للساعة 8', expect: { intent: 'move', customerName: 'محمد', newFromMins: 1200 } },
  { q: 'خلي حجز أحمد ساعتين', expect: { intent: 'move', customerName: 'أحمد', durationMinutes: 120 } },
  { q: 'إيه حجوزات النهاردة؟', expect: { intent: 'agenda', date: EVAL_TODAY } },
  { q: 'مين حاجز بكرة', expect: { intent: 'agenda', date: EVAL_TOMORROW } },
  { q: 'في إيه محتاج انتباه', expect: { intent: 'attention' } },
  { q: 'عملت كام النهاردة؟', expect: { intent: 'money', rangeKey: 'today' } },
  { q: 'الايراد بتاع الشهر ده', expect: { intent: 'money', rangeKey: 'this_month' } },
  { q: 'مين عليه فلوس؟', expect: { intent: 'debts' } },
  { q: 'سجل 500 جنيه كهربا', expect: { intent: 'expense', expenseCategory: 'electricity' } },
  { q: 'سجّل مصروف صيانة 300', expect: { intent: 'expense', expenseCategory: 'maintenance' } },
  { q: 'ايه المواعيد الفاضية بكرة على البادل', expect: { intent: 'free', courtIds: ['pd1'], date: EVAL_TOMORROW } },
  { q: 'ازاي استخدمك', expect: { intent: 'help' } },
  { q: 'شكرا', expect: { intent: 'unknown' } },
  { q: 'احجز', expect: { intent: 'book' } },
  { q: 'احجز بلايستيشن الساعة 5 لا 6 لمحمد', expect: { intent: 'book', fromMins: 1080, customerName: 'محمد' } },
];

