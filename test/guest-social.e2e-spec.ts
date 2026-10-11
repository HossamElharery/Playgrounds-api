const url=process.env.TEST_DATABASE_URL??'';
const parsed=new URL(url);
if(!['localhost','127.0.0.1'].includes(parsed.hostname)||!/^\/matchena_guest_test_[a-z0-9_]+$/.test(parsed.pathname))throw new Error('Dedicated local guest test database required');
process.env.DATABASE_URL=url;
import { randomUUID } from 'crypto';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { AuthService } from '../src/modules/auth/auth.service';
describe('Social guest promotion on PostgreSQL',()=>{
 const db=new PrismaService(),service=new AuthService(db,{} as never,{} as never,{} as never,{} as never,{} as never);
 const promote=(guestUserId:string,providerUserId:string,email?:string)=>(service as any).findOrCreateOAuthUser({provider:'google',providerUserId,guestUserId,email,name:'Permanent player',avatarUrl:'provider-avatar'});
 const guest=()=>db.user.create({data:{name:'Guest',isGuest:true,roles:['player'],avatarUrl:'guest-avatar'}});
 afterAll(()=>db.$disconnect());
 it('keeps squad membership and wardrobe, promotes once, and accepts an exact retry',async()=>{
  const u=await guest(),squad=await db.squad.create({data:{}}),provider=randomUUID();
  await db.squadMember.create({data:{squadId:squad.id,userId:u.id,isLeader:true}});
  await db.userMorphProfile.create({data:{userId:u.id,equippedMorphId:'robot',totalRolls:2}});
  await db.userMorph.create({data:{userId:u.id,morphId:'robot',source:'ROLL'}});
  const result=await promote(u.id,provider,'player-'+randomUUID()+'@example.test');
  expect(result.id).toBe(u.id);expect(result.isGuest).toBe(false);expect(result.avatarUrl).toBe('guest-avatar');expect(result.emailVerifiedAt).toBeTruthy();
  expect(await db.squadMember.count({where:{squadId:squad.id,userId:u.id}})).toBe(1);expect((await db.userMorphProfile.findUniqueOrThrow({where:{userId:u.id}})).equippedMorphId).toBe('robot');expect(await db.userMorph.count({where:{userId:u.id}})).toBe(1);
  expect((await promote(u.id,provider)).id).toBe(u.id);expect(await db.oAuthIdentity.count({where:{userId:u.id}})).toBe(1);
 });
 it('does not switch the guest into someone else’s existing social account',async()=>{
  const original=await guest(),other=await db.user.create({data:{name:'Existing player',roles:['player']}}),provider=randomUUID();await db.oAuthIdentity.create({data:{userId:other.id,provider:'google',providerUserId:provider}});
  await expect(promote(original.id,provider)).rejects.toMatchObject({status:409});expect((await db.user.findUniqueOrThrow({where:{id:original.id}})).isGuest).toBe(true);expect(await db.oAuthIdentity.count({where:{userId:original.id}})).toBe(0);
 });
 it('serializes competing promotions without creating an extra identity',async()=>{
  const u=await guest(),results=await Promise.allSettled([promote(u.id,randomUUID()),promote(u.id,randomUUID())]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await db.oAuthIdentity.count({where:{userId:u.id}})).toBe(1);expect((await db.user.findUniqueOrThrow({where:{id:u.id}})).isGuest).toBe(false);
 });
});
