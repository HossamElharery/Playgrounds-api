import { LayoutDocument, LayoutPlacement, validateLayoutDocument } from './layout-document';
import { GamingSetupDto, SetupKind } from './gaming-setup.dto';
export interface PlannedUnit { id:string; assetKey:SetupKind; floorIndex:number; roomIndex?:number; roomParent?:boolean; }
/** Cross-field checks supplement nested DTO validation, including total vs private counts. */
export function validateSetupPlan(d:GamingSetupDto):void {
 const fail=()=>{throw new RangeError('Invalid setup plan');};
 if(!d.groups.length||new Set(d.groups.map(g=>g.assetKey)).size!==d.groups.length||d.groups.reduce((n,g)=>n+g.count,0)>100)fail();
 const remaining=new Map(d.groups.map(g=>[g.assetKey,g.count]));
 const console=(k:string)=>['ps4','ps5','xbox-series'].includes(k);
 for(const g of d.groups){if(g.floorIndex>=d.floorCount||(!console(g.assetKey)&&(g.multiHourlyRateMinor!==undefined||g.privateMultiHourlyRateMinor!==undefined)))fail();}
 for(const r of d.rooms){
  if(!r.name.trim()||r.floorIndex>=d.floorCount||new Set(r.members.map(m=>m.assetKey)).size!==r.members.length||r.members.reduce((n,m)=>n+m.count,0)>12)fail();
  if(r.occupancy==='exclusive'&&(!r.hourlyRateMinor||r.multiHourlyRateMinor!==undefined&&!r.members.every(m=>console(m.assetKey))))fail();
  if(r.occupancy==='independent'&&(r.hourlyRateMinor!==undefined||r.multiHourlyRateMinor!==undefined))fail();
  for(const m of r.members){const left=(remaining.get(m.assetKey)??0)-m.count;if(left<0)fail();remaining.set(m.assetKey,left);}
 }
 for(const g of d.groups)if(g.floorCounts&&(g.floorCounts.length!==d.floorCount||g.floorCounts.reduce((n,c)=>n+c,0)!==remaining.get(g.assetKey)))fail();
}
/** Deterministic geometry; all identity is assigned once by the transaction. No external AI needed. */
export function buildSetupLayout(d:GamingSetupDto,units:PlannedUnit[],id:()=>string):LayoutDocument {
 const placements:LayoutPlacement[]=[];
 const floors:LayoutDocument['floors']=[];
 const place=(floorId:string,u:PlannedUnit,x:number,z:number,roomId?:string,rotation=0)=>{
  const table=u.assetKey==='billiards'||u.assetKey==='table-tennis';
  placements.push({id:id(),floorId,unitId:u.id,assetKey:u.assetKey,x,z,rotation,width:table?2:2.6,depth:table?3.4:2.6,height:1,...(roomId?{roomId}:{})});
 };
 for(let fi=0;fi<d.floorCount;fi++){
  const floorId=id(),rooms:LayoutDocument['floors'][number]['rooms']=[];
  const open=units.filter(u=>u.floorIndex===fi&&u.roomIndex===undefined);
  const cols=Math.min(d.arrangement==='walls'?Math.min(6,Math.max(2,Math.ceil(open.length/35)*2)):6,Math.max(1,open.length));
  let width=Math.max(12,cols*3.8+3),cursor=1.5;
  const rows=Math.ceil(open.length/cols);
  open.forEach((u,i)=>place(floorId,u,3.4+(i%cols)*3.8,cursor+2+Math.floor(i/cols)*4.6,undefined,d.arrangement==='walls'&&i%cols===1?180:0));
  if(open.length)cursor+=rows*4.6+1;
  d.rooms.forEach((r,ri)=>{
   if(r.floorIndex!==fi)return;
   const children=units.filter(u=>u.roomIndex===ri&&!u.roomParent);
   const parent=units.find(u=>u.roomIndex===ri&&u.roomParent);
   const roomCols=Math.min(4,children.length),roomWidth=Math.max(5.2,roomCols*3.8+1.2),roomDepth=Math.ceil(children.length/roomCols)*4.6+1.2;
   width=Math.max(width,roomWidth+3);
   const roomId=id();rooms.push({id:roomId,name:r.name.trim(),x:1.5,z:cursor,width:roomWidth,depth:roomDepth,occupancy:r.occupancy,...(parent?{bookableCourtId:parent.id}:{})});
   children.forEach((u,i)=>place(floorId,u,3.5+i%roomCols*3.8,cursor+2.3+Math.floor(i/roomCols)*4.6,roomId));
   // Door is the selectable whole-room resource, while its contents retain their identities.
   placements.push({id:id(),floorId,...(parent?{unitId:parent.id}:{}),assetKey:'door',x:4,z:cursor+roomDepth-.1,rotation:0,width:1.4,depth:.2,height:2.1});
   cursor+=roomDepth+1;
  });
  const depth=Math.max(10,cursor+3);
  if(width>200||depth>200)throw new RangeError('Floor exceeds supported bounds');
  placements.push({id:id(),floorId,assetKey:'counter',x:3.6,z:depth-1.5,rotation:0,width:4,depth:.9,height:1.1});
  floors.push({id:floorId,name:d.language==='ar'?(fi===0?'الدور الأرضي':`الدور ${fi}`):(fi===0?'Ground floor':`Floor ${fi}`),width,depth,elevation:fi*3,rooms});
 }
 return validateLayoutDocument({schemaVersion:1,venueId:d.venueId,units:'m',ambience:d.ambience,floors,placements},d.venueId,new Set(units.map(u=>u.id)));
}
