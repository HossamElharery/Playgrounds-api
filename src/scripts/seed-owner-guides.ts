/**
 * Venue-owner guides for the Matchena blog, written to rank for owner searches
 * ("إدارة ملعب كورة", "تسعير الملاعب", "سيستم بلايستيشن") and to link into /partners.
 *
 * Creates each article as a DRAFT so an admin reads it and presses Publish in the CMS
 * (publishing pings IndexNow). Existing posts are never touched unless --update is passed,
 * and even then a published post is left alone.
 *
 *   npx ts-node src/scripts/seed-owner-guides.ts            # create missing drafts
 *   npx ts-node src/scripts/seed-owner-guides.ts --update   # also refresh unpublished drafts
 */
import { PrismaClient } from '../generated/prisma';

interface Guide {
  slug: string;
  titleAr: string;
  titleEn: string;
  subtitleAr: string;
  subtitleEn: string;
  seoTitleAr: string;
  seoTitleEn: string;
  seoDescriptionAr: string;
  seoDescriptionEn: string;
  keywordsAr: string;
  keywordsEn: string;
  relatedSportSlug: string | null;
  ctaHref: string;
  ctaLabelAr: string;
  ctaLabelEn: string;
  contentAr: string;
  contentEn: string;
}

const GUIDES: Guide[] = [
  {
    slug: 'manage-football-pitch-bookings-without-notebook',
    titleAr: 'إزاي تدير حجوزات ملعب الكورة من غير دفتر: دليل عملي',
    titleEn: 'How to run football pitch bookings without a notebook',
    subtitleAr:
      'من الحجز المكرر للخزنة الناقصة: خطوات بسيطة تنظّم ملعبك من الأسبوع ده.',
    subtitleEn:
      'From double bookings to a short cash drawer: simple steps that organise your pitch this week.',
    seoTitleAr: 'إدارة حجوزات ملعب الكورة من غير دفتر | دليل لأصحاب الملاعب',
    seoTitleEn: 'Run Football Pitch Bookings Without a Notebook | Owner Guide',
    seoDescriptionAr:
      'دليل عملي لأصحاب ملاعب الكورة الخماسي والسباعي: إزاي تمنع الحجز المكرر، تنظم الفرق الثابتة، وتظبط الخزنة كل يوم.',
    seoDescriptionEn:
      'A practical guide for five- and seven-a-side pitch owners: stop double bookings, organise regular teams and balance the cash drawer daily.',
    keywordsAr:
      'إدارة ملعب كورة, حجز ملاعب, سيستم حجز ملاعب, ملعب خماسي, دفتر الحجز',
    keywordsEn:
      'football pitch management, pitch booking system, five-a-side, booking notebook',
    relatedSportSlug: 'football',
    ctaHref: '/partners/football',
    ctaLabelAr: 'جرّب سيستم ملاعب الكورة 30 يوم ببلاش',
    ctaLabelEn: 'Try the football pitch system free for 30 days',
    contentAr: `
<p>أغلب ملاعب الكورة في مصر لسه بتشتغل بدفتر على الشباك وموبايل صاحب الملعب. ده بيمشي لحد ما الملعب يبقى عليه ضغط: فريقين يوصلوا لنفس الميعاد، فلوس مش متسجلة، وساعات فاضية محدش واخد باله منها. الدليل ده بيقولك تنظّم الشغل إزاي خطوة بخطوة، بسيستم أو من غيره.</p>
<h2>1. خلّي فيه مكان واحد بس للحجز</h2>
<p>أكبر سبب للحجز المكرر إن الحجز بيتسجل في أكتر من مكان: الدفتر، وشات الواتساب، وورقة مع الموظف. اتفق مع فريقك إن أي حجز مالوش وجود إلا لو اتسجل في الجدول الواحد. لو بتستخدم سيستم، خلي حجوزات التليفون والشباك تتسجل فيه في ساعتها، مش آخر اليوم.</p>
<h2>2. افصل الفرق الثابتة عن الحجز اليومي</h2>
<p>الفريق اللي بيلعب كل أسبوع في نفس الميعاد هو أهم زبون عندك. سجّله كحجز ثابت أسبوعي مرة واحدة، وحدد هتعمل إيه لو اعتذر أسبوع. كده الميعاد ما يتباعش بالغلط لحد تاني، وانت عارف إيرادك الثابت في الشهر.</p>
<h2>3. سعّر الساعة حسب وقتها</h2>
<p>ساعة 10 بالليل غير ساعة 2 الضهر. حط سعر للفترة الزحمة وسعر أقل للفترة الهادية، وخلي الأسعار مكتوبة وواضحة للزباين. ده بيقلل الفصال وبيملا الساعات اللي كانت بتضيع.</p>
<h2>4. العربون مش رفاهية</h2>
<p>الحجز من غير عربون بيشجع على الغياب. اطلب عربون في الأوقات الزحمة، وسجّل كل حجز اتعمل وما حضرش. لما تلاقي نفس الشخص اتكرر، اطلب منه العربون المرة الجاية من غير إحراج.</p>
<h2>5. الخزنة تتقفل كل شيفت</h2>
<p>خلي كل موظف يفتح شيفت ويقفله بالمبلغ اللي معاه، ويسلّم الخزنة للي بعده. أي فرق هيبان في نفس اليوم، مش آخر الشهر لما يبقى صعب تعرف حصل إيه.</p>
<h2>6. اعرف ربحك الحقيقي</h2>
<p>الإيراد مش هو الربح. سجّل الكهربا والمرتبات والصيانة ونجيلة الملعب، واطرحها من الإيراد كل شهر. هتعرف ساعتها أنهي ملعب بيكسب فعلًا وأنهي فترة محتاجة عرض.</p>
<h2>تبدأ منين؟</h2>
<p>ابدأ بالخطوة الأولى بس: جدول واحد للكل. بعدها ضيف الحجز الثابت، وبعدها الخزنة. ولو عايز كل ده جاهز في مكان واحد، <a href="/ar/partners/football">سيستم ماتشنا لملاعب الكورة</a> بيعمل الجدول والحجز الثابت والعربون والخزنة والتقارير، وتقدر تجرّبه ببلاش وتشوف <a href="/ar/partners/pricing">الأسعار</a> قبل ما تقرر.</p>
`.trim(),
    contentEn: `
<p>Most football pitches in Egypt still run on a desk notebook and the owner's phone. That works until the pitch gets busy: two teams arrive for the same slot, cash goes unrecorded and empty hours go unnoticed. This guide shows how to organise the work step by step, with or without a system.</p>
<h2>1. Keep one place for bookings</h2>
<p>Double bookings happen when bookings live in several places: the notebook, a WhatsApp chat and a note in a staff member's pocket. Agree with your team that a booking does not exist until it is on the one calendar. If you use a system, log phone and walk-in bookings in it straight away, not at closing.</p>
<h2>2. Separate regular teams from daily bookings</h2>
<p>The team that plays every week at the same time is your best customer. Book them once as a fixed weekly slot and decide what happens when they skip a week. The slot never gets sold by mistake, and you know your steady monthly income.</p>
<h2>3. Price the hour by its time</h2>
<p>10 pm is not 2 pm. Set a price for busy hours and a lower one for quiet hours, and keep prices visible. It cuts haggling and fills hours that used to go empty.</p>
<h2>4. Deposits are not a luxury</h2>
<p>Bookings without a deposit invite no-shows. Ask for a deposit at peak times and record every booking that never showed. When the same name repeats, asking them for a deposit next time is easy.</p>
<h2>5. Close the drawer every shift</h2>
<p>Have each staff member open and close a shift with the amount they hold, and hand the drawer to the next person. Any gap shows the same day, not at month end when nobody remembers what happened.</p>
<h2>6. Know your real profit</h2>
<p>Revenue is not profit. Log power, salaries, upkeep and turf, and take them off revenue each month. You will see which pitch really earns and which hours need an offer.</p>
<h2>Where to start</h2>
<p>Start with step one: one calendar for everyone. Then add fixed slots, then the drawer. If you want all of it in one place, the <a href="/en/partners/football">Matchena football pitch system</a> covers the calendar, fixed slots, deposits, cash shifts and reports, and you can try it free and check the <a href="/en/partners/pricing">pricing</a> first.</p>
`.trim(),
  },
  {
    slug: 'reduce-no-shows-at-your-sports-venue',
    titleAr: 'إزاي تقلل الغياب في ملعبك: العربون والتذكير وسجل الحجوزات',
    titleEn: 'How to cut no-shows at your sports venue',
    subtitleAr:
      'الساعة اللي اتحجزت وما حدش جه فلوس ضايعة مرتين. دي أدوات بسيطة تقلّلها.',
    subtitleEn:
      'A booked hour nobody turns up for is lost twice. Simple tools to make it rarer.',
    seoTitleAr: 'تقليل الغياب في الملاعب: العربون والتذكير | ماتشنا',
    seoTitleEn: 'Cut No-Shows at Your Sports Venue | Matchena',
    seoDescriptionAr:
      'نصايح عملية لأصحاب ملاعب الكورة والبادل: إزاي العربون والتذكير قبل الميعاد وسجل الغياب يقللوا الحجوزات اللي ما بتحضرش.',
    seoDescriptionEn:
      'Practical advice for football and padel venue owners: how deposits, reminders and a no-show record cut bookings that never turn up.',
    keywordsAr: 'غياب الحجوزات, عربون حجز ملعب, تذكير الحجز, إدارة ملاعب',
    keywordsEn:
      'no-shows, booking deposit, booking reminders, venue management',
    relatedSportSlug: null,
    ctaHref: '/partners',
    ctaLabelAr: 'شوف إزاي ماتشنا بيقلل الغياب',
    ctaLabelEn: 'See how Matchena cuts no-shows',
    contentAr: `
<p>الحجز اللي ما بيحضرش بيكلّفك مرتين: الساعة نفسها، والزبون التاني اللي كان عايزها واترفض. ومع الوقت الغياب بيتحول لعادة لو مفيش حاجة بتمنعه. دي أهم الأدوات اللي بتقلله.</p>
<h2>العربون في الأوقات الزحمة</h2>
<p>مش لازم تطلب عربون على كل حجز. ابدأ بالأوقات اللي عليها طلب: بالليل والويك إند. مبلغ صغير بيفرق جدًا في التزام الناس، وسجّله دايمًا مع الحجز عشان الباقي يتحسب صح على الملعب.</p>
<h2>التذكير قبل الميعاد</h2>
<p>ناس كتير بتغيب لأنها نسيت، مش لأنها مش عايزة تيجي. رسالة تذكير قبل الميعاد بوقت كافي بتدي الفرصة إنهم يعتذروا بدري، وانت تبيع الساعة لحد تاني.</p>
<h2>سجل باللي ما بيحضروش</h2>
<p>علّم كل حجز ما حضرش. بعد شهر هتلاقي أسماء بتتكرر. دول اطلب منهم عربون أو دفع كامل قبل الميعاد، والباقي عاملهم عادي. كده بتحمي نفسك من غير ما تضايق زباينك الملتزمين.</p>
<h2>سياسة إلغاء مكتوبة</h2>
<p>اكتب سياسة واضحة: لحد إمتى ممكن يلغي ويرجع العربون، وإمتى لأ. لما تبقى معلنة من الأول، الكلام فيها بيبقى أسهل بكتير.</p>
<h2>املا الساعة اللي اتلغت</h2>
<p>لما حد يعتذر، الساعة لازم تظهر فاضية في نفس اللحظة لكل اللي بيدوّر. ده اللي بيفرق بين ساعة ضاعت وساعة اتباعت تاني.</p>
<p>لو حابب الأدوات دي كلها في مكان واحد، <a href="/ar/partners">سيستم ماتشنا للملاعب</a> فيه العربون وتذكير الحجز وتعليم الغياب، والملعب بيظهر للاعيبة اللي بتدوّر على ماتشنا.</p>
`.trim(),
    contentEn: `
<p>A booking that never turns up costs you twice: the hour itself, and the player you turned away who wanted it. Left alone, no-shows become a habit. These are the tools that cut them.</p>
<h2>Deposits at busy times</h2>
<p>You do not need a deposit on every booking. Start with the hours in demand: evenings and weekends. A small amount changes commitment a lot. Always record it with the booking so the balance is right at the pitch.</p>
<h2>Reminders before the slot</h2>
<p>Many people miss a slot because they forgot, not because they did not want to come. A reminder well ahead gives them the chance to cancel early so you can resell the hour.</p>
<h2>A record of who does not show</h2>
<p>Mark every booking that never showed. After a month the same names repeat. Ask those players for a deposit or full payment upfront and treat everyone else as usual. You protect yourself without bothering reliable customers.</p>
<h2>A written cancellation policy</h2>
<p>Write a clear policy: until when someone can cancel and get the deposit back, and when not. Published upfront, it makes the conversation much easier.</p>
<h2>Refill the cancelled hour</h2>
<p>When someone cancels, the hour should show as free at once to everyone looking. That is the difference between a lost hour and a resold one.</p>
<p>If you want these tools in one place, the <a href="/en/partners">Matchena venue system</a> covers deposits, booking reminders and no-show marking, and your venue shows to players searching on Matchena.</p>
`.trim(),
  },
  {
    slug: 'how-to-price-pitch-hours-peak-and-quiet',
    titleAr:
      'تسعير الملاعب: إزاي تحدد سعر الساعة بالليل والنهار وتملا الساعات الفاضية',
    titleEn: 'Pricing pitch hours: peak, quiet and everything between',
    subtitleAr:
      'سعر واحد طول اليوم بيخسرك في الزحمة وفي الهدوء. ده إزاي تبني جدول أسعار يملا ملعبك.',
    subtitleEn:
      'One price all day loses money at both ends. How to build a price table that fills your venue.',
    seoTitleAr: 'تسعير ساعة الملعب بالليل والنهار | دليل لأصحاب الملاعب',
    seoTitleEn: 'How to Price Pitch Hours: Peak and Quiet | Owner Guide',
    seoDescriptionAr:
      'إزاي تسعّر ساعة ملعب الكورة أو البادل حسب الوقت، وتستخدم العروض على الساعات الهادية عشان تزود الإشغال من غير ما تحرق سعرك.',
    seoDescriptionEn:
      'How to price football or padel hours by time of day and use offers on quiet hours to raise occupancy without cheapening your venue.',
    keywordsAr: 'تسعير الملاعب, سعر ساعة الملعب, إشغال الملعب, عروض الملاعب',
    keywordsEn: 'pitch pricing, court hourly price, occupancy, off-peak offers',
    relatedSportSlug: null,
    ctaHref: '/partners/pricing',
    ctaLabelAr: 'شوف باقات سيستم ماتشنا',
    ctaLabelEn: 'See Matchena venue plans',
    contentAr: `
<p>لو سعر ساعة ملعبك واحد طول اليوم، فانت غالبًا بتبيع الساعة الزحمة أرخص من قيمتها، والساعة الهادية أغلى من إن حد يحجزها. جدول أسعار بسيط بيحل المشكلتين.</p>
<h2>قسّم اليوم لفترات</h2>
<p>بص على حجوزات آخر شهر وقسّم اليوم لتلات فترات: زحمة (غالبًا بعد المغرب)، ومتوسطة، وهادية (الصبح وبدري الضهر). وافصل الويك إند لوحده لأنه بيتصرف بشكل مختلف.</p>
<h2>الفترة الزحمة: سعرك الكامل</h2>
<p>الساعات اللي بتتباع دايمًا ما تحتاجش خصم. لو بتتحجز قبلها بأيام، ده معناه إنك ممكن تزوّد السعر شوية من غير ما تخسر حجوزات.</p>
<h2>الفترة الهادية: عرض محدد مش تخفيض عام</h2>
<p>بدل ما تنزّل السعر كله، اعمل عرض على ساعات بعينها: يوم معين وساعات معينة وكود خصم. كده بتجيب ناس جديدة للساعة الفاضية من غير ما تعوّد زباين الليل على سعر أقل.</p>
<h2>قيس النتيجة</h2>
<p>قبل العرض اكتب إشغال الساعات دي كام، وبعد أسبوعين قارن. لو الإشغال زاد والإيراد زاد، ثبّت العرض. لو لأ، غيّره أو شيله.</p>
<h2>سعر لكل ملعب</h2>
<p>الملعب الجديد أو البانورامي أو المغطى يستاهل سعر مختلف. ما تخليش كل الملاعب بنفس السعر لمجرد السهولة.</p>
<p><a href="/ar/partners">سيستم ماتشنا للملاعب</a> بيخليك تحط سعر لكل فترة ولكل ملعب، ويوريك الساعات اللي دايمًا فاضية عشان تعمل عليها عرض وتقيس نتيجته. وتقدر تشوف <a href="/ar/partners/pricing">أسعار الباقات</a> وتحسب السيستم بيرجّع تمنه في كام ساعة.</p>
`.trim(),
    contentEn: `
<p>If your hourly price is the same all day, you are probably selling peak hours below their value and quiet hours above what anyone will pay. A simple price table fixes both.</p>
<h2>Split the day into bands</h2>
<p>Look at last month's bookings and split the day into three bands: peak (usually after sunset), mid and quiet (mornings and early afternoon). Treat the weekend separately, it behaves differently.</p>
<h2>Peak: your full price</h2>
<p>Hours that always sell do not need a discount. If they are booked days ahead, you can likely raise the price a little without losing bookings.</p>
<h2>Quiet: a targeted offer, not a general cut</h2>
<p>Instead of lowering every price, put an offer on specific hours: a given day, given hours and a promo code. You bring new players into empty hours without teaching evening regulars to expect less.</p>
<h2>Measure the result</h2>
<p>Write down occupancy for those hours before the offer and compare after two weeks. If occupancy and revenue rose, keep it. If not, change it or drop it.</p>
<h2>A price per court</h2>
<p>A new, panoramic or covered court deserves its own price. Do not price every court the same just because it is easier.</p>
<p>The <a href="/en/partners">Matchena venue system</a> lets you set prices per band and per court and shows the hours that always sit empty so you can put an offer on them and measure it. See the <a href="/en/partners/pricing">plans</a> and work out how many hours pay for the system.</p>
`.trim(),
  },
  {
    slug: 'playstation-lounge-management-guide',
    titleAr: 'دليل إدارة محل البلايستيشن: الوقت والكافيتريا والخزنة',
    titleEn: 'Running a PlayStation lounge: time, café and cash',
    subtitleAr:
      'إزاي تحسب وقت كل جهاز صح، وتربط الطلبات بالفاتورة، وتعرف فلوس كل شيفت.',
    subtitleEn:
      'How to time every device right, put orders on the bill and know each shift’s takings.',
    seoTitleAr: 'إدارة محل بلايستيشن: الوقت والكافيتريا والخزنة | ماتشنا',
    seoTitleEn: 'PlayStation Lounge Management Guide | Matchena',
    seoDescriptionAr:
      'دليل لأصحاب محلات البلايستيشن والبلياردو: حساب وقت الأجهزة، سعر السينجل والمالتي، طلبات الكافيتريا، والخزنة بين الشيفتات.',
    seoDescriptionEn:
      'A guide for PlayStation and billiards lounge owners: timing devices, single and multi rates, café orders and the cash drawer between shifts.',
    keywordsAr:
      'سيستم بلايستيشن, إدارة محل بلايستيشن, كافيه بلايستيشن, برنامج بلايستيشن',
    keywordsEn:
      'PlayStation lounge system, gaming lounge management, billiards hall',
    relatedSportSlug: 'playstation',
    ctaHref: '/partners/gaming',
    ctaLabelAr: 'جرّب سيستم البلايستيشن',
    ctaLabelEn: 'Try the gaming lounge system',
    contentAr: `
<p>محل البلايستيشن شغله كله دقايق وفكة: جهاز بدأ إمتى، اتحول مالتي إمتى، الشاي اتحسب ولا لأ. الغلط الصغير بيتكرر كل يوم، وفي آخر الشهر بيبقى مبلغ كبير. دي طريقة تنظيم بسيطة.</p>
<h2>وقت كل جهاز يتسجل في ساعتها</h2>
<p>ما تعتمدش على الذاكرة أو ورقة على الترابيزة. كل جلسة تبدأ وتقفل في مكان واحد، وحدد طريقة الحساب: بالدقيقة، ولا بأقل مدة، ولا بشرايح (كل ربع ساعة مثلًا). المهم إنها تبقى ثابتة ومعلنة.</p>
<h2>سينجل ومالتي بسعرين</h2>
<p>اللعب المالتي على نفس الجهاز ليه سعر مختلف. اتفق مع الزبون في الأول، وخلي السعر يتحسب على نوع الجلسة.</p>
<h2>الكافيتريا على نفس الفاتورة</h2>
<p>أكتر فلوس بتضيع في محلات البلايستيشن هي المشروبات اللي ما اتسجلتش. خلي كل طلب ينزل على فاتورة الجهاز في ساعتها، وتابع المخزون عشان تعرف المبيعات الحقيقية.</p>
<h2>إيصال لكل فاتورة</h2>
<p>الإيصال المطبوع بيقفل باب الخلاف مع الزبون، وبيخلي الموظف يسجل كل حاجة. طابعة حرارية صغيرة كفاية.</p>
<h2>الخزنة بين الشيفتات</h2>
<p>كل موظف يقفل شيفته بالمبلغ ويسلّم للي بعده. لو فيه فرق يبان في ساعتها.</p>
<p><a href="/ar/partners/gaming">سيستم ماتشنا لصالات البلايستيشن</a> فيه تايمر لكل جهاز، وسعر سينجل ومالتي، وطلبات الكافيتريا على الفاتورة، وإيصال مطبوع، وخزنة لكل شيفت، والباقات بتبدأ من 300 جنيه في الشهر.</p>
`.trim(),
    contentEn: `
<p>A PlayStation lounge runs on minutes and small change: when a device started, when it went multiplayer, whether the tea was charged. Small mistakes repeat every day and add up to a lot by month end. Here is a simple way to stay organised.</p>
<h2>Log each device's time as it happens</h2>
<p>Do not rely on memory or a note on the table. Every session starts and ends in one place, with a clear billing rule: by the minute, with a minimum, or in steps such as every fifteen minutes. Keep it fixed and posted.</p>
<h2>Two rates: single and multi</h2>
<p>Multiplayer on the same device has its own price. Agree it upfront and bill each session at its own rate.</p>
<h2>Café orders on the same bill</h2>
<p>Unrecorded drinks are where lounges lose the most money. Put every order on the device bill straight away and track stock so you know real sales.</p>
<h2>A receipt for every bill</h2>
<p>A printed receipt ends arguments with customers and makes staff record everything. A small thermal printer is enough.</p>
<h2>The drawer between shifts</h2>
<p>Each staff member closes their shift by amount and hands over to the next. Any gap shows immediately.</p>
<p>The <a href="/en/partners/gaming">Matchena gaming lounge system</a> has a timer per device, single and multi rates, café orders on the bill, printed receipts and a drawer per shift, with plans from EGP 300 a month.</p>
`.trim(),
  },
];

async function main(): Promise<void> {
  const update = process.argv.includes('--update');
  const prisma = new PrismaClient();
  try {
    const category = await prisma.blogCategory.upsert({
      where: { id: 'blog-cat-owners' },
      update: {},
      create: {
        id: 'blog-cat-owners',
        nameEn: 'For venue owners',
        nameAr: 'لأصحاب الملاعب',
      },
    });
    for (const guide of GUIDES) {
      const existing = await prisma.blogPost.findUnique({
        where: { slug: guide.slug },
      });
      const data = { ...guide, categoryId: category.id };
      if (!existing) {
        await prisma.blogPost.create({ data: { ...data, status: 'draft' } });
        console.log(`created draft  ${guide.slug}`);
      } else if (update && existing.status !== 'published') {
        await prisma.blogPost.update({ where: { id: existing.id }, data });
        console.log(`updated draft  ${guide.slug}`);
      } else {
        console.log(`kept as is     ${guide.slug} (${existing.status})`);
      }
    }
    console.log('Review and publish them from Admin → CMS → Blog.');
  } finally {
    await prisma.$disconnect();
  }
}

void main();
