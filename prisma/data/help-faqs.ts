/**
 * Production Help Center copy — bilingual, SEO-oriented, product-accurate.
 * Imported by prisma/seed.ts. The matching SQL migration ships the same rows
 * to environments that never run the demo seed.
 */
export const HELP_FAQ_CATEGORIES = [
  'booking',
  'payments',
  'account',
  'play',
  'owners',
  'policies',
] as const;

export type HelpFaqCategory = (typeof HELP_FAQ_CATEGORIES)[number];

export interface HelpFaqSeed {
  id: string;
  category: HelpFaqCategory;
  position: number;
  questionEn: string;
  questionAr: string;
  answerEn: string;
  answerAr: string;
  ctaPath: string;
  ctaLabelEn: string;
  ctaLabelAr: string;
}

const HELP_FAQ_ROWS: Omit<HelpFaqSeed, 'ctaPath' | 'ctaLabelEn' | 'ctaLabelAr'>[] = [
  {
    id: 'faq-what',
    category: 'booking',
    position: 0,
    questionEn: 'What is Matchena?',
    questionAr: 'ماتشنا إيه؟',
    answerEn:
      'Matchena is a court booking and venue-management platform in Egypt. Players see live times and prices, confirm a slot, and check in with a QR code. Venue owners run the same courts from their dashboard: calendar, prices, walk-ins, staff, and earnings — football, padel, tennis, squash, PlayStation and more.',
    answerAr:
      'ماتشنا منصة حجز وإدارة ملاعب في مصر. اللاعب يشوف الميعاد والسعر، يأكّد الحجز، ويعمل تشيك إن بـ QR. صاحب الملعب يدير نفس الكورتات من الداشبورد: التقويم، الأسعار، حجوزات الاستقبال، الموظفين، والأرباح — كرة، بادل، تنس، اسكواش، بلايستيشن وأكتر.',
  },
  {
    id: 'faq-book',
    category: 'booking',
    position: 1,
    questionEn: 'How do I book a court on Matchena?',
    questionAr: 'إزاي أحجز ملعب على ماتشنا؟',
    answerEn:
      'Open Explore, pick a sport and area, then choose a venue. Select a free slot and duration, apply a promo or coins if you have them, and confirm. Matchena holds the slot for a few minutes while you pay from your wallet so nobody else takes it.',
    answerAr:
      'من استكشف اختار الرياضة والمنطقة، افتح الملعب، وحدد ميعاد فاضي والمدة. لو عندك كود خصم أو كوينز استخدمهم، وبعدين أكّد. الميعاد بيتقفّل دقايق وأنت بتدفع من المحفظة عشان محدش ياخده.',
  },
  {
    id: 'faq-sports',
    category: 'booking',
    position: 2,
    questionEn: 'Which sports can I book in Egypt?',
    questionAr: 'أنهي رياضات ينفع أحجزها؟',
    answerEn:
      'You can book football (including 5-a-side), padel, tennis, squash, basketball, volleyball, swimming, table tennis, billiards, and PlayStation lounges — whatever partner venues list as open. Filter by sport on Explore to see live availability near you.',
    answerAr:
      'تقدر تحجز كرة قدم (ومنها الخماسية)، بادل، تنس، اسكواش، كرة سلة، طائرة، سباحة، بينج بونج، بلياردو، وبلايستيشن — حسب الملاعب الشريكة. فلتر بالرياضة من استكشف عشان تشوف المواعيد القريبة منك.',
  },
  {
    id: 'faq-call',
    category: 'booking',
    position: 3,
    questionEn: 'Do I need to call the venue to check if a slot is free?',
    questionAr: 'لازم أكلّم الملعب عشان أعرف لو فاضي؟',
    answerEn:
      'No. Availability and the hourly price sit on the venue page. If the slot is shown as open, you can book it instantly. Confirmation holds the court — you do not need a phone call to reserve it.',
    answerAr:
      'لأ. المواعيد والسعر ظاهرين على صفحة الملعب. لو الميعاد فاضي، احجزه مباشرة. التأكيد بيقفل الكورت — من غير مكالمة عشان تحجز.',
  },
  {
    id: 'faq-hold',
    category: 'booking',
    position: 4,
    questionEn: 'How long does Matchena hold a slot while I pay?',
    questionAr: 'الميعاد بيتقفّل قد إيه وأنا بدفع؟',
    answerEn:
      'After you start checkout, Matchena holds the slot for a few minutes so it stays yours while the wallet payment completes. If the hold expires, the time goes back on the calendar and you can pick another slot.',
    answerAr:
      'أول ما تبدأ الدفع، ماتشنا بتقفل الميعاد دقايق عشان يفضل بتاعك لحد ما الدفع من المحفظة يتم. لو الوقت خلص، الميعاد يرجع على الجدول وتقدر تختار ميعاد تاني.',
  },
  {
    id: 'faq-cancel',
    category: 'booking',
    position: 5,
    questionEn: 'How do I cancel a court booking?',
    questionAr: 'إزاي ألغي حجز ملعب؟',
    answerEn:
      'Open My Bookings and cancel before the venue’s cutoff. Each listing shows its own free-cancellation window at checkout — often two or three hours before kickoff. The refund amount depends on how close you are to the slot.',
    answerAr:
      'من حجوزاتي اضغط إلغاء قبل ميعاد الإلغاء بتاع الملعب. كل منشأة بتظهر سياسة الإلغاء أثناء الحجز — الشائع ساعتين أو تلاتة قبل البداية. نسبة الاسترجاع بتعتمد على قربك من الميعاد.',
  },
  {
    id: 'faq-pay',
    category: 'payments',
    position: 10,
    questionEn: 'How do I pay for a booking on Matchena?',
    questionAr: 'أدفع حجز الملعب إزاي؟',
    answerEn:
      'Bookings debit your Matchena EGP wallet. Top it up with a card, Vodafone Cash, Orange Cash, Fawry, or InstaPay. Some venues also allow cash at the gate — that option appears only when the operator enables it. Never pay a random number from the venue page.',
    answerAr:
      'الحجوزات بتتعمل من محفظة ماتشنا بالجنيه. اشحنها ببطاقة، فودافون كاش، أورانج كاش، فوري، أو إنستاباي. بعض الملاعب بتقبل كاش عند البوابة لو المشغّل مفعّل الخيار. متدفعش على رقم عشوائي من صفحة الملعب.',
  },
  {
    id: 'faq-split',
    category: 'payments',
    position: 11,
    questionEn: 'Can we split the court fee with the squad?',
    questionAr: 'ينفع نقسم سعر الملعب على الفريق؟',
    answerEn:
      'Yes. When you confirm, add split shares for your teammates. The booking stays partial until every share is paid and the amounts add up to the total. Nobody loses the slot because one person is still collecting cash.',
    answerAr:
      'أيوه. وقت التأكيد ضيف حصص التقسيم لأصحابك. الحجز يفضل جزئي لحد ما كل حصة تتدفع والمبالغ تساوي الإجمالي. الميعاد مايضيعش عشان واحد لسه بيجمع الكاش.',
  },
  {
    id: 'faq-wallet',
    category: 'payments',
    position: 12,
    questionEn: 'What is the Matchena wallet?',
    questionAr: 'إيه محفظة ماتشنا؟',
    answerEn:
      'Your EGP wallet is the prepaid balance for bookings, hour bundles, and memberships. Top up once, then pay in the app. Coins are a separate rewards currency — they are not cash, and they sit next to the wallet, not inside it.',
    answerAr:
      'محفظة الجنيه هي رصيدك المدفوع مقدمًا للحجوزات وباقات الساعات والعضويات. اشحن مرة، وادفع من التطبيق. الكوينز عملة مكافآت منفصلة — مش فلوس نقدية، وبتظهر جنب المحفظة مش جواها.',
  },
  {
    id: 'faq-coins',
    category: 'payments',
    position: 13,
    questionEn: 'How do I earn and spend Matchena coins?',
    questionAr: 'الكوينز بتتجمع وتتصرف إزاي؟',
    answerEn:
      'Confirmed bookings, check-ins, quests, and reviews add coins. Spend them at checkout on eligible slots or on rewards like a streak freeze. Coins used on a cancelled booking return to your balance immediately.',
    answerAr:
      'الحجوزات المؤكدة والتشيك إن والمهام والتقييمات بتزوّد الكوينز. اصرفها وقت الحجز على المواعيد المتاحة أو على مكافآت زي تجميد الستريك. الكوينز في حجز ملغي بترجع فورًا.',
  },
  {
    id: 'faq-promo',
    category: 'payments',
    position: 14,
    questionEn: 'How do promo codes work?',
    questionAr: 'أكواد الخصم بتشتغل إزاي؟',
    answerEn:
      'Enter a valid code at checkout before you confirm. Each offer has its own discount, venue scope, dates, and usage limit. Whether a promo is restored after a cancellation depends on that offer’s terms.',
    answerAr:
      'اكتب الكود وقت الدفع قبل التأكيد. كل عرض له نسبة أو قيمة، ونطاق ملاعب، وتواريخ، وحد استخدام. إرجاع الكود بعد الإلغاء بيعتمد على شروط العرض نفسه.',
  },
  {
    id: 'faq-refund-time',
    category: 'payments',
    position: 15,
    questionEn: 'How long do Matchena refunds take?',
    questionAr: 'الاسترداد بياخد وقت قد إيه؟',
    answerEn:
      'Card refunds typically take 5–7 business days. Mobile wallets such as Vodafone Cash and Orange Cash usually reverse within 24–48 hours. Cash paid at the venue is settled with the operator. Full rules are on the Refund Policy page.',
    answerAr:
      'استرداد البطاقة خلال 5 إلى 7 أيام عمل. محافظ الموبايل زي فودافون كاش وأورانج كاش عادةً خلال 24 إلى 48 ساعة. الكاش في الملعب بيتحسم مع المشغّل. التفاصيل الكاملة في سياسة الاسترداد.',
  },
  {
    id: 'faq-account',
    category: 'account',
    position: 20,
    questionEn: 'How do I create a Matchena account?',
    questionAr: 'إزاي أعمل حساب على ماتشنا؟',
    answerEn:
      'Register with your mobile number — we send a one-time code — or continue with Google or Facebook. On supported devices you can unlock Face ID or a passkey so the next visit skips SMS. One account books courts, joins squads, and plays tonight.',
    answerAr:
      'سجّل برقم الموبايل — هيبعتلك كود مرة واحدة — أو كمّل بجوجل أو فيسبوك. وعلى الأجهزة المدعومة تقدر تفعّل Face ID أو passkey عشان الزيارة الجاية من غير SMS. حساب واحد للحجز والسكواد واللعب.',
  },
  {
    id: 'faq-otp',
    category: 'account',
    position: 21,
    questionEn: 'I did not receive the login OTP. What should I do?',
    questionAr: 'كود الدخول مش واصل. أعمل إيه؟',
    answerEn:
      'Use an Egyptian number in +20 format and wait about a minute. Check coverage and that the SMS was not filtered. Request a new code, or skip the wait and sign in with Google, Facebook, or Face ID.',
    answerAr:
      'استخدم رقم مصري بصيغة +20 واستنى حوالي دقيقة. اتأكد من الشبكة وإن الرسالة متفلترتش. اطلب كود جديد، أو ادخل مباشرة بجوجل أو فيسبوك أو Face ID.',
  },
  {
    id: 'faq-oauth',
    category: 'account',
    position: 22,
    questionEn: 'Can I sign in with Google, Facebook, or Face ID?',
    questionAr: 'ينفع أدخل بجوجل أو فيسبوك أو Face ID؟',
    answerEn:
      'Yes. Google and Facebook are on the login screen. On supported browsers and devices you can add a passkey or Face ID so the next visit skips the SMS code. Your bookings stay on the same Matchena account.',
    answerAr:
      'أيوه. جوجل وفيسبوك موجودين في شاشة الدخول. وعلى المتصفحات والأجهزة المدعومة تقدر تضيف passkey أو Face ID عشان الزيارة الجاية من غير كود SMS. حجوزاتك بتفضل على نفس حساب ماتشنا.',
  },
  {
    id: 'faq-qr',
    category: 'play',
    position: 30,
    questionEn: 'How does QR check-in work at the venue?',
    questionAr: 'التشيك إن بالـ QR بيتم إزاي؟',
    answerEn:
      'After the booking is confirmed you get a QR on the booking screen. Show it at the gate — the venue scans it and you are checked in. After the session you can review the venue; confirmed bookings and check-ins add coins.',
    answerAr:
      'بعد تأكيد الحجز هتلاقي QR على شاشة الحجز. اعرضه عند البوابة — الملعب بيمسحه وأنت اتشك إن. بعد الجلسة تقدر تقيّم الملعب، والحجوزات المؤكدة والتشيك إن بتزوّد الكوينز.',
  },
  {
    id: 'faq-pulse',
    category: 'play',
    position: 31,
    questionEn: 'What is Pulse if my match is one player short?',
    questionAr: 'إيه Pulse ولو الماتش ناقص؟',
    answerEn:
      'Pulse surfaces open matches that still need players in your country. Post a match, claim a spot, or invite your squad. Confirm only if you can attend — repeated late cancellations lower your reliability score.',
    answerAr:
      'Pulse بيظهر الماتشات المفتوحة اللي لسه محتاجة لاعيبة في نفس البلد. انشر ماتش، احجز مكان، أو ادعُ سكوادك. أكّد بس لو هتحضر — الإلغاء المتأخر المتكرر بيقلل درجة الالتزام.',
  },
  {
    id: 'faq-squad',
    category: 'play',
    position: 32,
    questionEn: 'How do squads and lobby invites work?',
    questionAr: 'السكواد ودعوات اللوبي بتشتغل إزاي؟',
    answerEn:
      'Create or join a squad, then invite friends to the lobby before you book. You can split the fee, share a hold link, and keep the group in one thread. If you are not free, decline — you can pause someone’s invites for a few minutes.',
    answerAr:
      'اعمل سكواد أو انضم لواحد، وبعدين ادعُ أصحابك للوبي قبل الحجز. تقدروا تقسموا الفاتورة، تشاركوا لينك الحجز، وتفضلوا في محادثة واحدة. لو مش فاضي، ارفض — وينفع توقف دعوات حد لدقايق.',
  },
  {
    id: 'faq-reliability',
    category: 'play',
    position: 33,
    questionEn: 'What is the reliability score on Matchena?',
    questionAr: 'درجة الالتزام دي إيه؟',
    answerEn:
      'Reliability reflects whether you show up after you confirm. No-shows and late cancellations can lower it. A strong score helps you get accepted into open matches and keeps captains confident when they invite you.',
    answerAr:
      'درجة الالتزام بتعكس إنك بتحضر بعد التأكيد. عدم الحضور والإلغاء المتأخر ممكن يقللوها. الدرجة العالية بتسهّل قبولك في الماتشات المفتوحة، وبتخلي الكابتن يطمّن وهو بيوجهلك دعوة.',
  },
  {
    id: 'faq-open-match',
    category: 'play',
    position: 34,
    questionEn: 'How do I join an open match?',
    questionAr: 'إزاي أنضم لماتش مفتوح؟',
    answerEn:
      'Go to Community, open Pulse or the matches tab, and claim a spot on a game that still needs players. Read the time, area, and cost per player before you confirm. Keep chat and payment inside Matchena.',
    answerAr:
      'من المجتمع افتح Pulse أو تبويب الماتشات، واحجز مكان في ماتش لسه ناقص لاعيبة. اقرأ الميعاد والمنطقة وتكلفة اللاعب قبل التأكيد. خلّي الشات والدفع جوه ماتشنا.',
  },
  {
    id: 'faq-membership',
    category: 'play',
    position: 35,
    questionEn: 'Can I buy a membership or an hour bundle?',
    questionAr: 'ينفع أشتري عضوية أو باقة ساعات؟',
    answerEn:
      'Where a venue offers them, you can buy hour bundles or a monthly membership from the listing and pay from your EGP wallet. Included hours and renewal dates sit on your account. Cancel a membership from the membership screen before the next renewal.',
    answerAr:
      'لو الملعب موفّر باقات ساعات أو عضوية شهرية، اشتريها من صفحة المنشأة وادفع من محفظة الجنيه. الساعات المتبقية وميعاد التجديد ظاهرين على حسابك. إلغاء العضوية من شاشة العضوية قبل التجديد الجاي.',
  },
  {
    id: 'faq-list-venue',
    category: 'owners',
    position: 40,
    questionEn: 'How do I list my venue on Matchena?',
    questionAr: 'إزاي أضيف ملعبي على ماتشنا؟',
    answerEn:
      'Apply from the Partners page with your courts, hours, prices, and cancellation window. After verification, the owner dashboard is yours: today’s schedule, bookings, pricing, staff, and earnings. Players book from the app without calling you.',
    answerAr:
      'قدّم من صفحة الشركاء بالكورتات والمواعيد والأسعار وسياسة الإلغاء. بعد الاعتماد، داشبورد المالك تبقى بتاعتك: جدول النهارده، الحجوزات، التسعير، الموظفين، والأرباح. اللاعب يحجز من التطبيق من غير ما يكلّمك.',
  },
  {
    id: 'faq-owner-payout',
    category: 'owners',
    position: 41,
    questionEn: 'How do venue owners get paid?',
    questionAr: 'صاحب الملعب بيستلم فلوسه إزاي؟',
    answerEn:
      'Online bookings settle through Matchena according to your partner terms. Add a bank account, InstaPay, or mobile wallet in owner settings — identifiers are stored masked. Cash taken at the door is reconciled with you directly.',
    answerAr:
      'حجوزات الأونلاين بتتسوّى عن طريق ماتشنا حسب شروط الشراكة. أضف حساب بنكي أو إنستاباي أو محفظة من إعدادات المالك — الرقم بيتخزن مقنّع. الكاش عند الباب بيتحسم معاك مباشرة.',
  },
  {
    id: 'faq-owner-cancel',
    category: 'owners',
    position: 42,
    questionEn: 'Can a venue owner cancel a player’s Matchena booking?',
    questionAr: 'كصاحب ملعب أقدر ألغي حجز لاعب من ماتشنا؟',
    answerEn:
      'Platform bookings belong to the player too, so you cannot cancel or move them yourself. Send a change or cancel request from the booking — Matchena admin is notified and the player is kept in the loop.',
    answerAr:
      'حجز ماتشنا ملك اللاعب كمان، فمتقدرش تلغيه أو تعدّله لوحدك. ابعت طلب تغيير أو إلغاء من الحجز — الإدارة بتتنبه، واللاعب بيفضل في الصورة.',
  },
  {
    id: 'faq-owner-dashboard',
    category: 'owners',
    position: 43,
    questionEn: 'What can I run from the venue owner dashboard?',
    questionAr: 'أقدر أدير إيه من داشبورد صاحب الملعب؟',
    answerEn:
      'The owner dashboard is the operating system for your courts. Today shows who is coming. You add a walk-in or phone booking, block a slot, scan a QR, and mark who showed up. From the same account you edit venues and prices, run promotions and tournaments, reply to reviews, invite staff, and read earnings.',
    answerAr:
      'داشبورد المالك هي تشغيل الملعب. صفحة النهارده بتوريك مين جاي. تضيف حجز استقبال أو تليفون، تقفل ميعاد، تمسح QR، وتعلّم مين حضر. ومن نفس الحساب تعدّل الملاعب والأسعار، تشغّل العروض والبطولات، ترد على التقييمات، تدعو الموظفين، وتتابع الأرباح.',
  },
  {
    id: 'faq-owner-walkin',
    category: 'owners',
    position: 44,
    questionEn: 'How do I add a walk-in or phone booking?',
    questionAr: 'إزاي أسجّل حجز استقبال أو تليفون؟',
    answerEn:
      'On Today, start a new booking, pick the court and slot, and mark how it came in — walk-in, phone, or WhatsApp — and whether it is paid. The slot leaves the public calendar so a player on Matchena cannot take it twice.',
    answerAr:
      'من صفحة النهارده ابدأ حجز جديد، اختار الكورت والميعاد، وحدّد المصدر: استقبال، تليفون، أو واتساب، وهل اتدفع. الميعاد يتشال من الجدول العام عشان لاعب على ماتشنا ماياخدوش مرتين.',
  },
  {
    id: 'faq-owner-block',
    category: 'owners',
    position: 45,
    questionEn: 'How do I close a court slot?',
    questionAr: 'إزاي أقفل ميعاد على الملعب؟',
    answerEn:
      'Block the time from Today when the court is in maintenance or a private session. A blocked slot is not bookable on Explore. Unblock it when the court is open again.',
    answerAr:
      'اقفل الميعاد من صفحة النهارده لو الكورت في صيانة أو جلسة خاصة. الميعاد المقفول مش قابل للحجز من استكشف. افتحه تاني لما الملعب يرجع متاح.',
  },
  {
    id: 'faq-owner-staff',
    category: 'owners',
    position: 46,
    questionEn: 'How do staff accounts work?',
    questionAr: 'حسابات الموظفين بتشتغل إزاي؟',
    answerEn:
      'Invite staff by email and give each person only the access they need: view bookings, check players in, manage prices, or read reports. You can suspend or remove access from the Staff screen without sharing your owner login.',
    answerAr:
      'ادعُ الموظف بالإيميل وادّيله الصلاحية اللي محتاجها بس: يشوف الحجوزات، يعمل تشيك إن، يدير الأسعار، أو يقرأ التقارير. تقدر توقف أو تشيل الصلاحية من شاشة الموظفين من غير ما تشارك دخول المالك.',
  },
  {
    id: 'faq-owner-scan',
    category: 'owners',
    position: 47,
    questionEn: 'How does the venue scan a player’s QR?',
    questionAr: 'الملعب بيمسح QR اللاعب إزاي؟',
    answerEn:
      'Open Scan from the owner dashboard and point it at the code on the player’s booking. A valid code checks them in for that slot. After the session, mark the booking as attended or as a no-show.',
    answerAr:
      'افتح المسح من داشبورد المالك ووجّهه على الكود في حجز اللاعب. الكود السليم بيعمل تشيك إن للميعاد ده. بعد الجلسة علّم الحجز حضر أو ما حضرش.',
  },
  {
    id: 'faq-policy',
    category: 'policies',
    position: 50,
    questionEn: 'What is Matchena’s cancellation and refund policy?',
    questionAr: 'سياسة الإلغاء والاسترداد في ماتشنا إيه؟',
    answerEn:
      'Each venue sets its cancellation window and shows it on the listing and at checkout. Cancel in time for a refund to wallet, card, or e-wallet as described on the Refund Policy page. After the cutoff, the booking is charged.',
    answerAr:
      'كل ملعب بيحدد ميعاد الإلغاء، وبيظهر في صفحة المنشأة وأثناء الحجز. لو ألغيت في الوقت، الاسترداد للمحفظة أو البطاقة أو الكاش حسب سياسة الاسترداد. بعد الميعاد، الحجز بيتخصم.',
  },
  {
    id: 'faq-noshow',
    category: 'policies',
    position: 51,
    questionEn: 'What happens if I confirm and do not show up?',
    questionAr: 'لو أكّدت الحجز ومظهرتش بيحصل إيه؟',
    answerEn:
      'A no-show is not refunded. The venue keeps the slot, and your reliability score may drop. If something went wrong at the gate, write to support@matchena.com within 48 hours with your booking code.',
    answerAr:
      'عدم الحضور من غير استرداد. الملعب يحتفظ بالميعاد، ودرجة الالتزام ممكن تقل. لو حصلت مشكلة عند البوابة، ابعت support@matchena.com خلال 48 ساعة ومعاك رقم الحجز.',
  },
  {
    id: 'faq-cities',
    category: 'policies',
    position: 52,
    questionEn: 'Where can I book a court with Matchena?',
    questionAr: 'ماتشنا شغالة في أنهي مدن؟',
    answerEn:
      'Matchena is live in Egypt. Partner venues appear on Explore as they go live — Greater Cairo first, then more areas. Filter by sport and neighbourhood to see who is actually accepting bookings today.',
    answerAr:
      'ماتشنا شغالة في مصر. الملاعب الشريكة بتظهر في استكشف أول ما تفعّل — القاهرة الكبرى أولاً وبعدين مناطق أكتر. فلتر بالرياضة والحي عشان تشوف مين بيستقبل حجز النهارده.',
  },
  {
    id: 'faq-contact',
    category: 'policies',
    position: 53,
    questionEn: 'How do I contact Matchena support?',
    questionAr: 'إزاي أتواصل مع دعم ماتشنا؟',
    answerEn:
      'Use the Contact page or email support@matchena.com with your booking code, venue, and slot time. We do not publish a public phone number. Logged-in messages are linked to your account so we can trace the booking faster.',
    answerAr:
      'من صفحة تواصل معنا أو على support@matchena.com، ومعاك رقم الحجز والملعب والميعاد. مفيش رقم هاتف عام. لو أنت مسجّل، الرسالة بتتربط بحسابك عشان نلاقي الحجز أسرع.',
  },
];

const HELP_FAQ_LINKS: Record<string, Pick<HelpFaqSeed, 'ctaPath' | 'ctaLabelEn' | 'ctaLabelAr'>> = {
  'faq-what': { ctaPath: 'explore', ctaLabelEn: 'Explore venues', ctaLabelAr: 'استكشف الملاعب' },
  'faq-book': { ctaPath: 'explore', ctaLabelEn: 'Start a booking', ctaLabelAr: 'ابدأ الحجز' },
  'faq-sports': { ctaPath: 'explore', ctaLabelEn: 'Browse sports', ctaLabelAr: 'شوف الرياضات' },
  'faq-call': { ctaPath: 'explore', ctaLabelEn: 'See open slots', ctaLabelAr: 'شوف المواعيد' },
  'faq-hold': { ctaPath: 'how-it-works', ctaLabelEn: 'How it works', ctaLabelAr: 'إزاي بتشتغل' },
  'faq-cancel': { ctaPath: 'app/bookings', ctaLabelEn: 'My bookings', ctaLabelAr: 'حجوزاتي' },
  'faq-pay': { ctaPath: 'app/wallet', ctaLabelEn: 'Open wallet', ctaLabelAr: 'افتح المحفظة' },
  'faq-split': { ctaPath: 'explore', ctaLabelEn: 'Book and split', ctaLabelAr: 'احجز وقسّم' },
  'faq-wallet': { ctaPath: 'app/wallet', ctaLabelEn: 'Open wallet', ctaLabelAr: 'افتح المحفظة' },
  'faq-coins': { ctaPath: 'app/wallet', ctaLabelEn: 'See your coins', ctaLabelAr: 'شوف الكوينز' },
  'faq-promo': { ctaPath: 'explore', ctaLabelEn: 'Book with a code', ctaLabelAr: 'احجز بكود' },
  'faq-refund-time': { ctaPath: 'refund-policy', ctaLabelEn: 'Refund policy', ctaLabelAr: 'سياسة الاسترداد' },
  'faq-account': { ctaPath: 'register', ctaLabelEn: 'Create an account', ctaLabelAr: 'اعمل حساب' },
  'faq-otp': { ctaPath: 'login', ctaLabelEn: 'Sign in', ctaLabelAr: 'تسجيل الدخول' },
  'faq-oauth': { ctaPath: 'login', ctaLabelEn: 'Sign in', ctaLabelAr: 'تسجيل الدخول' },
  'faq-qr': { ctaPath: 'app/bookings', ctaLabelEn: 'Show your QR', ctaLabelAr: 'اعرض الـ QR' },
  'faq-pulse': { ctaPath: 'app/pulse', ctaLabelEn: 'Open Pulse', ctaLabelAr: 'افتح Pulse' },
  'faq-squad': { ctaPath: 'app/teams', ctaLabelEn: 'Your squads', ctaLabelAr: 'سكوادك' },
  'faq-reliability': { ctaPath: 'app/profile', ctaLabelEn: 'Your profile', ctaLabelAr: 'ملفك' },
  'faq-open-match': { ctaPath: 'community', ctaLabelEn: 'Open matches', ctaLabelAr: 'الماتشات المفتوحة' },
  'faq-membership': { ctaPath: 'explore', ctaLabelEn: 'Find a venue', ctaLabelAr: 'دور على ملعب' },
  'faq-list-venue': { ctaPath: 'partners/join', ctaLabelEn: 'List your venue', ctaLabelAr: 'أضف ملعبك' },
  'faq-owner-payout': { ctaPath: 'owner/settings', ctaLabelEn: 'Payout settings', ctaLabelAr: 'إعدادات الاستلام' },
  'faq-owner-cancel': { ctaPath: 'owner/bookings', ctaLabelEn: 'Venue bookings', ctaLabelAr: 'حجوزات الملعب' },
  'faq-owner-dashboard': { ctaPath: 'owner/today', ctaLabelEn: 'Open today’s desk', ctaLabelAr: 'افتح مكتب النهارده' },
  'faq-owner-walkin': { ctaPath: 'owner/today', ctaLabelEn: 'Add a booking', ctaLabelAr: 'سجّل حجز' },
  'faq-owner-block': { ctaPath: 'owner/today', ctaLabelEn: 'Today’s schedule', ctaLabelAr: 'جدول النهارده' },
  'faq-owner-staff': { ctaPath: 'owner/staff', ctaLabelEn: 'Manage staff', ctaLabelAr: 'إدارة الموظفين' },
  'faq-owner-scan': { ctaPath: 'owner/scan', ctaLabelEn: 'Scan a QR', ctaLabelAr: 'امسح QR' },
  'faq-policy': { ctaPath: 'refund-policy', ctaLabelEn: 'Refund policy', ctaLabelAr: 'سياسة الاسترداد' },
  'faq-noshow': { ctaPath: 'contact', ctaLabelEn: 'Contact support', ctaLabelAr: 'راسل الدعم' },
  'faq-cities': { ctaPath: 'explore', ctaLabelEn: 'Explore areas', ctaLabelAr: 'استكشف المناطق' },
  'faq-contact': { ctaPath: 'contact', ctaLabelEn: 'Contact us', ctaLabelAr: 'تواصل معنا' },
};

export const HELP_FAQS: HelpFaqSeed[] = HELP_FAQ_ROWS.map((faq) => {
  const link = HELP_FAQ_LINKS[faq.id];
  if (!link) throw new Error(`Help FAQ ${faq.id} is missing a destination link`);
  return { ...faq, ...link };
});
