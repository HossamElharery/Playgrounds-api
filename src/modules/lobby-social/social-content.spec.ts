import { EGYPTIAN_SOCIAL_BANK } from './social.egyptian-bank';
import { SocialContentService, SocialQuestionDto } from './social-content.controller';
import { validate } from 'class-validator';

describe('Egyptian question editorial bank',()=>{
  it('contains sixty stable unique Egyptian drafts with twenty per mode',()=>{
    expect(EGYPTIAN_SOCIAL_BANK).toHaveLength(60);
    expect(new Set(EGYPTIAN_SOCIAL_BANK.map(q=>q.id)).size).toBe(60);
    for(const mode of ['light','stories','closer'])expect(EGYPTIAN_SOCIAL_BANK.filter(q=>q.mode===mode)).toHaveLength(20);
    expect(EGYPTIAN_SOCIAL_BANK.every(q=>q.locale==='ar-EG'&&q.status==='draft'&&q.reviewedAt===null&&q.text.length<=300)).toBe(true);
  });
  it('rejects unsupported modes/status and oversized content',async()=>{
    const dto=Object.assign(new SocialQuestionDto(),{text:'a'.repeat(301),mode:'unsafe',status:'anything',familyId:'bad family',tags:[],version:-1});
    expect((await validate(dto)).length).toBeGreaterThanOrEqual(5);
  });
  it('lists seed content with persistent edits taking precedence',async()=>{
    const edit={...EGYPTIAN_SOCIAL_BANK[0],text:'سؤال معدل من الأدمين',version:2};
    const db={$queryRaw:jest.fn().mockResolvedValue([{data:edit,version:2}])};
    const rows=await new SocialContentService(db as any).list();
    expect(rows).toHaveLength(60);expect(rows[0].text).toBe(edit.text);expect(rows[0].version).toBe(2);
  });
  it('rejects stale edits rather than overwriting another editor',async()=>{
    const tx={$executeRaw:jest.fn(),$queryRaw:jest.fn().mockResolvedValue([{version:3}])};
    const db={$transaction:async(fn:any)=>fn(tx)};
    await expect(new SocialContentService(db as any).save('EG001',{...EGYPTIAN_SOCIAL_BANK[0],version:1},'admin')).rejects.toThrow('Question changed');
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });
});
