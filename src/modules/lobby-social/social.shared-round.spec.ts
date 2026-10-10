import { applySocialCommand, createSocialState, socialSnapshot, tickSocialState } from './social.engine';
import { SOCIAL_QUESTIONS } from './social.questions';
import { SocialCommand, SocialState } from './social.types';

describe('Shared question rounds', () => {
  let s: SocialState;
  let now: number;
  const act = (id: string, action: string, extra: Partial<SocialCommand> = {}) => applySocialCommand(s,id,{squadId:'room',requestId:`${id}-${now}`,action,...extra},SOCIAL_QUESTIONS,[],now);
  const reveal = () => { act('a','start'); now+=900; tickSocialState(s,now); };
  beforeEach(()=>{
    now=100000;s=createSocialState('room','a',{squadId:'room',requestId:'new',action:'create',game:'cards'},now);
    act('b','join',{role:'player'});act('c','join',{role:'player'});act('d','join',{role:'listener'});
  });
  it('reveals one question for everyone and includes the drawer in the answer order',()=>{
    act('a','start');expect(s.phase).toBe('revealing');
    expect(socialSnapshot(s,'room','a',now).session!.question).toBeNull();
    now+=900;tickSocialState(s,now);
    expect(s.cardRound!.order).toEqual(['a','b','c']);expect(s.targetId).toBe('a');
    for(const id of ['a','b','c','d',''])expect(socialSnapshot(s,'room',id,now).session!.question?.id).toBe(s.question!.id);
    expect(socialSnapshot(s,'room','b',now).personal.allowed).not.toContain('finish');
  });
  it('keeps the same question across answers and passes, then leaves it up for discussion',()=>{
    reveal();const id=s.question!.id;act('a','finish');act('b','skip');
    expect(s.question!.id).toBe(id);expect(s.targetId).toBe('c');expect(s.completed).toBe(0);
    expect(()=>act('b','finish')).toThrow('not_allowed');act('c','finish');
    expect(s.phase).toBe('discussion');expect(s.completed).toBe(1);
    expect(socialSnapshot(s,'room','a',now).session!.question!.id).toBe(id);
    expect(s.cardRound!.responses).toEqual({a:'answered',b:'passed',c:'answered'});
    act('a','advance');expect(s.actorId).toBe('b');expect(s.targetId).toBe('b');expect(s.question!.id).not.toBe(id);
  });
  it('lets the host pass an AFK speaker with a reason while preserving everybody else’s answers',()=>{
    reveal();const id=s.question!.id;act('a','finish');
    expect(()=>act('c','override',{text:'بعيد عن الجهاز'})).toThrow('not_allowed');
    expect(()=>act('a','override',{text:''})).toThrow('reason_required');
    act('a','override',{text:'بعيد عن الجهاز'});expect(s.targetId).toBe('c');expect(s.question!.id).toBe(id);
    expect(s.cardRound!.responses).toEqual({a:'answered',b:'passed'});act('c','finish');expect(s.completed).toBe(1);
  });
  it('does not skip uncompleted participants when the host asks for the next question',()=>{
    reveal();expect(()=>act('a','advance')).toThrow();expect(s.completed).toBe(0);
  });
  it('leaves late joiners watching the current question and includes them next round',()=>{
    reveal();act('e','join',{role:'player'});expect(s.cardRound!.order).not.toContain('e');
    expect(socialSnapshot(s,'room','e',now).session!.members.find(m=>m.userId==='e')!.waiting).toBe(true);
    for(const id of ['a','b','c'])act(id,'finish');act('a','advance');expect(s.cardRound!.order).toContain('e');
  });
  it('continues the same question when the current speaker leaves and transfers the host',()=>{
    reveal();const id=s.question!.id;act('a','leave');expect(s.hostId).toBe('b');expect(s.targetId).toBe('b');expect(s.question!.id).toBe(id);
    act('b','finish');act('c','finish');expect(s.phase).toBe('discussion');expect(s.completed).toBe(1);
  });
  it('continues after a future speaker becomes a listener without resetting the current turn',()=>{
    reveal();act('c','listen');expect(s.targetId).toBe('a');act('a','finish');act('b','finish');expect(s.phase).toBe('discussion');
  });
  it('keeps disconnected speaker grace, then passes only their turn',()=>{
    reveal();s.members.find(m=>m.userId==='a')!.disconnectedAt=now;
    expect(socialSnapshot(s,'room','a',now).personal.allowed).not.toContain('finish');
    now+=30001;act('b','pulse');act('c','pulse');tickSocialState(s,now);
    expect(s.targetId).toBe('b');expect(s.phase).toBe('answering');expect(s.cardRound!.responses.a).toBe('passed');
  });
  it('excludes question families seen by any player, not just the drawer',()=>{
    const q=SOCIAL_QUESTIONS.find(q=>q.mode==='light')!;
    applySocialCommand(s,'a',{squadId:'room',requestId:'draw',action:'start'},[q],[{userId:'c',familyId:q.familyId,count:1}],now);
    expect(s.phase).toBe('no_eligible_content');
  });
  it('returns defensive public progress without any private state',()=>{
    reveal();const view=socialSnapshot(s,'room','b',now);view.session!.cardRound!.order.push('fake');
    view.session!.cardRound!.responses.a='answered';expect(s.cardRound!.order).not.toContain('fake');expect(s.cardRound!.responses.a).toBeUndefined();
  });
});
