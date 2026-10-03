/**
 * What Captain may tell a player about Matchena itself — the built-in set.
 *
 * Each entry is written once, reviewed by a person, and shown to the player
 * word for word — the model only chooses WHICH entries answer the question
 * (by id), it never writes the answer. A claim that is not in the knowledge
 * table, or in the help center, is a claim Captain does not make.
 *
 * The admin edits these in the database; this file seeds a missing entry once
 * (it never overwrites an edit or brings back a deleted one) and is the
 * fallback when the table is empty or unreachable.
 *
 * `when` ties an entry to a feature flag: a lobby feature that is switched off
 * in production must not be promised to players.
 */
export type KnowledgeFlag = 'morphs' | 'movement' | 'ball' | 'kiosk';

export interface KnowledgeEntry {
  id: string;
  /** One short line the model reads to decide whether the question is about this. */
  topicAr: string;
  topicEn: string;
  ar: string;
  en: string;
  /** In-app path (no locale) or a named destination for the answer's button. */
  cta?: { target: string; labelAr: string; labelEn: string };
  when?: KnowledgeFlag;
}

export const KNOWLEDGE: KnowledgeEntry[] = [
  {
    id: 'how_booking',
    topicAr: 'إزاي أحجز ملعب خطوة بخطوة',
    topicEn: 'How to book a venue step by step',
    ar: 'تدخل على صفحة الملاعب، تختار الرياضة والمنطقة، تفتح الملعب اللي عجبك وتختار الميعاد، والأسعار والمواعيد بتظهر لك قبل ما تأكد الحجز.',
    en: 'Open the venues page, pick the sport and the area, open a venue and choose a time. Prices and times are shown before you confirm.',
    cta: { target: 'explore', labelAr: 'استكشف الملاعب', labelEn: 'Explore venues' },
  },
  {
    id: 'cancel_policy',
    topicAr: 'سياسة الإلغاء وميعاد الإلغاء المجاني',
    topicEn: 'Cancellation policy and the free-cancellation window',
    ar: 'كل ملعب بيحدد سياسة الإلغاء بتاعته، وبتظهر في صفحة المنشأة وأثناء الحجز. الشائع إن الإلغاء المجاني يكون قبل الميعاد بساعتين أو تلاتة، فاقرا السياسة على الشاشة قبل ما تأكد.',
    en: 'Each venue sets its own cancellation window. It is shown on the venue page and at checkout. Free cancellation two or three hours before the slot is common, so read the policy on screen before you confirm.',
    cta: { target: 'app/bookings', labelAr: 'حجوزاتي', labelEn: 'My bookings' },
  },
  {
    id: 'refund_timing',
    topicAr: 'الاسترداد وإمتى الفلوس ترجع',
    topicEn: 'Refunds and how long they take',
    ar: 'استرداد البطاقة بياخد من 5 لـ 7 أيام عمل. محافظ الموبايل (فودافون كاش وأورانج كاش) عادة خلال 24 لـ 48 ساعة. الكاش اللي اتدفع في الملعب بيتحسم مع المشغّل مباشرة.',
    en: 'Card refunds take 5 to 7 business days. Mobile wallets (Vodafone Cash, Orange Cash) usually reverse within 24 to 48 hours. Cash paid at the venue is settled with the operator.',
  },
  {
    id: 'coins_promo',
    topicAr: 'الكوينز وأكواد الخصم عند الإلغاء',
    topicEn: 'Coins and promo codes when a booking is cancelled',
    ar: 'الكوينز المستخدمة في حجز ملغي بترجع للمحفظة فورًا. رجوع كود الخصم بيعتمد على شروط العرض نفسه.',
    en: 'Coins used on a cancelled booking return to your wallet immediately. Whether a promo code use is restored depends on that offer’s terms.',
  },
  {
    id: 'no_show',
    topicAr: 'لو مجتش في ميعاد الحجز',
    topicEn: 'What happens if I do not show up',
    ar: 'لو أكدت الحجز ومحضرتش، مفيش استرداد ودرجة الالتزام بتاعتك ممكن تتأثر.',
    en: 'If you confirm a booking and do not attend, there is no refund and your reliability score may be affected.',
  },
  {
    id: 'support_contact',
    topicAr: 'التواصل مع الدعم أو الاعتراض على استرداد',
    topicEn: 'Contacting support or disputing a refund',
    ar: 'ابعت على support@matchena.com ومعاك رقم الحجز واسم الملعب وميعاده. وللاعتراض على استرداد، ابعت خلال 48 ساعة من ميعاد الحجز.',
    en: 'Write to support@matchena.com with your booking code, the venue and the slot time. To dispute a refund, write within 48 hours of the slot.',
    cta: { target: 'help', labelAr: 'مركز المساعدة', labelEn: 'Help center' },
  },
  {
    id: 'payment_methods',
    topicAr: 'طرق الدفع',
    topicEn: 'Payment methods',
    ar: 'طرق الدفع بتظهر لك أثناء الحجز وبتختلف حسب الملعب: بطاقة، أو محفظة موبايل زي فودافون كاش وأورانج كاش، أو كاش في الملعب لو الملعب بيقبله.',
    en: 'The payment options are shown at checkout and depend on the venue: card, a mobile wallet such as Vodafone Cash or Orange Cash, or cash at the venue where it accepts that.',
  },
  {
    id: 'account_needed',
    topicAr: 'هل محتاج حساب عشان أدور أو أحجز',
    topicEn: 'Do I need an account to search or book',
    ar: 'تقدر تدور على ملعب من غير حساب. الأصحاب والشات والحجوزات واللوبي محتاجين حساب، فسجّل دخول لو عايزهم.',
    en: 'You can look for a venue without an account. Friends, chat, bookings and the lobby need an account, so sign in when you want them.',
    cta: { target: 'login', labelAr: 'تسجيل الدخول', labelEn: 'Sign in' },
  },
  {
    id: 'what_is_lobby',
    topicAr: 'إيه هو اللوبي (لوبي السكواد)',
    topicEn: 'What the lobby (squad lobby) is',
    ar: 'اللوبي مساحة صوت ولعب لأصحابك: بتعمل سكواد لحد 7 أعضاء، وتتكلموا مع بعض صوت بصوت وإنتوا بتتفقوا على الماتش. تدخله من أدوات السكواد جوه حسابك.',
    en: 'The lobby is a voice and play space for your friends: build a squad of up to 7 members and talk to each other while you plan the match. You open it from the squad tools in your account.',
  },
  {
    id: 'invite_lobby',
    topicAr: 'إزاي أدعو أصحابي للوبي أو أبعتلهم رابط',
    topicEn: 'How to invite friends to the lobby or send them a link',
    ar: 'من اللوبي دوس "ابعت لأصحابك": بتختار من أصحابك اللي أونلاين وتبعتلهم دعوة، أو تبعت رابط دعوة على واتساب وأي حد يفتحه يدخل اللوبي. اللوبي بيشيل لحد 7 أعضاء.',
    en: 'In the lobby tap "Invite your friends": pick from friends who are online and send an invite, or share an invite link, for example on WhatsApp, and whoever opens it joins the lobby. The lobby holds up to 7 members.',
  },
  {
    id: 'lobby_guest_link',
    topicAr: 'صاحبي معهوش حساب، يقدر يدخل اللوبي',
    topicEn: 'My friend has no account, can they join the lobby',
    ar: 'أيوه، لو بعتله رابط الدعوة يقدر يدخل اللوبي من غير ما يكمل تسجيل حساب كامل، وبعدين يعمل حسابه لو عايز يكمل على المنصة.',
    en: 'Yes. If you send the invite link they can join the lobby without a full account, and create one afterwards if they want to keep using the platform.',
  },
  {
    id: 'lobby_mic',
    topicAr: 'مشاكل المايك والصوت في اللوبي',
    topicEn: 'Microphone and sound problems in the lobby',
    ar: 'اسمح بالمايك من إعدادات الموقع (أيقونة القفل جنب العنوان أو إعدادات سفاري) وبعدين اضغط حاول تاني. لو فتحت الرابط من جوه واتساب أو إنستجرام المايك مش هيشتغل، فافتحه في سفاري أو كروم. تقدر تسمع أصحابك حتى لو مايكك مقفول.',
    en: 'Allow the microphone from the site settings (the lock icon next to the address, or Safari settings) and try again. If you opened the link inside WhatsApp or Instagram the microphone will not work, so open it in Safari or Chrome. You can hear your friends even when your own mic is off.',
  },
  {
    id: 'lobby_leader_tools',
    topicAr: 'قائد اللوبي، كتم أو شيل حد من اللوبي، والإبلاغ',
    topicEn: 'Lobby leader, muting or removing someone, reporting',
    ar: 'قائد اللوبي يقدر يكتم صوت حد للكل أو يشيله من السكواد أو يخلي حد تاني قائد. أي عضو يقدر يكتم حد عنده بس أو يبلّغ عن لاعب.',
    en: 'The lobby leader can mute someone for everyone, remove them from the squad or hand the lead to someone else. Any member can mute someone just for themselves, or report a player.',
  },
  {
    id: 'lobby_browse',
    topicAr: 'أكمل تصفح التطبيق وأنا في اللوبي',
    topicEn: 'Keep browsing the app while in the lobby',
    ar: 'تقدر تصغّر اللوبي وتكمل تصفح والمكالمة مستمرة، وترجع له من زرار "افتح اللوبي".',
    en: 'You can minimise the lobby and keep browsing while the call continues, then come back with the "Open lobby" button.',
  },
  {
    id: 'lobby_book_venue',
    topicAr: 'أحجز ملعب من جوه اللوبي',
    topicEn: 'Book a venue from inside the lobby',
    ar: 'من أدوات اللوبي فيه زرار "احجز ملعب" عشان تختاروا الملعب وإنتوا مع بعض.',
    en: 'The lobby tools have a "Book a venue" button so you can choose the venue together.',
    when: 'kiosk',
  },
  {
    id: 'lobby_morphs',
    topicAr: 'غيّر شكلك في اللوبي، الأشكال والكاركترز',
    topicEn: 'Change your look in the lobby, morphs and characters',
    ar: 'في اللوبي دوس "غيّر" وكاركترك يتحول لشكل مضحك عشوائي بتأثير. كل شكل بتحصل عليه بيبقى بتاعك للأبد في الخزانة، وتقدر ترجع تلبس أي شكل ملكته، وأصحابك بيشوفوه.',
    en: 'In the lobby tap "Change" and your character turns into a random funny shape with an effect. Every shape you get is yours for good in your wardrobe, you can switch back to any you own, and your friends see it.',
    when: 'morphs',
  },
  {
    id: 'lobby_move',
    topicAr: 'أتحرك بالكاركتر في اللوبي',
    topicEn: 'Moving your character around the lobby',
    ar: 'تقدر تمشّي الكاركتر في اللوبي: بالجويستيك على الموبايل، أو بأسهم الكيبورد وWASD أو بالضغط على المكان على الكمبيوتر، وفيه إيموجي سريعة تعبّر بيها.',
    en: 'You can walk your character around the lobby: with the joystick on a phone, or arrow keys, WASD or a click on a computer, and there are quick emotes to react with.',
    when: 'movement',
  },
  {
    id: 'lobby_ball',
    topicAr: 'كورة وجول في اللوبي',
    topicEn: 'The football and goals in the lobby',
    ar: 'في اللوبي كورة حقيقية: تلعبوها مع بعض وتسجلوا جول وتظهر احتفالية "جووول!" والنتيجة.',
    en: 'The lobby has a football you play together: score a goal and you get the "Goal!" celebration and the score.',
    when: 'ball',
  },
  {
    id: 'find_players',
    topicAr: 'ألاقي لاعبين أو أصحاب ألعب معاهم',
    topicEn: 'Finding players and friends to play with',
    ar: 'من صفحة اللاعبين تتصفح اللاعبين وتبعتلهم طلب صداقة، ولما يوافقوا تقدروا تفتحوا شات وتدعوهم للوبي.',
    en: 'From the players page you can browse players and send a friend request. Once they accept you can chat and invite them to the lobby.',
    cta: { target: 'app/players', labelAr: 'شوف اللاعبين', labelEn: 'See players' },
  },
  {
    id: 'community_chat',
    topicAr: 'المجتمع والفرق والشات',
    topicEn: 'Community, teams and chat',
    ar: 'في المجتمع بتلاقي الماتشات المفتوحة والناس اللي بتلعب نفس لعبتك، والشات جوه حسابك للتنسيق والاتفاق على الحجز.',
    en: 'The community has open matches and people who play your sport, and chat inside your account is for coordinating and agreeing on a booking.',
    cta: { target: 'app/community', labelAr: 'المجتمع', labelEn: 'Community' },
  },
  {
    id: 'for_owners',
    topicAr: 'أنا صاحب ملعب وعايز أضيف ملعبي',
    topicEn: 'I own a venue and want to list it',
    ar: 'ماتشنا ليها لوحة تحكم لأصحاب الملاعب: المواعيد والأسعار والفريق والإيرادات من مكان واحد. للانضمام كشريك افتح صفحة الشركاء.',
    en: 'Matchena has a dashboard for venue owners: calendar, prices, staff and earnings in one place. To join as a partner, open the partners page.',
    cta: { target: 'partners', labelAr: 'صفحة الشركاء', labelEn: 'Partners page' },
  },
];
