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
import { ConsoleHubService } from '../src/modules/owner/gaming/devices/console-hub.service';
import { GamingHubsService } from '../src/modules/owner/gaming/devices/gaming-hubs.service';
import { GamingDevicesService } from '../src/modules/owner/gaming/devices/gaming-devices.service';
import { HubSimulator } from './support/hub-simulator';
jest.setTimeout(120000);

async function until(check:()=>boolean|Promise<boolean>,label:string,ms=8000){
  const end=Date.now()+ms;
  while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,40));}
  throw new Error(`timed out waiting for: ${label}`);
}

describe('consoles follow gaming sessions through a Matchena Hub (PostgreSQL + real WebSocket)',()=>{
  const db=new PrismaService();const commands=new GamingCommandService(db);const ledger=new LedgerService(db,new CommissionService(db,{} as never));
  let server:Server;let plugHub:DeviceHubService;let consoleHub:ConsoleHubService;let hubs:GamingHubsService;let devices:GamingDevicesService;let sessions:GamingSessionsService;
  const notifications={create:jest.fn().mockResolvedValue(null)};
  let user:AuthenticatedUser;let other:AuthenticatedUser;let venueId:string;let otherVenueId:string;let units:string[];
  let sweeper:NodeJS.Timeout;let sim:HubSimulator;let hubId:string;let wsUrl:string;let token:string;
  const key=()=>({venueId,requestKey:randomUUID()});
  const consoleRow=(externalId:string)=>db.gamingDevice.findFirstOrThrow({where:{provider:'ps',externalId}});

  beforeAll(async()=>{
    await db.countryConfig.upsert({where:{code:'EG'},create:{code:'EG',nameAr:'مصر',nameEn:'Egypt',currency:'EGP',phoneCallingCode:'+20',timezone:'Africa/Cairo',weekendDays:[5,6],paymentMethods:['cash']},update:{}});
    const mkOwner=async(phone:string,slug:string)=>{
      const o=await db.user.create({data:{name:`Hub fixture ${slug}`,phone,roles:['owner']}});
      const u:AuthenticatedUser={id:o.id,name:o.name,phone:o.phone!,roles:['owner']};
      const v=await db.venue.create({data:{slug,nameAr:'محل الهب',nameEn:`Hub test ${slug}`,ownerId:o.id,lat:30,lng:31,geohash:'sv8',status:'active',approvedAt:new Date(),gamingSessionsEnabled:true}});
      return {u,v};
    };
    const sport=await db.sportCategory.create({data:{slug:'hub-fixture',nameAr:'ألعاب',nameEn:'Gaming',icon:'gamepad',accentColor:'#22cc88',activityKind:'gaming-station'}});
    const a=await mkOwner('+201099990081','hub-fixture-a');user=a.u;venueId=a.v.id;
    const b=await mkOwner('+201099990082','hub-fixture-b');other=b.u;otherVenueId=b.v.id;
    units=[];for(let i=0;i<3;i++){const unit=await db.court.create({data:{venueId,sportId:sport.id,name:`PS5 ${i+1}`,gamingConfig:{consoleType:'ps5',seats:2,roomTier:'standard'},pricingRules:{create:{label:'base',daysOfWeek:[],startTime:'00:00',endTime:'24:00',priceAmount:12000,currency:'EGP'}}}});units.push(unit.id);}
    await db.court.create({data:{venueId:otherVenueId,sportId:sport.id,name:'Other PS5',gamingConfig:{consoleType:'ps5',seats:2,roomTier:'standard'}}});
    server=createServer((_req,res)=>{res.statusCode=404;res.end();});
    await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));
    const port=(server.address() as AddressInfo).port;
    const adapter={httpAdapter:{getHttpServer:()=>server}} as never;
    const config={get:(k:string,d?:unknown)=>k==='API_PUBLIC_URL'?`http://127.0.0.1:${port}`:d} as never;
    plugHub=new DeviceHubService(adapter,db);plugHub.onApplicationBootstrap();
    consoleHub=new ConsoleHubService(adapter,db);consoleHub.onApplicationBootstrap();
    hubs=new GamingHubsService(db,consoleHub,commands,config);
    devices=new GamingDevicesService(db,plugHub,consoleHub,hubs,commands,notifications as never,config);devices.onModuleInit();devices.settleMs=300;devices.unloggedGraceMs=0;
    sweeper=setInterval(()=>void devices.sweep().catch(()=>undefined),400); // the real service runs this on a cron
    sessions=new GamingSessionsService(commands,ledger,plugHub);
  });
  afterAll(async()=>{clearInterval(sweeper);sim?.close();plugHub.onApplicationShutdown();consoleHub.onApplicationShutdown();await new Promise(r=>setTimeout(r,300));await new Promise(r=>server.close(()=>r(null)));await db.$disconnect();});

  it('a connect code is single use, case/format tolerant, venue scoped, and turns into a hub token',async()=>{
    const {code,expiresAt,apiUrl}=await hubs.createCode(user,key());expect(apiUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(code).toMatch(/^[A-HJ-KM-NP-Z2-9]{4}-[A-HJ-KM-NP-Z2-9]{4}$/);
    expect(new Date(expiresAt).getTime()-Date.now()).toBeGreaterThan(14*60_000);
    await expect(hubs.claim({code:'ZZZZ-ZZZZ'})).rejects.toMatchObject({status:400});
    const claimed=await hubs.claim({code:` ${code.toLowerCase().replace('-',' ')} `,hostname:'CASHIER-PC',platform:'win32',hubVersion:'1.0.0'});
    expect(claimed.token).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(claimed.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/api\/v1\/gaming\/hub\/connect$/);
    await expect(hubs.claim({code})).rejects.toMatchObject({status:400}); // already used
    const hub=await db.gamingHub.findFirstOrThrow({where:{venueId}});
    expect(hub.tokenHash).not.toContain(claimed.token);expect(hub.tokenHash).toHaveLength(64);
    hubId=hub.id;wsUrl=claimed.wsUrl;token=claimed.token;
  });

  it('an expired code and a code of another kind are refused; owners cannot see each other\'s hubs',async()=>{
    const {code}=await hubs.createCode(user,key());
    await db.gamingHubClaim.updateMany({where:{venueId,usedAt:null},data:{expiresAt:new Date(Date.now()-1000)}});
    await expect(hubs.claim({code})).rejects.toMatchObject({status:400});
    await expect(hubs.rename(other,hubId,{venueId:otherVenueId,requestKey:randomUUID(),name:'x'})).rejects.toMatchObject({status:403});
    expect((await devices.overview(other,otherVenueId)).hubs).toHaveLength(0);
  });

  it('refuses sockets without a valid token, accepts the hub, and lists its consoles unlinked',async()=>{
    const bad=new HubSimulator();
    await expect(bad.connect(wsUrl,'x'.repeat(43))).rejects.toThrow('HTTP 401');
    await expect(bad.connect(wsUrl,'short')).rejects.toThrow('HTTP 401');
    sim=new HubSimulator([{id:'PS5AAAA1',name:'PS5-ONE',type:'PS5',state:'standby'},{id:'PS4BBBB2',name:'PS4-TWO',type:'PS4',state:'awake'}]);
    await sim.connect(wsUrl,token);
    await until(()=>sim.welcomed,'welcome');
    await until(async()=>(await db.gamingDevice.count({where:{provider:'ps',hubId}}))===2,'consoles discovered');
    const overview=await devices.overview(user,venueId);
    expect(overview.hubs[0]).toMatchObject({id:hubId,online:true,hostname:'SIM-PC',hubVersion:'1.0.0-test',psnLinked:false});
    expect(overview.downloads.win).toMatch(/\/api\/v1\/gaming\/hub\/download\/MatchenaHub-win-x64\.exe$/);expect(overview.downloads.mac).toContain('MatchenaHub-macos.zip');
    expect(hubs.downloadPath('../../etc/passwd')).toBeNull();expect(hubs.downloadPath('MatchenaHub-win-x64.exe/../x')).toBeNull();expect(hubs.downloadPath('__proto__')).toBeNull();
    const one=overview.devices.find(d=>d.externalId==='PS5AAAA1')!;
    expect(one).toMatchObject({provider:'ps',online:true,paired:false,consoleType:'PS5',consoleState:'standby',screenOn:false,unitId:null,name:'PS5-ONE'});
    expect(overview.devices.find(d=>d.externalId==='PS4BBBB2')).toMatchObject({consoleType:'PS4',consoleState:'awake',screenOn:true});
  });

  it('PlayStation sign-in and PIN pairing go through the hub with clear errors',async()=>{
    const row=await consoleRow('PS5AAAA1');
    await expect(hubs.pair(user,row.id,{...key(),pin:'12345678'})).rejects.toMatchObject({response:{code:'PSN_NOT_LINKED'}});
    expect((await hubs.psnUrl(user,hubId,venueId)).url).toMatch(/^https:\/\//);
    await expect(hubs.psnLink(user,hubId,{...key(),redirectUrl:'https://example.com/nothing'})).rejects.toMatchObject({response:{code:'PSN_URL_INVALID'}});
    // sign-in without copy/paste: the Hub opens its own window; the owner page polls the status
    expect(await hubs.psnSignin(user,hubId,key())).toEqual({state:'waiting'});
    await until(async()=>(await hubs.psnStatus(user,hubId,venueId)).linked,'sign-in finished');
    expect((await db.gamingHub.findUniqueOrThrow({where:{id:hubId}})).psnLinked).toBe(true);
    sim.psnLinked=false;sim.signinState='idle';await db.gamingHub.update({where:{id:hubId},data:{psnLinked:false}});
    await expect(hubs.psnLink(user,hubId,{...key(),redirectUrl:'https://remoteplay.dl.playstation.net/remoteplay/redirect?code=abc'})).resolves.toEqual({linked:true});
    expect((await db.gamingHub.findUniqueOrThrow({where:{id:hubId}})).psnLinked).toBe(true);
    await expect(hubs.pair(user,row.id,{...key(),pin:'00000000'})).rejects.toMatchObject({response:{code:'PIN_WRONG'}});
    await expect(hubs.pair(user,row.id,{...key(),pin:'12345678'})).resolves.toEqual({ok:true});
    expect(await consoleRow('PS5AAAA1')).toMatchObject({paired:true});
    await expect(hubs.pair(other,row.id,{venueId:otherVenueId,requestKey:randomUUID(),pin:'12345678'})).rejects.toMatchObject({status:403});
    const check=await hubs.check(user,row.id,key());
    expect(check.ok).toBe(true);expect(check.steps.map(s=>s.key)).toEqual(['reach','standby','wake']);
  });

  it('an unlinked or unassigned console is never commanded; linking to a station rests an idle console (guard)',async()=>{
    const row=await consoleRow('PS5AAAA1');
    await devices.reconcileVenue(venueId);
    expect(sim.calledWith('wake')).toHaveLength(0);expect(sim.calledWith('standby')).toHaveLength(0);
    await devices.update(user,row.id,{...key(),unitId:units[0],name:'Console 1'});
    await devices.reconcileVenue(venueId);
    // it is already in rest mode: nothing to correct, but the intent is recorded
    expect(sim.consoles.get('PS5AAAA1')!.state).toBe('standby');
  });

  it('a timed session wakes the console with a rest-mode time the hub keeps; extending moves it; ending rests it',async()=>{
    const s=await sessions.start(user,{...key(),unitId:units[0],startMode:'now',durationMinutes:30});
    await until(()=>sim.consoles.get('PS5AAAA1')!.state==='awake','session wake');
    const wake=sim.calledWith('wake').at(-1)!.args;
    expect(wake.consoleId).toBe('PS5AAAA1');
    const first=Date.parse(String(wake.standbyAt));
    expect(first-Date.now()).toBeGreaterThan(31*60_000);expect(first-Date.now()).toBeLessThanOrEqual(32*60_000+5000);
    const extended=await sessions.extend(user,s.id,{...key(),expectedVersion:s.version,additionalMinutes:30});
    await until(()=>Date.parse(String(sim.calledWith('wake').at(-1)!.args.standbyAt))>first+25*60_000,'extended time');
    await sessions.end(user,s.id,{...key(),expectedVersion:extended.version});
    await until(()=>sim.consoles.get('PS5AAAA1')!.state==='standby','session end rest');
    expect(sim.calledWith('standby').at(-1)!.args.consoleId).toBe('PS5AAAA1');
  });

  it('an open session has no rest-mode time (clears any old one)',async()=>{
    const s=await sessions.start(user,{...key(),unitId:units[0],startMode:'now'});
    await until(()=>sim.consoles.get('PS5AAAA1')!.state==='awake','open wake');
    expect(sim.calledWith('wake').at(-1)!.args.standbyAt).toBeNull();
    await sessions.end(user,s.id,{...key(),expectedVersion:s.version});
    await until(()=>sim.consoles.get('PS5AAAA1')!.state==='standby','open end');
  });

  it('switching the console on by hand with no session is rested again and reported (after it settles)',async()=>{
    notifications.create.mockClear();
    const before=sim.calledWith('standby').length;
    sim.press('PS5AAAA1');
    // while the previous command is still settling the report is not trusted; the sweep catches it
    await until(()=>sim.calledWith('standby').length>before,'guard rest');
    await until(()=>sim.consoles.get('PS5AAAA1')!.state==='standby','rested again');
    await until(async()=>(await db.gamingDeviceLog.count({where:{kind:'guard'}}))>0,'guard log');
    await until(()=>notifications.create.mock.calls.length>0,'owner alerted');
    expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({userId:user.id,titleEn:expect.stringContaining('Console powered on without a session')}));
  });

  it('a console switched on by hand gets a grace period: starting a session in time means no alert and no rest',async()=>{
    notifications.create.mockClear();devices.unloggedGraceMs=1500;
    const rests=sim.calledWith('standby').length;
    sim.press('PS5AAAA1');
    await new Promise(r=>setTimeout(r,500));
    const s=await sessions.start(user,{...key(),unitId:units[0],startMode:'now',durationMinutes:30});
    await new Promise(r=>setTimeout(r,2200));
    expect(sim.calledWith('standby').length).toBe(rests);expect(sim.consoles.get('PS5AAAA1')!.state).toBe('awake');
    expect(notifications.create).not.toHaveBeenCalled();
    await sessions.end(user,s.id,{...key(),expectedVersion:s.version});
    await until(()=>sim.consoles.get('PS5AAAA1')!.state==='standby','rested after session');
    devices.unloggedGraceMs=0;
  });

  it('with guard off a console on without a session is only reported, never rested',async()=>{
    const row=await consoleRow('PS5AAAA1');
    await devices.update(user,row.id,{...key(),settings:{guard:false}});
    await until(()=>sim.consoles.get('PS5AAAA1')!.state==='standby','idle before');
    await new Promise(r=>setTimeout(r,900)); // let any reconcile that started with the old settings finish
    notifications.create.mockClear();const rests=sim.calledWith('standby').length;
    sim.power('PS5AAAA1','awake');
    await until(()=>notifications.create.mock.calls.length>0,'owner told');
    expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({userId:user.id,titleEn:'Hub test hub-fixture-a: Console is on without a session (PS5 1)'}));
    await new Promise(r=>setTimeout(r,800));
    expect(sim.calledWith('standby').length).toBe(rests);expect(sim.consoles.get('PS5AAAA1')!.state).toBe('awake');
    await devices.update(user,row.id,{...key(),settings:{guard:true}});
    await until(()=>sim.consoles.get('PS5AAAA1')!.state==='standby','guard back on rests it');
  });

  it('test wakes the console for at least 90 s even if a shorter time is asked; hub failure is reported not thrown away',async()=>{
    const row=await consoleRow('PS5AAAA1');
    const result=await devices.test(user,row.id,{...key(),seconds:5});
    expect(result).toMatchObject({ok:true,device:{screenOn:true,override:{on:true}}});
    const wake=sim.calledWith('wake').at(-1)!.args;
    expect(Date.parse(String(wake.standbyAt))-Date.now()).toBeGreaterThan(80_000);
    sim.fail.standby='STANDBY_TIMEOUT';
    await devices.override(user,row.id,{...key(),on:false,minutes:0}).catch(()=>undefined);
    await until(async()=>(await db.gamingDeviceLog.count({where:{kind:'failed',deviceId:row.id}}))>0,'failure logged');
    sim.fail={};
    await until(()=>sim.consoles.get('PS5AAAA1')!.state==='standby','recovers once the hub works');
  });

  it('the hub going away marks its consoles offline; coming back re-sends what they should do',async()=>{
    const row=await consoleRow('PS5AAAA1');
    const s=await sessions.start(user,{...key(),unitId:units[0],startMode:'now',durationMinutes:60});
    await until(()=>sim.consoles.get('PS5AAAA1')!.state==='awake','awake');
    notifications.create.mockClear();
    sim.close();await sim.closed();
    await until(async()=>!(await db.gamingHub.findUniqueOrThrow({where:{id:hubId}})).online,'hub offline');
    expect((await devices.overview(user,venueId)).devices.find(d=>d.id===row.id)).toMatchObject({online:false,screenOn:null});
    await until(()=>notifications.create.mock.calls.length>0,'owner told about the hub');
    expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({titleEn:expect.stringContaining('Hub went offline')}));
    const keep=sim.consoles;sim=new HubSimulator();keep.forEach((c,id)=>sim.consoles.set(id,c));sim.psnLinked=true;
    sim.consoles.get('PS5AAAA1')!.state='standby'; // someone rested it while the hub was away
    await sim.connect(wsUrl,token);
    await until(()=>sim.consoles.get('PS5AAAA1')!.state==='awake','session console woken again');
    const fresh=await db.usageSession.findUniqueOrThrow({where:{id:s.id}});
    await sessions.end(user,s.id,{...key(),expectedVersion:fresh.version});
    await until(()=>sim.consoles.get('PS5AAAA1')!.state==='standby','ended');
  });

  it('removing a console tells the hub to forget it and it comes back as a new unlinked one',async()=>{
    const row=await consoleRow('PS4BBBB2');
    await devices.remove(user,row.id,key());
    await until(()=>sim.calledWith('forget').length>0,'hub told to forget');
    await until(async()=>!!(await db.gamingDevice.findFirst({where:{externalId:'PS4BBBB2',provider:'ps'}})),'rediscovered');
  });

  it('a session on a console whose Hub is offline warns the team right away',async()=>{
    sim.close();await sim.closed();
    await until(async()=>!(await db.gamingHub.findUniqueOrThrow({where:{id:hubId}})).online,'hub offline');
    notifications.create.mockClear();
    const s=await sessions.start(user,{...key(),unitId:units[0],startMode:'now',durationMinutes:30});
    await until(()=>notifications.create.mock.calls.some(c=>String(c[0].titleEn).includes('Matchena Hub is offline')),'team warned');
    await sessions.end(user,s.id,{...key(),expectedVersion:s.version});
  });

  it('replacing the shop PC: removing the old Hub keeps set-up consoles, and the new Hub adopts them with their station',async()=>{
    await hubs.remove(user,hubId,key());
    const kept=await consoleRow('PS5AAAA1');
    expect(kept).toMatchObject({hubId:null,unitId:units[0],paired:true});
    expect(await db.gamingDevice.count({where:{externalId:'PS4BBBB2'}})).toBe(0); // never linked, no station: just noise
    const {code}=await hubs.createCode(user,key());
    const c2=await hubs.claim({code,hostname:'NEW-PC'});
    const hub2=await db.gamingHub.findFirstOrThrow({where:{venueId}});
    const sim2=new HubSimulator([{id:'PS5AAAA1',name:'PS5-ONE',type:'PS5',state:'standby',paired:false},{id:'PS4BBBB2',name:'PS4-TWO',type:'PS4',state:'standby'}]);
    await sim2.connect(c2.wsUrl,c2.token);
    await until(async()=>(await consoleRow('PS5AAAA1')).hubId===hub2.id,'adopted by the new hub');
    expect(await consoleRow('PS5AAAA1')).toMatchObject({unitId:units[0],paired:false,name:'Console 1'});
    sim2.close();await sim2.closed();
  });

  it('two Hubs online at once: the first keeps its consoles, the second does not steal them',async()=>{
    const {code}=await hubs.createCode(user,key());
    const first=await hubs.claim({code,hostname:'PC-A'});
    const hubA=await db.gamingHub.findFirstOrThrow({where:{tokenHash:{not:''},hostname:'PC-A'}});
    const a=new HubSimulator([{id:'PS5AAAA1',name:'PS5-ONE',type:'PS5',state:'standby',paired:true}]);
    await a.connect(first.wsUrl,first.token);
    await until(async()=>(await consoleRow('PS5AAAA1')).hubId===hubA.id,'A owns it');
    const second=await hubs.claim({code:(await hubs.createCode(user,key())).code,hostname:'PC-B'});
    const b=new HubSimulator([{id:'PS5AAAA1',name:'PS5-ONE',type:'PS5',state:'awake',paired:true}]);
    await b.connect(second.wsUrl,second.token);
    await new Promise(r=>setTimeout(r,700));
    expect((await consoleRow('PS5AAAA1')).hubId).toBe(hubA.id);
    a.close();b.close();await a.closed();
    await until(async()=>!(await db.gamingHub.findUniqueOrThrow({where:{id:hubA.id}})).online,'A offline');
    b.snapshot?.(); // reconnect-less: B re-sends its snapshot and may now take over
  });

  it('a Hub cannot take over a console that belongs to another venue',async()=>{
    const other=await db.gamingDevice.create({data:{venueId:otherVenueId,provider:'ps',externalId:'PS5OTHER9',model:'PS5',settings:{},paired:true,lastSeenAt:new Date(),online:true}});
    const {code}=await hubs.createCode(user,key());
    const c=await hubs.claim({code,hostname:'PC-C'});
    const sim3=new HubSimulator([{id:'PS5OTHER9',name:'THEIRS',type:'PS5',state:'standby',paired:true}]);
    await sim3.connect(c.wsUrl,c.token);
    await new Promise(r=>setTimeout(r,600));
    expect(await db.gamingDevice.findUniqueOrThrow({where:{id:other.id}})).toMatchObject({venueId:otherVenueId,hubId:null});
    expect(await db.gamingDevice.count({where:{venueId,externalId:'PS5OTHER9'}})).toBe(0);
    sim3.close();await sim3.closed();
  });
});
