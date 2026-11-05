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
import { ShellySimulator } from './support/shelly-simulator';
jest.setTimeout(120000);

async function until(check:()=>boolean|Promise<boolean>,label:string,ms=8000){
  const end=Date.now()+ms;
  while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,40));}
  throw new Error(`timed out waiting for: ${label}`);
}

describe('one console and one screen per station, whatever the method (PostgreSQL + real WebSocket)',()=>{
  const db=new PrismaService();const commands=new GamingCommandService(db);const ledger=new LedgerService(db,new CommissionService(db,{} as never));
  let server:Server;let plugHub:DeviceHubService;let consoleHub:ConsoleHubService;let hubs:GamingHubsService;let devices:GamingDevicesService;let sessions:GamingSessionsService;
  const notifications={create:jest.fn().mockResolvedValue(null)};
  let user:AuthenticatedUser;let venueId:string;let units:string[];let sweeper:NodeJS.Timeout;let sim:HubSimulator;let plugUrl:string;
  const plugs:ShellySimulator[]=[];
  const key=()=>({venueId,requestKey:randomUUID()});
  const row=(externalId:string)=>db.gamingDevice.findFirstOrThrow({where:{externalId}});
  const plug=async(id:string)=>{const p=new ShellySimulator(id);plugs.push(p);await p.connect(plugUrl);await until(async()=>!!(await db.gamingDevice.findFirst({where:{externalId:id,online:true}})),`${id} registered`);return p;};
  const unitOf=async(externalId:string)=>(await row(externalId)).unitId;
  const SAM='tv-samsung-slot00001';const LG='tv-lg-slot000002';

  beforeAll(async()=>{
    await db.countryConfig.upsert({where:{code:'EG'},create:{code:'EG',nameAr:'مصر',nameEn:'Egypt',currency:'EGP',phoneCallingCode:'+20',timezone:'Africa/Cairo',weekendDays:[5,6],paymentMethods:['cash']},update:{}});
    const o=await db.user.create({data:{name:'Slots fixture',phone:'+201099990093',roles:['owner']}});user={id:o.id,name:o.name,phone:o.phone!,roles:['owner']};
    const v=await db.venue.create({data:{slug:'slots-fixture-a',nameAr:'محل المحطات',nameEn:'Slots test',ownerId:o.id,lat:30,lng:31,geohash:'sv8',status:'active',approvedAt:new Date(),gamingSessionsEnabled:true}});venueId=v.id;
    const sport=await db.sportCategory.create({data:{slug:'slots-fixture',nameAr:'ألعاب',nameEn:'Gaming',icon:'gamepad',accentColor:'#22cc88',activityKind:'gaming-station'}});
    units=[];for(let i=0;i<3;i++){const unit=await db.court.create({data:{venueId,sportId:sport.id,name:`Station ${i+1}`,gamingConfig:{consoleType:'ps5',seats:2,roomTier:'standard'},pricingRules:{create:{label:'base',daysOfWeek:[],startTime:'00:00',endTime:'24:00',priceAmount:12000,currency:'EGP'}}}});units.push(unit.id);}
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
    sessions=new GamingSessionsService(commands,ledger,plugHub,consoleHub);
    plugUrl=(await devices.overview(user,venueId)).link.url;
    const {code}=await hubs.createCode(user,key());
    const claimed=await hubs.claim({code,hostname:'PC',platform:'win32',hubVersion:'1.1.0'});
    sim=new HubSimulator([{id:'SLOTPS-ONE',name:'PS5-ONE',type:'PS5',state:'standby',paired:true},{id:'SLOTPS-TWO',name:'PS5-TWO',type:'PS5',state:'standby',paired:true}]);sim.hubVersion='1.1.0';
    sim.addTv({id:SAM,brand:'samsung',name:'Samsung',state:'standby',paired:true});sim.addTv({id:LG,brand:'lg',name:'LG',state:'standby',paired:true});
    await sim.connect(claimed.wsUrl,claimed.token);
    await until(async()=>(await db.gamingDevice.count({where:{venueId,hubId:{not:null}}}))===4,'hub devices');
  });
  afterAll(async()=>{clearInterval(sweeper);sim?.close();plugs.forEach(p=>p.close());plugHub.onApplicationShutdown();consoleHub.onApplicationShutdown();await new Promise(r=>setTimeout(r,300));await new Promise(r=>server.close(()=>r(null)));await db.$disconnect();});

  it('a console replaces the console on that station, never a screen; the other stations are untouched',async()=>{
    await devices.update(user,(await row('SLOTPS-ONE')).id,{...key(),unitId:units[0]});
    await devices.update(user,(await row(SAM)).id,{...key(),unitId:units[0]});
    await devices.update(user,(await row('SLOTPS-TWO')).id,{...key(),unitId:units[1]});
    const swapped=await devices.update(user,(await row('SLOTPS-TWO')).id,{...key(),unitId:units[0]});
    expect(swapped.replaced.map(r=>r.name)).toEqual(['PS5-ONE']);
    expect(await unitOf('SLOTPS-ONE')).toBeNull();expect(await unitOf('SLOTPS-TWO')).toBe(units[0]);expect(await unitOf(SAM)).toBe(units[0]);
  });

  it('a TV replaces a plug on the same station and the plug gives the screen its power back',async()=>{
    const p=await plug('shellyplugsg3-slot00000001');
    await devices.update(user,(await row('shellyplugsg3-slot00000001')).id,{...key(),unitId:units[1]});
    await devices.reconcileVenue(venueId);await until(()=>p.output===false,'idle plug cuts the screen (guard)');
    const r=await devices.update(user,(await row(LG)).id,{...key(),unitId:units[1]});
    expect(r.replaced.map(x=>x.id)).toHaveLength(1);
    expect(await unitOf('shellyplugsg3-slot00000001')).toBeNull();expect(await unitOf(LG)).toBe(units[1]);
    await until(()=>p.output===true,'released plug switches the screen back on');
    expect((await db.gamingDeviceLog.findMany({where:{deviceId:(await row('shellyplugsg3-slot00000001')).id,kind:'assigned'}})).some(l=>(l.detail as {replacedBy?:string}|null)?.replacedBy!==undefined)).toBe(true);
  });

  it('a plug replaces a TV; two plugs may still share a station (two monitors)',async()=>{
    const a=await plug('shellyplugsg3-slot00000002');const b=await plug('shellyplugsg3-slot00000003');
    await devices.update(user,(await row('shellyplugsg3-slot00000002')).id,{...key(),unitId:units[1]});
    expect(await unitOf(LG)).toBeNull();
    const r=await devices.update(user,(await row('shellyplugsg3-slot00000003')).id,{...key(),unitId:units[1]});
    expect(r.replaced).toEqual([]);expect(await unitOf('shellyplugsg3-slot00000002')).toBe(units[1]);expect(await unitOf('shellyplugsg3-slot00000003')).toBe(units[1]);
    expect(a).toBeTruthy();expect(b).toBeTruthy();
  });

  it('un-assigning or removing a plug restores power; saving the same station again changes nothing',async()=>{
    const a=plugs.find(p=>p.deviceId==='shellyplugsg3-slot00000002')!;
    await devices.reconcileVenue(venueId);await until(()=>a.output===false,'plug is cutting its screen');
    const same=await devices.update(user,(await row('shellyplugsg3-slot00000002')).id,{...key(),unitId:units[1]});
    expect(same.replaced).toEqual([]);expect(await unitOf('shellyplugsg3-slot00000003')).toBe(units[1]);
    await devices.update(user,(await row('shellyplugsg3-slot00000002')).id,{...key(),unitId:null});
    await until(()=>a.output===true,'un-assigned plug powers its screen');
    const b=plugs.find(p=>p.deviceId==='shellyplugsg3-slot00000003')!;
    await until(()=>b.output===false,'second plug cutting');
    await devices.remove(user,(await row('shellyplugsg3-slot00000003')).id,key());
    await until(()=>b.output===true,'removed plug powers its screen');
  });

  it('the floor board shows the console and the screen of a station, and a station with neither still loads',async()=>{
    const board=await sessions.board(user,venueId);
    const s1=board.units.find(u=>u.id===units[0])!;
    expect(s1.device).toMatchObject({provider:'ps'});expect(s1.screen).toMatchObject({provider:'tv',online:true});
    const empty=board.units.find(u=>u.id===units[2])!;
    expect(empty.device).toBeNull();expect(empty.screen).toBeNull();
    const tvOnly=board.units.find(u=>u.id===units[1])!;
    expect(tvOnly.screen).toBeNull();
  });
});
