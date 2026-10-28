const dbUrl=process.env.TEST_DATABASE_URL??'';
const parsed=new URL(dbUrl);
if(!['localhost','127.0.0.1'].includes(parsed.hostname)||!/^\/matchena_gaming_test_[a-z0-9_]+$/.test(parsed.pathname))throw new Error('Dedicated local gaming database required');
process.env.DATABASE_URL=dbUrl;
import { randomUUID } from 'crypto';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { GamingCommandService } from '../src/modules/owner/gaming/gaming-command.service';
import { GamingSessionsService } from '../src/modules/owner/gaming/gaming-sessions.service';
import { CommissionService } from '../src/modules/finance/commission.service';
import { LedgerService } from '../src/modules/finance/ledger.service';
import { AuthenticatedUser } from '../src/common/types/authenticated-user.interface';
import { DeviceHubService } from '../src/modules/owner/gaming/devices/device-hub.service';
import { GamingDevicesService } from '../src/modules/owner/gaming/devices/gaming-devices.service';
import { ShellySimulator } from './support/shelly-simulator';
jest.setTimeout(120000);

async function until(check:()=>boolean|Promise<boolean>,label:string,ms=8000){
  const end=Date.now()+ms;
  while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,40));}
  throw new Error(`timed out waiting for: ${label}`);
}

describe('smart plugs follow gaming sessions (PostgreSQL + real WebSocket)',()=>{
  const db=new PrismaService();const commands=new GamingCommandService(db);const ledger=new LedgerService(db,new CommissionService(db,{} as never));
  let server:Server;let hub:DeviceHubService;let devices:GamingDevicesService;let sessions:GamingSessionsService;
  const notifications={create:jest.fn().mockResolvedValue(null)};
  let user:AuthenticatedUser;let venueId:string;let units:string[];let url:string;
  const sims:ShellySimulator[]=[];
  const key=()=>({venueId,requestKey:randomUUID()});
  const plug=async(id:string,opts:ConstructorParameters<typeof ShellySimulator>[1]={})=>{const sim=new ShellySimulator(id,opts);sims.push(sim);await sim.connect(url);await until(async()=>!!(await db.gamingDevice.findFirst({where:{externalId:id,online:true}})),`${id} registered`);return {sim,device:await db.gamingDevice.findFirstOrThrow({where:{externalId:id}})};};
  const lastSet=(sim:ShellySimulator)=>sim.calledWith('Switch.Set').at(-1)?.params;

  beforeAll(async()=>{
    await db.countryConfig.upsert({where:{code:'EG'},create:{code:'EG',nameAr:'مصر',nameEn:'Egypt',currency:'EGP',phoneCallingCode:'+20',timezone:'Africa/Cairo',weekendDays:[5,6],paymentMethods:['cash']},update:{}});
    const owner=await db.user.create({data:{name:'Devices fixture',phone:'+201099990077',roles:['owner']}});user={id:owner.id,name:owner.name,phone:owner.phone!,roles:['owner']};
    const sport=await db.sportCategory.create({data:{slug:'devices-fixture',nameAr:'ألعاب',nameEn:'Gaming',icon:'gamepad',accentColor:'#22cc88',activityKind:'gaming-station'}});
    const venue=await db.venue.create({data:{slug:'devices-fixture',nameAr:'محل الفيش',nameEn:'Plug test',ownerId:user.id,lat:30,lng:31,geohash:'sv8',status:'active',approvedAt:new Date(),gamingSessionsEnabled:true}});venueId=venue.id;
    units=[];for(let i=0;i<6;i++){const unit=await db.court.create({data:{venueId,sportId:sport.id,name:`PS5 ${i+1}`,gamingConfig:{consoleType:'ps5',seats:2,roomTier:'standard'},pricingRules:{create:{label:'base',daysOfWeek:[],startTime:'00:00',endTime:'24:00',priceAmount:12000,currency:'EGP'}}}});units.push(unit.id);}
    server=createServer((_req,res)=>{res.statusCode=404;res.end();});
    await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));
    const port=(server.address() as AddressInfo).port;
    hub=new DeviceHubService({httpAdapter:{getHttpServer:()=>server}} as never,db);hub.onApplicationBootstrap();
    devices=new GamingDevicesService(db,hub,commands,notifications as never,{get:(k:string,d?:unknown)=>k==='API_PUBLIC_URL'?`http://127.0.0.1:${port}`:d} as never);devices.onModuleInit();
    sessions=new GamingSessionsService(commands,ledger,hub);
    const overview=await devices.overview(user,venueId);
    url=overview.link.url;
  });
  afterAll(async()=>{sims.forEach(s=>s.close());hub.onApplicationShutdown();await new Promise(r=>server.close(()=>r(null)));await db.$disconnect();});

  it('builds a ws link for the venue and refuses unknown tokens',async()=>{
    expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/api\/v1\/gaming\/devices\/shelly\/[A-Za-z0-9_-]{32}$/);
    await expect(new ShellySimulator('shellyplugsg3-000000000bad').connect(url.replace(/[^/]+$/,'x'.repeat(32)))).rejects.toThrow('HTTP 401');
    await expect(new ShellySimulator('shellyplugsg3-000000000bad').connect(url.replace(/[^/]+$/,'short'))).rejects.toThrow('HTTP 404');
  });

  it('a new plug shows up unassigned and is never switched until it is linked to a station',async()=>{
    const {sim,device}=await plug('shellyplugsg3-aaaaaaaaaaa1',{output:true});
    expect(device).toMatchObject({venueId,unitId:null,model:'shellyplugsg3',output:true});
    await devices.reconcileVenue(venueId);
    expect(sim.calledWith('Switch.Set')).toHaveLength(0);
    const overview=await devices.overview(user,venueId);
    expect(overview.devices.find(d=>d.id===device.id)).toMatchObject({online:true,screenOn:true,unitId:null,settings:{enabled:true,guard:true,cutAtEnd:true,graceMinutes:2}});
  });

  it('linking a plug makes power-loss safe and switches an idle screen off (guard)',async()=>{
    const device=await db.gamingDevice.findFirstOrThrow({where:{externalId:'shellyplugsg3-aaaaaaaaaaa1'}});const sim=sims[0];
    await devices.update(user,device.id,{...key(),unitId:units[0],name:'TV 1'});
    await until(()=>sim.output===false,'idle screen off');
    expect(sim.initialState).toBe('off');
    expect(lastSet(sim)).toEqual({id:0,on:false});
  });

  it('a timed session turns the screen on with an on-device off timer; extend moves it; end turns it off',async()=>{
    const sim=sims[0];
    const s=await sessions.start(user,{...key(),unitId:units[0],startMode:'now',durationMinutes:30});
    await until(()=>sim.output===true,'session on');
    expect(lastSet(sim)).toMatchObject({id:0,on:true});
    expect(Number(lastSet(sim)!.toggle_after)).toBeGreaterThan(31*60);expect(Number(lastSet(sim)!.toggle_after)).toBeLessThanOrEqual(32*60);
    const extended=await sessions.extend(user,s.id,{...key(),expectedVersion:s.version,additionalMinutes:30});
    await until(()=>Number(lastSet(sim)?.toggle_after)>61*60,'extended timer');
    const before=sim.calledWith('Switch.Set').length;
    sim.press();sim.press(); // someone toggles it off and on again during the session: nothing to correct
    await new Promise(r=>setTimeout(r,300));await devices.reconcileVenue(venueId);
    expect(sim.calledWith('Switch.Set')).toHaveLength(before);
    await sessions.end(user,s.id,{...key(),expectedVersion:extended.version});
    await until(()=>sim.output===false,'session end off');
  });

  it('switching the screen on by hand with no session is undone and reported to the owner',async()=>{
    const sim=sims[0];notifications.create.mockClear();
    sim.press();
    await until(()=>sim.output===false,'guard off again');
    await until(async()=>(await db.gamingDeviceLog.count({where:{kind:'guard'}}))>0,'guard log');
    await until(()=>notifications.create.mock.calls.length>0,'owner alerted');
    expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({userId:user.id,titleEn:expect.stringContaining('without a session')}));
  });

  it('transfer moves the power: old station off, new station on',async()=>{
    const a=sims[0];const {sim:b,device}=await plug('shellyplusplugs-bbbbbbbbbbb2');
    await devices.update(user,device.id,{...key(),unitId:units[1]});
    const s=await sessions.start(user,{...key(),unitId:units[0],startMode:'now'});
    await until(()=>a.output===true,'A on');
    expect(lastSet(a)).toEqual({id:0,on:true}); // open session: no timer
    const moved=await sessions.transfer(user,s.id,{...key(),expectedVersion:s.version,targetUnitId:units[1]});
    await until(()=>a.output===false&&b.output===true,'power moved');
    await sessions.end(user,s.id,{...key(),expectedVersion:moved.version});
    await until(()=>b.output===false,'B off');
  });

  it('a session that runs out goes dark after the grace period even if nobody presses end',async()=>{
    const sim=sims[0];
    const s=await sessions.start(user,{...key(),unitId:units[0],startMode:'now',durationMinutes:10});
    await until(()=>sim.output===true,'on');
    await devices.reconcileVenue(venueId,undefined,new Date(Date.now()+11*60000));
    expect(sim.output).toBe(true); // inside the 2-minute grace
    await devices.reconcileVenue(venueId,undefined,new Date(Date.now()+13*60000));
    await until(()=>sim.output===false,'expired off');
    const s2=await db.usageSession.findUniqueOrThrow({where:{id:s.id}});
    await sessions.end(user,s.id,{...key(),expectedVersion:s2.version});
  });

  it('manual override and test keep a screen on without a session, then hand control back',async()=>{
    const sim=sims[0];const device=await db.gamingDevice.findFirstOrThrow({where:{externalId:sim.deviceId}});
    await expect(devices.override(user,device.id,{...key(),on:true,minutes:10})).rejects.toMatchObject({status:400});
    const result=await devices.override(user,device.id,{...key(),on:true,minutes:10,reason:'setting up a new console'});
    expect(result).toMatchObject({ok:true,device:{screenOn:true,override:{on:true}}});
    expect(Number(lastSet(sim)!.toggle_after)).toBeGreaterThan(9*60);
    await devices.override(user,device.id,{...key(),on:false,minutes:0});
    await until(()=>sim.output===false,'override cleared');
    const test=await devices.test(user,device.id,{...key(),seconds:5});
    expect(test).toMatchObject({ok:true});expect(lastSet(sim)).toEqual({id:0,on:true,toggle_after:5});
    await devices.override(user,device.id,{...key(),on:false,minutes:0});
    await until(()=>sim.output===false,'test cleared');
  });

  it('turning control off for a plug leaves it alone; exclusive room sessions power the child screens',async()=>{
    const b=sims[1];const device=await db.gamingDevice.findFirstOrThrow({where:{externalId:b.deviceId}});
    await devices.update(user,device.id,{...key(),settings:{enabled:false}});
    b.press();await new Promise(r=>setTimeout(r,300));await devices.reconcileVenue(venueId);
    expect(b.output).toBe(true);
    await devices.update(user,device.id,{...key(),settings:{enabled:true}});
    await until(()=>b.output===false,'back under control');
    const room=await db.gamingRoom.create({data:{id:randomUUID(),venueId,name:'VIP',floorId:'ground',occupancy:'exclusive',bookableCourtId:units[3]}});
    await db.court.updateMany({where:{id:{in:[units[1]]}},data:{gamingRoomId:room.id}});
    const s=await sessions.start(user,{...key(),unitId:units[3],startMode:'now',durationMinutes:60});
    await until(()=>b.output===true,'room child screen on');
    await sessions.end(user,s.id,{...key(),expectedVersion:s.version});
    await until(()=>b.output===false,'room child screen off');
  });

  it('the board shows each station plug state',async()=>{
    const board=await sessions.board(user,venueId);
    const unit=board.units.find(u=>u.id===units[0])!;
    expect(unit.device).toMatchObject({online:true,screenOn:false,enabled:true,authError:false});
    expect(board.units.find(u=>u.id===units[2])!.device).toBeNull();
  });

  it('a password-protected plug is flagged instead of silently failing',async()=>{
    const {device}=await plug('shellyplugsg3-ccccccccccc3',{auth:true,output:true});
    const result=await devices.update(user,device.id,{...key(),unitId:units[2]});
    expect(result.unitId).toBe(units[2]);
    await until(async()=>(await db.gamingDevice.findUniqueOrThrow({where:{id:device.id}})).authError,'auth flagged');
    expect((await devices.overview(user,venueId)).devices.find(d=>d.id===device.id)).toMatchObject({authError:true});
  });

  it('a reconnecting plug replaces its old socket; disconnect marks it offline; a new link drops old plugs',async()=>{
    const a=sims[0];
    const again=new ShellySimulator(a.deviceId);sims.push(again);await again.connect(url);
    await a.closed();
    expect(hub.isOnline(a.deviceId)).toBe(true);
    again.close();
    await until(async()=>!(await db.gamingDevice.findFirstOrThrow({where:{externalId:a.deviceId}})).online,'offline');
    const rotated=await devices.rotateLink(user,key());
    expect(rotated.link.url).not.toBe(url);
    await until(()=>!hub.isOnline(sims[1].deviceId),'old link dropped');
    const logs=await devices.logs(user,venueId,(await db.gamingDevice.findFirstOrThrow({where:{externalId:a.deviceId}})).id);
    expect(logs.items.map(l=>l.kind)).toEqual(expect.arrayContaining(['connected','disconnected','command','guard','override','test','assigned']));
  });

  it('another venue cannot see or touch these plugs',async()=>{
    const other=await db.user.create({data:{name:'Other owner',phone:'+201099990078',roles:['owner']}});
    const device=await db.gamingDevice.findFirstOrThrow({where:{venueId}});
    await expect(devices.update({id:other.id,name:other.name,phone:other.phone!,roles:['owner']},device.id,{...key(),name:'x'})).rejects.toMatchObject({status:403});
  });
});
