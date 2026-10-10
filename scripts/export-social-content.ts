import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {SOCIAL_QUESTIONS} from '../src/modules/lobby-social/social.questions';

const output=resolve('../../MATCHENA_LOBBY_SOCIAL_GAMES_PROMPTS/execution');
mkdirSync(output,{recursive:true});
const json=JSON.stringify({version:1,locale:'ar-EG',humanReviewedBy:null,humanReviewedAt:null,questions:SOCIAL_QUESTIONS},null,2);
const checksum=createHash('sha256').update(json).digest('hex');
writeFileSync(resolve(output,'QUESTIONS_REVIEW.json'),json+'\n');
const names={light:'ضحك وخفيف',stories:'حكاوي ومواقف',closer:'نعرف بعض أكتر'};
const lines=['# بنك أسئلة القعدة للمراجعة','',
  '180 سؤالًا أصليًا، 60 لكل مود، و179 عائلة معنوية. الأسئلة Q001–Q060 محفوظة من الحزمة الأصلية.',
  'كل الأسئلة مسودات. جرت مراجعة آلية وتحريرية بواسطة المساعد للعدد، اللغة، التنوع، والسلامة؛ لم تجر مراجعة بشرية ولا اعتماد نشر.',
  'لا يوجد توليد أسئلة أثناء اللعب. تاريخ المشاهدة وعائلة السؤال يمنعان التكرار.',
  'تم جمع سؤال اكتشاف الموهبة مع عائلة الموهبة الصغيرة احترازيًا لتجنب تكرار الفكرة بعد تغيير المود.',
  '',`SHA-256 لملف JSON المرفق: \`${checksum}\``, '',
  '## المطلوب من المراجع البشري','',
  '- قراءة الصياغة المصرية والسياق، وتعديل أي سؤال غير طبيعي أو غير مناسب.',
  '- مراجعة التشابه المعنوي بين العائلات، وخاصة الأسئلة عن الصدف والتعلم والعادات والراحة.',
  '- تدوين اسم المراجع والتاريخ والأسئلة المعتمدة قبل تحويلها إلى published في المصدر.',
  '- إبقاء التخطي بلا عقوبة والموافقة الواضحة على المود الأعمق.', ''];
for(const mode of ['light','stories','closer'] as const) {
  lines.push(`## ${names[mode]}`,'','| ID | العائلة | الموضوع | السؤال |','|---|---|---|---|');
  for(const q of SOCIAL_QUESTIONS.filter(q=>q.mode===mode))lines.push(`| ${q.id} | ${q.familyId} | ${q.tags.join(', ')} | ${q.text.replace(/\|/g,'/')} |`);
  lines.push('');
}
writeFileSync(resolve(output,'CONTENT_REVIEW.md'),lines.join('\n'));
console.log(`Exported ${SOCIAL_QUESTIONS.length} draft questions in ${new Set(SOCIAL_QUESTIONS.map(q=>q.familyId)).size} families; human approval remains pending.`);
