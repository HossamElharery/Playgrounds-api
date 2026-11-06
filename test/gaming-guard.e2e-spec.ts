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
import { ConsoleHubService } from '../src/modules/owner/gaming/devices/console-hub.service';
import { GamingHubsService } from '../src/modules/owner/gaming/devices/gaming-hubs.service';
import { ShellySimulator } from './support/shelly-simulator';
jest.setTimeout(120000);

async function until(check:()=>boolean|Promise<boolean>,label:string,ms=8000){
  const end=Date.now()+ms;
  while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,40));}
  throw new Error(`timed out waiting for: ${label}`);
}
import { validate } from 'class-validator';
import { DeviceGuardDto } from '../src/modules/owner/gaming/devices/gaming-devices.dto';
import { deviceSettings } from '../src/modules/owner/gaming/devices/device-policy';
const deviceSettingsOf=(d:{settings:unknown})=>deviceSettings(d.settings);

describe('Guard: only Matchena turns a screen on, with a delay the owner chooses (PostgreSQL + real WebSocket)',()=>{
  const db=new PrismaService();const commands=new GamingCommandService(db);
  let server:Server;let hub:DeviceHubService;let consoleHub:ConsoleHubService;let devices:GamingDevicesService;
  const notifications={create:jest.fn().mockResolvedValue(null)};
  let user:AuthenticatedUser;let venueId:string;let units:string[];let url:string;
  const sims:ShellySimulator[]=[];
  const key=()=>({venueId,requestKey:randomUUID()});
  const plug=async(id:string)=>{const sim=new ShellySimulator(id,{output:false});sims.push(sim);await sim.connect(url);await until(async()=>!!(await db.gamingDevice.findFirst({where:{externalId:id,online:true}})),`${id} registered`);return sim;};
  const row=(externalId:string)=>db.gamingDevice.findFirstOrThrow({where:{externalId}});
  /** The service also reconciles by itself in real time, so manual checks are "seconds from now". */
  const at=(sec:number)=>new Date(Date.now()+sec*1000);

  beforeAll(async()=>{
    await db.countryConfig.upsert({where:{code:'EG'},create:{code:'EG',nameAr:'مصر',nameEn:'Egypt',currency:'EGP',phoneCallingCode:'+20',timezone:'Africa/Cairo',weekendDays:[5,6],paymentMethods:['cash']},update:{}});
    const owner=await db.user.create({data:{name:'Guard fixture',phone:'+201099990095',roles:['owner']}});user={id:owner.id,name:owner.name,phone:owner.phone!,roles:['owner']};
    const sport=await db.sportCategory.create({data:{slug:'guard-fixture',nameAr:'ألعاب',nameEn:'Gaming',icon:'gamepad',accentColor:'#22cc88',activityKind:'gaming-station'}});
    const venue=await db.venue.create({data:{slug:'guard-fixture',nameAr:'محل الحماية',nameEn:'Guard test',ownerId:user.id,lat:30,lng:31,geohash:'sv8',status:'active',approvedAt:new Date(),gamingSessionsEnabled:true}});venueId=venue.id;
    units=[];for(let i=0;i<3;i++){const unit=await db.court.create({data:{venueId,sportId:sport.id,name:`Guard ${i+1}`,gamingConfig:{consoleType:'ps5',seats:2,roomTier:'standard'},pricingRules:{create:{label:'base',daysOfWeek:[],startTime:'00:00',endTime:'24:00',priceAmount:12000,currency:'EGP'}}}});units.push(unit.id);}
    server=createServer((_req,res)=>{res.statusCode=404;res.end();});
    await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));
    const port=(server.address() as AddressInfo).port;
    hub=new DeviceHubService({httpAdapter:{getHttpServer:()=>server}} as never,db);hub.onApplicationBootstrap();
    const config={get:(k:string,d?:unknown)=>k==='API_PUBLIC_URL'?`http://127.0.0.1:${port}`:d} as never;
    consoleHub=new ConsoleHubService({httpAdapter:{getHttpServer:()=>server}} as never,db);consoleHub.onApplicationBootstrap();
    devices=new GamingDevicesService(db,hub,consoleHub,new GamingHubsService(db,consoleHub,commands,config),commands,notifications as never,config);devices.onModuleInit();
    url=(await devices.overview(user,venueId)).link.url;
  });
  afterAll(async()=>{sims.forEach(s=>s.close());hub.onApplicationShutdown();consoleHub.onApplicationShutdown();await new Promise(r=>server.close(()=>r(null)));await db.$disconnect();});

  /** A linked plug that Matchena has put off, then someone presses its button. */
  const linkedAndSwitchedOn=async(id:string,unit:number,settings:object)=>{
    const sim=await plug(id);
    const d=await row(id);
    await devices.update(user,d.id,{...key(),unitId:units[unit],name:id,settings});
    await devices.reconcileVenue(venueId,undefined,at(0));await until(async()=>(await row(id)).appliedKey==='off','idle off sent');await until(()=>sim.output===false,'idle off');
    sim.press();
    // with "at once" Matchena undoes it before anyone could see it on
    if(!('guardDelayMinutes' in settings)||(settings as {guardDelayMinutes:number}).guardDelayMinutes>0)await until(async()=>(await row(id)).output===true,'switched on by hand');
    return sim;
  };

  it('the default waits a minute: nothing happens at once, then the screen is switched off and the owner is told',async()=>{
    notifications.create.mockClear();
    expect((await devices.overview(user,venueId)).devices).toEqual([]);
    const sim=await linkedAndSwitchedOn('shellyplugsg3-guard0000001',0,{});
    expect(deviceSettingsOf(await row('shellyplugsg3-guard0000001')).guardDelayMinutes).toBe(1);
    await devices.reconcileVenue(venueId,undefined,at(1));expect(sim.output).toBe(true);
    await devices.reconcileVenue(venueId,undefined,at(30));expect(sim.output).toBe(true);
    await devices.reconcileVenue(venueId,undefined,at(62));await until(()=>sim.output===false,'guard fires after a minute');
    expect(await db.gamingDeviceLog.count({where:{venueId,kind:'guard'}})).toBe(1);
    expect(notifications.create).toHaveBeenCalled();
  });

  it('"at once" undoes it on the next check, and "3 minutes" waits three',async()=>{
    const before=await db.gamingDeviceLog.count({where:{venueId,kind:'guard'}});
    const quick=await linkedAndSwitchedOn('shellyplugsg3-guard0000002',1,{guardDelayMinutes:0});
    await devices.reconcileVenue(venueId,undefined,at(2));
    await until(async()=>(await db.gamingDeviceLog.count({where:{venueId,kind:'guard'}}))>before,'immediate guard fired');
    await until(()=>quick.output===false,'and the screen is off');
    const slow=await linkedAndSwitchedOn('shellyplugsg3-guard0000003',2,{guardDelayMinutes:3});
    await devices.reconcileVenue(venueId,undefined,at(2));
    await devices.reconcileVenue(venueId,undefined,at(100));expect(slow.output).toBe(true);
    await devices.reconcileVenue(venueId,undefined,at(170));expect(slow.output).toBe(true);
    await devices.reconcileVenue(venueId,undefined,at(190));await until(()=>slow.output===false,'guard fires after three minutes');
  });

  it('switching the screen off in time, or by the system, never counts as a violation',async()=>{
    const sim=sims[0];const logs=await db.gamingDeviceLog.count({where:{venueId,kind:'guard'}});
    sim.press();await until(async()=>(await row('shellyplugsg3-guard0000001')).output===true,'on again');
    sim.press();await until(async()=>(await row('shellyplugsg3-guard0000001')).output===false,'off again');
    await devices.reconcileVenue(venueId,undefined,at(400));await devices.reconcileVenue(venueId,undefined,at(500));
    expect(await db.gamingDeviceLog.count({where:{venueId,kind:'guard'}})).toBe(logs);
  });

  it('"apply to all" gives every device of the venue the same Guard choice, once, and leaves the rest of each device alone',async()=>{
    const request={...key(),guard:true,delayMinutes:3};
    const first=await devices.applyGuard(user,request);
    expect(first).toMatchObject({updated:3,guard:true,delayMinutes:3});
    expect(await devices.applyGuard(user,request)).toEqual(first); // the same request is not applied twice
    for(const id of ['shellyplugsg3-guard0000001','shellyplugsg3-guard0000002','shellyplugsg3-guard0000003']){
      const d=await row(id);expect(deviceSettingsOf(d)).toMatchObject({guard:true,guardDelayMinutes:3,autoOn:true,cutAtEnd:true});
      expect(d.unitId).not.toBeNull();expect(d.name).toBe(id);
    }
    const off=await devices.applyGuard(user,{...key(),guard:false,delayMinutes:0});
    expect(off.updated).toBe(3);
    expect(deviceSettingsOf(await row('shellyplugsg3-guard0000002'))).toMatchObject({guard:false,guardDelayMinutes:0});
    expect(await db.gamingDeviceLog.count({where:{venueId,kind:'settings',detail:{path:['bulk'],equals:'guard'}}})).toBe(6);
  });

  it('only people who manage devices can use it, and a bad delay is refused',async()=>{
    await expect(devices.applyGuard({...user,roles:['staff']},{...key(),guard:true,delayMinutes:1})).rejects.toThrow();
    const dto=Object.assign(new DeviceGuardDto(),{...key(),guard:true,delayMinutes:2});
    const errors=await validate(dto);expect(errors.some(e=>e.property==='delayMinutes')).toBe(true);
    expect(await validate(Object.assign(new DeviceGuardDto(),{...key(),guard:true,delayMinutes:0}))).toEqual([]);
  });
});
