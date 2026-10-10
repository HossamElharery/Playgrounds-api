import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EGYPTIAN_SOCIAL_BANK } from '../src/modules/lobby-social/social.egyptian-bank';

const names={light:'ضحك وخفيف',stories:'حكاوي ومواقف',closer:'نعرف بعض أكتر'};
const lines=['# البنك المصري الجديد: 60 سؤالًا','',
  '20 سؤالًا لكل مود. محتوى أصلي بصياغة مصرية، مسودة للمراجعة وليس اعتمادًا بشريًا.',
  'النشر والتعديل من لوحة الأدمين: /ar/admin/social-questions. تُحفظ التعديلات في قاعدة البيانات، ولا يتغير سؤال الجولة بعد كشفه.',
  '58 عائلة معنوية؛ سؤال ضياع الأشياء وسؤال الهاتف في عائلة واحدة، وكذلك المشوار الصغير الذي يتحول لخروجة.', ''];
for(const mode of ['light','stories','closer'] as const){
  lines.push(`## ${names[mode]}`,'','| الرقم | السؤال | الموضوع |','|---|---|---|');
  for(const q of EGYPTIAN_SOCIAL_BANK.filter(q=>q.mode===mode))lines.push(`| ${q.id} | ${q.text} | ${q.tags.join(', ')} |`);
  lines.push('');
}
writeFileSync(resolve('../../MATCHENA_LOBBY_SOCIAL_GAMES_PROMPTS/execution/EGYPTIAN_60_REVIEW.md'),lines.join('\n'));
console.log('Exported60 drafts for editorial review; no questions published.');
