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

describe('smart TVs follow gaming sessions through a Matchena Hub (PostgreSQL + real WebSocket)',()=>{
  const db=new PrismaService();const commands=new GamingCommandService(db);const ledger=new LedgerService(db,new CommissionService(db,{} as never));
  let server:Server;let plugHub:DeviceHubService;let consoleHub:ConsoleHubService;let hubs:GamingHubsService;let devices:GamingDevicesService;let sessions:GamingSessionsService;
  const notifications={create:jest.fn().mockResolvedValue(null)};
  let user:AuthenticatedUser;let other:AuthenticatedUser;let venueId:string;let otherVenueId:string;let units:string[];
  let sweeper:NodeJS.Timeout;let sim:HubSimulator;let hubId:string;
  const key=()=>({venueId,requestKey:randomUUID()});
  const tvRow=(externalId:string)=>db.gamingDevice.findFirstOrThrow({where:{provider:'tv',externalId}});
  const SAM='tv-samsung-000000001';const SONY='tv-sony-000000002';const ROKU='tv-roku-000000003';

  beforeAll(async()=>{
    await db.countryConfig.upsert({where:{code:'EG'},create:{code:'EG',nameAr:'مصر',nameEn:'Egypt',currency:'EGP',phoneCallingCode:'+20',timezone:'Africa/Cairo',weekendDays:[5,6],paymentMethods:['cash']},update:{}});
    const mkOwner=async(phone:string,slug:string)=>{
      const o=await db.user.create({data:{name:`TV fixture ${slug}`,phone,roles:['owner']}});
      const u:AuthenticatedUser={id:o.id,name:o.name,phone:o.phone!,roles:['owner']};
      const v=await db.venue.create({data:{slug,nameAr:'محل التلفزيونات',nameEn:`TV test ${slug}`,ownerId:o.id,lat:30,lng:31,geohash:'sv8',status:'active',approvedAt:new Date(),gamingSessionsEnabled:true}});
      return {u,v};
    };
    const sport=await db.sportCategory.create({data:{slug:'tv-fixture',nameAr:'ألعاب',nameEn:'Gaming',icon:'gamepad',accentColor:'#22cc88',activityKind:'gaming-station'}});
    const a=await mkOwner('+201099990091','tv-fixture-a');user=a.u;venueId=a.v.id;
    const b=await mkOwner('+201099990092','tv-fixture-b');other=b.u;otherVenueId=b.v.id;
    units=[];for(let i=0;i<3;i++){const unit=await db.court.create({data:{venueId,sportId:sport.id,name:`PS5 ${i+1}`,gamingConfig:{consoleType:'ps5',seats:2,roomTier:'standard'},pricingRules:{create:{label:'base',daysOfWeek:[],startTime:'00:00',endTime:'24:00',priceAmount:12000,currency:'EGP'}}}});units.push(unit.id);}
    server=createServer((_req,res)=>{res.statusCode=404;res.end();});
    await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));
    const port=(server.address() as AddressInfo).port;
    const adapter={httpAdapter:{getHttpServer:()=>server}} as never;
    const config={get:(k:string,d?:unknown)=>k==='API_PUBLIC_URL'?`http://127.0.0.1:${port}`:d} as never;
    plugHub=new DeviceHubService(adapter,db);plugHub.onApplicationBootstrap();
    consoleHub=new ConsoleHubService(adapter,db);consoleHub.onApplicationBootstrap();
    hubs=new GamingHubsService(db,consoleHub,commands,config);
    devices=new GamingDevicesService(db,plugHub,consoleHub,hubs,commands,notifications as never,config);devices.onModuleInit();devices.settleMs=300;devices.unloggedGraceMs=0;
    sweeper=setInterval(()=>void devices.sweep().catch(()=>undefined),400);
    sessions=new GamingSessionsService(commands,ledger,plugHub);
  });
  afterAll(async()=>{clearInterval(sweeper);sim?.close();plugHub.onApplicationShutdown();consoleHub.onApplicationShutdown();await new Promise(r=>setTimeout(r,300));await new Promise(r=>server.close(()=>r(null)));await db.$disconnect();});

  it('a hub that knows TVs lists them unlinked, with brand, how to link them and whether they can be woken',async()=>{
    const {code}=await hubs.createCode(user,key());
    const claimed=await hubs.claim({code,hostname:'CASHIER-PC',platform:'win32',hubVersion:'1.1.0'});
    hubId=(await db.gamingHub.findFirstOrThrow({where:{venueId}})).id;
    sim=new HubSimulator([{id:'TVSPEC-PS5-01',name:'PS5-ONE',type:'PS5',state:'standby',paired:true}]);
    sim.hubVersion='1.1.0';
    sim.addTv({id:SAM,brand:'samsung',name:'Samsung Q60',model:'QE55Q60',state:'on',canWake:true});
    sim.addTv({id:SONY,brand:'sony',name:'Sony Bravia',state:'on',canWake:false});
    sim.addTv({id:ROKU,brand:'roku',name:'Roku TV',state:'standby',canWake:true,paired:true});
    await sim.connect(claimed.wsUrl,claimed.token);
    await until(async()=>(await db.gamingDevice.count({where:{provider:'tv',hubId}}))===3,'tvs discovered');
    const overview=await devices.overview(user,venueId);
    expect(overview.hubs[0]).toMatchObject({online:true,hubVersion:'1.1.0'});
    const sam=overview.devices.find(d=>d.externalId===SAM)!;
    expect(sam).toMatchObject({provider:'tv',tvBrand:'samsung',tvPairing:'prompt',canWake:true,paired:false,online:true,consoleState:'awake',screenOn:true,consoleType:null,unitId:null,name:'Samsung Q60'});
    expect(overview.devices.find(d=>d.externalId===SONY)).toMatchObject({tvBrand:'sony',tvPairing:'secret',canWake:false,paired:false});
    expect(overview.devices.find(d=>d.externalId===ROKU)).toMatchObject({tvBrand:'roku',tvPairing:'none',paired:true,consoleState:'standby',screenOn:false});
    // consoles are untouched by TV reports
    expect(overview.devices.filter(d=>d.provider==='ps')).toHaveLength(1);
  });

  it('linking a TV: wrong key, right key, a declined prompt, another venue and a plain console are all handled',async()=>{
    const sony=await tvRow(SONY);
    await expect(hubs.tvPair(user,sony.id,{...key(),secret:'0000'})).rejects.toMatchObject({response:{code:'TV_SECRET_WRONG'}});
    await expect(hubs.tvPair(user,sony.id,{...key(),secret:'1234'})).resolves.toEqual({ok:true});
    expect(await tvRow(SONY)).toMatchObject({paired:true});
    const sam=await tvRow(SAM);
    sim.allowPrompt=false;
    await expect(hubs.tvPair(user,sam.id,key())).rejects.toMatchObject({response:{code:'TV_PAIR_DENIED'}});
    expect(await tvRow(SAM)).toMatchObject({paired:false});
    sim.allowPrompt=true;
    await expect(hubs.tvPair(user,sam.id,key())).resolves.toEqual({ok:true});
    await expect(hubs.tvPair(other,sam.id,{venueId:otherVenueId,requestKey:randomUUID()})).rejects.toMatchObject({status:403});
    const ps=await db.gamingDevice.findFirstOrThrow({where:{provider:'ps',venueId}});
    await expect(hubs.tvPair(user,ps.id,key())).rejects.toMatchObject({status:403});
    await expect(hubs.pair(user,sam.id,{...key(),pin:'12345678'})).rejects.toMatchObject({status:403});
    await expect(hubs.tvCancel(user,sam.id,key())).resolves.toEqual({ok:true});
  });

  it('an unassigned TV is never commanded; setup check reports reach → off → on',async()=>{
    await devices.reconcileVenue(venueId);
    expect(sim.calledWith('tv.on')).toHaveLength(0);expect(sim.calledWith('tv.off')).toHaveLength(0);
    const sam=await tvRow(SAM);
    const check=await hubs.check(user,sam.id,key());
    expect(check.ok).toBe(true);expect(check.steps.map(s=>s.key)).toEqual(['reach','off','on']);
    expect(sim.calledWith('tv.check').at(-1)!.args).toEqual({tvId:SAM});
    expect(sim.calledWith('check')).toHaveLength(0);
  });

  it('a station may have a console and a TV at once; a timed session switches the TV on with an off time the hub keeps',async()=>{
    const sam=await tvRow(SAM);
    await devices.update(user,sam.id,{...key(),unitId:units[0],name:'Screen 1'});
    const s=await sessions.start(user,{...key(),unitId:units[0],startMode:'now',durationMinutes:30});
    await until(()=>sim.tvs.get(SAM)!.state==='on'&&sim.calledWith('tv.on').length>0,'tv on');
    const on=sim.calledWith('tv.on').at(-1)!.args;
    expect(on.tvId).toBe(SAM);
    const first=Date.parse(String(on.offAt));
    expect(first-Date.now()).toBeGreaterThan(31*60_000);expect(first-Date.now()).toBeLessThanOrEqual(32*60_000+5000);
    const extended=await sessions.extend(user,s.id,{...key(),expectedVersion:s.version,additionalMinutes:30});
    await until(()=>Date.parse(String(sim.calledWith('tv.on').at(-1)!.args.offAt))>first+25*60_000,'extended time');
    await sessions.end(user,s.id,{...key(),expectedVersion:extended.version});
    await until(()=>sim.tvs.get(SAM)!.state==='standby','tv off at session end');
    expect(sim.calledWith('tv.off').at(-1)!.args).toEqual({tvId:SAM});
    expect(sim.calledWith('wake').every(c=>c.args.consoleId!==SAM)).toBe(true);
  });

  it('console on station 2, TV on station 3, both from one hub: each follows its own station',async()=>{
    const ps=await db.gamingDevice.findFirstOrThrow({where:{provider:'ps',venueId}});
    await devices.update(user,ps.id,{...key(),unitId:units[1]});
    const sony=await tvRow(SONY);
    await devices.update(user,sony.id,{...key(),unitId:units[2]});
    await until(()=>sim.tvs.get(SONY)!.state==='standby','idle sony tv is off (guard)');
    const s=await sessions.start(user,{...key(),unitId:units[1],startMode:'now'});
    await until(()=>sim.consoles.get('TVSPEC-PS5-01')!.state==='awake','console wakes');
    expect(sim.tvs.get(SONY)!.state).toBe('standby');
    expect(sim.calledWith('tv.on').every(c=>c.args.tvId!==SONY)).toBe(true);
    await sessions.end(user,s.id,{...key(),expectedVersion:s.version});
    await until(()=>sim.consoles.get('TVSPEC-PS5-01')!.state==='standby','console rests');
  });

  it('switching a TV on by hand with no session is switched off again and the owner is told it was a screen',async()=>{
    await new Promise(r=>setTimeout(r,700));
    notifications.create.mockClear();
    const before=sim.calledWith('tv.off').length;
    sim.tvPower(SAM,'on');
    await until(()=>sim.calledWith('tv.off').length>before,'guard off');
    await until(()=>sim.tvs.get(SAM)!.state==='standby','off again');
    await until(async()=>(await db.gamingDeviceLog.count({where:{kind:'guard'}}))>0,'guard log');
    await until(()=>notifications.create.mock.calls.length>0,'owner alerted');
    expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({userId:user.id,titleEn:expect.stringContaining('Screen switched on without a session')}));
  });

  it('with guard off a TV on without a session is only reported, never switched off',async()=>{
    const sam=await tvRow(SAM);
    await devices.update(user,sam.id,{...key(),settings:{guard:false}});
    await new Promise(r=>setTimeout(r,900));
    notifications.create.mockClear();const offs=sim.calledWith('tv.off').length;
    sim.tvPower(SAM,'on');
    await until(()=>notifications.create.mock.calls.length>0,'owner told');
    await new Promise(r=>setTimeout(r,700));
    expect(sim.calledWith('tv.off').length).toBe(offs);expect(sim.tvs.get(SAM)!.state).toBe('on');
    await devices.update(user,sam.id,{...key(),settings:{guard:true}});
    await until(()=>sim.tvs.get(SAM)!.state==='standby','guard back on switches it off');
  });

  it('test switches the TV on for at least 90 s; a hub failure is reported, not thrown away',async()=>{
    const sam=await tvRow(SAM);
    const result=await devices.test(user,sam.id,{...key(),seconds:5});
    expect(result).toMatchObject({ok:true,device:{screenOn:true,override:{on:true}}});
    expect(Date.parse(String(sim.calledWith('tv.on').at(-1)!.args.offAt))-Date.now()).toBeGreaterThan(80_000);
    await devices.override(user,sam.id,{...key(),on:false,minutes:0});
    await until(()=>sim.tvs.get(SAM)!.state==='standby','test cleared');
    sim.fail['tv.on']='TV_ON_TIMEOUT';
    const failed=await devices.test(user,sam.id,{...key(),seconds:5});
    expect(failed).toMatchObject({ok:false,error:'device'});
    delete sim.fail['tv.on'];
    await devices.override(user,sam.id,{...key(),on:false,minutes:0});
  });

  it('the owner can add a TV by address, scan finds TVs, and an old hub is not asked about TVs',async()=>{
    const added=await hubs.tvAdd(user,hubId,{...key(),address:'192.168.1.77',brand:'roku',mac:'AA:BB:CC:DD:EE:FF'});
    expect(added.ok).toBe(true);
    expect(sim.calledWith('tv.add').at(-1)!.args).toEqual({address:'192.168.1.77',brand:'roku',mac:'AA:BB:CC:DD:EE:FF'});
    await expect(hubs.tvAdd(other,hubId,{venueId:otherVenueId,requestKey:randomUUID(),address:'192.168.1.78'})).rejects.toMatchObject({status:403});
    expect(await hubs.scan(user,hubId,key())).toMatchObject({ok:true,tvs:expect.any(Number)});
    expect(sim.calledWith('tv.scan')).toHaveLength(1);
    await db.gamingHub.update({where:{id:hubId},data:{hubVersion:'1.0.5'}});
    const scans=sim.calledWith('tv.scan').length;
    await hubs.scan(user,hubId,key());
    expect(sim.calledWith('tv.scan')).toHaveLength(scans);
  });

  it('removing a TV tells the hub to forget its keys; a session on a station whose hub is offline alerts the owner about the screen',async()=>{
    const roku=await tvRow(ROKU);
    await devices.remove(user,roku.id,key());
    await until(()=>sim.calledWith('tv.forget').length>0,'forget sent');
    expect(sim.calledWith('tv.forget').at(-1)!.args).toEqual({tvId:ROKU});
    expect(await db.gamingDevice.count({where:{id:roku.id}})).toBe(0);
    const sam=await tvRow(SAM);
    const s=await sessions.start(user,{...key(),unitId:units[0],startMode:'now'});
    await until(()=>sim.tvs.get(SAM)!.state==='on','on before drop');
    notifications.create.mockClear();
    sim.close();await sim.closed();
    await until(async()=>(await db.gamingDevice.findUniqueOrThrow({where:{id:sam.id}})).online===false,'marked offline');
    await until(()=>notifications.create.mock.calls.length>0,'owner told hub went offline');
    expect(sam.id).toBeTruthy();
    await sessions.end(user,s.id,{...key(),expectedVersion:s.version});
  });
});
