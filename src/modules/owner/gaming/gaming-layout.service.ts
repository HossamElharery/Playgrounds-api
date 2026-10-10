import { gamingConfigObject } from './gaming-tariff';
import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { assertStaffPermission, assertVenueAccess } from '../../../common/access/owner-access';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { randomUUID } from 'crypto';
import { buildDefaultLayout } from './default-layout';
import { LayoutDocument, validateLayoutDocument } from './layout-document';
import { PublishGamingLayoutDto, RestoreGamingLayoutDto, SaveGamingLayoutDto } from './gaming-layout.dto';

@Injectable()
export class GamingLayoutService {
  constructor(private readonly prisma: PrismaService) {}
  private async access(user: AuthenticatedUser, venueId: string, permission: 'layout.view' | 'layout.edit' | 'layout.publish', write: boolean) {
    const venue = await assertVenueAccess(this.prisma, user, venueId, { write });
    await assertStaffPermission(this.prisma, user, permission);
    if (venue.status !== 'active' || !venue.approvedAt) throw new ForbiddenException({ code: 'VENUE_NOT_APPROVED', message: 'Venue must be approved' });
    await this.checkApplication(this.prisma,venueId);
    const units = await this.prisma.court.findMany({ where: { venueId }, include: { sport: { select: { activityKind: true } } } });
    const declared = units.some(u => ['gaming-station', 'table-game'].includes(u.sport.activityKind ?? ''))
      || !!(await this.prisma.venueSport.findFirst({ where: { venueId, sport: { activityKind: { in: ['gaming-station', 'table-game'] } } }, select: { venueId: true } }));
    if (!declared) throw new ForbiddenException({ code: 'GAMING_NOT_AVAILABLE', message: 'Gaming layout requires gaming units' });
    return units;
  }
  private async checkApplication(db:Prisma.TransactionClient|PrismaService,venueId:string){const app=await db.partnerApplication.findUnique({where:{venueId},select:{status:true}});if(app&&app.status!=='approved')throw new ForbiddenException({code:'VENUE_NOT_APPROVED'});}
  /** The sign logo must be one of THIS venue's own photos (never another venue's, never an arbitrary id). */
  private async assertLogo(db: Prisma.TransactionClient | PrismaService, venueId: string, document: LayoutDocument) {
    if (document.signLogoPhotoId && !(await db.venuePhoto.findFirst({ where: { id: document.signLogoPhotoId, venueId }, select: { id: true } }))) throw new BadRequestException({ code: 'LAYOUT_INVALID', message: 'Unknown sign logo' });
  }
  private conflict(revision: number, draftVersion: number): never {
    throw new ConflictException({ code: 'LAYOUT_VERSION_CONFLICT', message: 'Layout has changed', latestRevision: revision, latestDraftVersion: draftVersion });
  }
  async read(user: AuthenticatedUser, venueId: string) {
    const units = await this.access(user, venueId, 'layout.view', false);
    await this.provisionDefault(user, venueId, units);
    const edit = !user.roles.includes('staff') || await this.canEdit(user);
    // One snapshot: a concurrent publish cannot pair a new pointer with an old document.
    const logos = await this.prisma.venuePhoto.findMany({ where: { venueId }, select: { id: true, url: true }, orderBy: { position: 'asc' }, take: 20 });
    return this.prisma.$transaction(async tx => {
      const state = await tx.gamingLayout.findUnique({ where: { venueId } });
      const published = state?.revision ? await tx.gamingLayoutRevision.findUnique({ where: { venueId_revision: { venueId, revision: state.revision } } }) : null;
      return { venueId, revision: state?.revision ?? 0, draftVersion: edit ? state?.draftVersion ?? 0 : 0,
        draft: edit ? state?.draft ?? null : null, published: published?.document ?? null,
        serverNow: new Date().toISOString(), logos, units: units.map(u => ({ id: u.id, name: u.name, activityKind: u.sport.activityKind, gamingConfig: u.gamingConfig?Object.fromEntries(Object.entries(gamingConfigObject(u.gamingConfig)).filter(([k])=>['consoleType','seats','roomTier','setupWholeRoomOnly'].includes(k))):null, tableConfig: u.tableConfig?Object.fromEntries(Object.entries(gamingConfigObject(u.tableConfig)).filter(([k])=>['tableType','rentalAvailable','setupWholeRoomOnly'].includes(k))):null })) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
  /**
   * First look at a hall that has units but no floor plan: publish a generated starting layout
   * (revision 1) so the owner and staff land on a real map. Never touches a venue that already has a
   * published layout or a draft in progress, and a concurrent first read simply loses the race.
   */
  private async provisionDefault(user: AuthenticatedUser, venueId: string, units: { id: string; name: string; gamingConfig: unknown; tableConfig: unknown; sport: { activityKind: string | null } }[]) {
    // A mixed venue's courts (padel, football…) are not part of the hall plan.
    units = units.filter(u => ['gaming-station', 'table-game'].includes(u.sport.activityKind ?? ''));
    if (!units.length) return;
    const existing = await this.prisma.gamingLayout.findUnique({ where: { venueId }, select: { revision: true, draft: true } });
    if (existing && (existing.revision > 0 || existing.draft)) return;
    const profile = await this.prisma.user.findUnique({ where: { id: user.id }, select: { preferredLang: true } });
    const lang = profile?.preferredLang === 'en' ? 'en' : 'ar';
    const document = buildDefaultLayout(venueId, units.map(u => ({ id: u.id, name: u.name, activityKind: u.sport.activityKind, gamingConfig: u.gamingConfig, tableConfig: u.tableConfig })), lang, randomUUID);
    const requestKey = `auto-default:${venueId}`;
    try {
      await this.prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "Venue" WHERE "id" = ${venueId} FOR UPDATE`;
        const state = await tx.gamingLayout.findUnique({ where: { venueId } });
        if (state && (state.revision > 0 || state.draft)) return;
        const current = await tx.court.findMany({ where: { venueId }, select: { id: true } });
        const valid = validateLayoutDocument(document, venueId, new Set(current.map(c => c.id)));
        await this.applyRooms(tx, venueId, valid);
        await tx.gamingLayoutRevision.create({ data: { venueId, revision: 1, requestKey, requestHash: 'auto-default', createdById: user.id, document: valid as unknown as Prisma.InputJsonValue } });
        await tx.gamingLayout.upsert({ where: { venueId }, create: { venueId, revision: 1, draftVersion: 0 }, update: { revision: 1 } });
        await tx.auditLogEntry.create({ data: { actorUserId: user.id, action: 'owner.layout.auto_generated', targetType: 'venue', targetId: venueId, metadata: { revision: 1 } } });
        await tx.gamingOutbox.create({ data: { venueId, entityId: venueId, version: 1, type: 'layout.published' } });
      });
    } catch (error) {
      // A unique clash means another request generated it first; anything else must not break reading.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError)) throw error;
    }
  }
  private async canEdit(user: AuthenticatedUser) {
    try { await assertStaffPermission(this.prisma, user, 'layout.edit'); return true; } catch { return false; }
  }
  async save(user: AuthenticatedUser, dto: SaveGamingLayoutDto) {
    const units = await this.access(user, dto.venueId, 'layout.edit', true);
    let document;
    try { document = validateLayoutDocument(dto.document, dto.venueId, new Set(units.map(u => u.id))); }
    catch { throw new BadRequestException({ code: 'LAYOUT_INVALID', message: 'Invalid layout document' }); }
    return this.prisma.$transaction(async tx => {
      // Lock the common parent even before the first layout exists.
      await tx.$queryRaw`SELECT "id" FROM "Venue" WHERE "id" = ${dto.venueId} FOR UPDATE`;
      await assertStaffPermission(tx as PrismaService, user, 'layout.edit');
      const venue = await tx.venue.findUniqueOrThrow({ where: { id: dto.venueId } });
      if (venue.status !== 'active' || !venue.approvedAt) throw new ForbiddenException({ code: 'VENUE_NOT_APPROVED' });
      await this.checkApplication(tx,dto.venueId);
      const state = await tx.gamingLayout.findUnique({ where: { venueId: dto.venueId } });
      if ((state?.revision ?? 0) !== dto.baseRevision || (state?.draftVersion ?? 0) !== dto.draftVersion) this.conflict(state?.revision ?? 0, state?.draftVersion ?? 0);
      const currentUnits = await tx.court.findMany({ where: { venueId: dto.venueId }, select: { id: true } });
      try { validateLayoutDocument(document, dto.venueId, new Set(currentUnits.map(u => u.id))); } catch { throw new BadRequestException({ code: 'LAYOUT_INVALID' }); }
      await this.assertLogo(tx, dto.venueId, document);
      const next = await tx.gamingLayout.upsert({ where: { venueId: dto.venueId }, create: { venueId: dto.venueId, draft: document as unknown as Prisma.InputJsonValue, draftVersion: 1, draftByUserId: user.id }, update: { draft: document as unknown as Prisma.InputJsonValue, draftVersion: { increment: 1 }, draftByUserId: user.id } });
      return { revision: next.revision, draftVersion: next.draftVersion };
    });
  }
  async publish(user: AuthenticatedUser, dto: PublishGamingLayoutDto) {
    await this.access(user, dto.venueId, 'layout.publish', true);
    const requestKey = dto.requestKey.toLowerCase();
    const hash = createHash('sha256').update(JSON.stringify({ venueId: dto.venueId, revision: dto.baseRevision, draftVersion: dto.draftVersion, actor: user.id })).digest('hex');
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Venue" WHERE "id" = ${dto.venueId} FOR UPDATE`;
      await assertStaffPermission(tx as PrismaService, user, 'layout.publish');
      const venue = await tx.venue.findUniqueOrThrow({ where: { id: dto.venueId } });
      if (venue.status !== 'active' || !venue.approvedAt) throw new ForbiddenException({ code: 'VENUE_NOT_APPROVED' });
      await this.checkApplication(tx,dto.venueId);
      const previous = await tx.gamingLayoutRevision.findUnique({ where: { requestKey } });
      if (previous) {
        if (previous.requestHash !== hash) throw new ConflictException({ code: 'OPERATION_KEY_REUSED' });
        return { revision: previous.revision, draftVersion: dto.draftVersion, document: previous.document };
      }
      await this.checkApplication(tx,dto.venueId);
      const state = await tx.gamingLayout.findUnique({ where: { venueId: dto.venueId } });
      if (!state || state.revision !== dto.baseRevision || state.draftVersion !== dto.draftVersion) this.conflict(state?.revision ?? 0, state?.draftVersion ?? 0);
      const units = await tx.court.findMany({ where: { venueId: dto.venueId }, select: { id: true } });
      let document;
      try { document = validateLayoutDocument(state!.draft, dto.venueId, new Set(units.map(u => u.id))); } catch { throw new BadRequestException({ code: 'LAYOUT_INVALID' }); }
      const revision = state!.revision + 1;
      await this.applyRooms(tx, dto.venueId, document);
      await tx.gamingLayoutRevision.create({ data: { venueId: dto.venueId, revision, requestKey, requestHash: hash, createdById: user.id, document: document as unknown as Prisma.InputJsonValue } });
      await tx.gamingLayout.update({ where: { venueId: dto.venueId }, data: { revision } });
      await tx.auditLogEntry.create({ data: { actorUserId: user.id, action: 'owner.layout.published', targetType: 'venue', targetId: dto.venueId, metadata: { revision, requestKey } } });
      await tx.gamingOutbox.create({data:{venueId:dto.venueId,entityId:dto.venueId,version:revision,type:'layout.published'}});
      return { revision, draftVersion: state!.draftVersion, document };
    });
  }
  async applyRooms(tx: Prisma.TransactionClient, venueId: string, document: LayoutDocument) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${venueId},91005))::text`;
    const previous = await tx.gamingRoom.findMany({where:{venueId},include:{children:{select:{id:true}}}});
    const proposed = document.floors.flatMap(f=>f.rooms.map(r=>({...r,floorId:f.id,children:document.placements.filter(p=>p.roomId===r.id&&p.unitId).map(p=>p.unitId!).sort()})));
    const hierarchy = (rows: {id:string;occupancy:string;bookableCourtId?:string|null;children:string[]}[]) => JSON.stringify(rows.map(r=>({id:r.id,occupancy:r.occupancy,bookableCourtId:r.bookableCourtId??null,children:r.children.sort()})).sort((a,b)=>a.id.localeCompare(b.id)));
    if(hierarchy(proposed)!==hierarchy(previous.map(r=>({...r,children:r.children.map(c=>c.id)})))) {
      const affected = [...new Set([...previous.flatMap(r=>[r.bookableCourtId,...r.children.map(c=>c.id)]),...proposed.flatMap(r=>[r.bookableCourtId,...r.children])].filter((id):id is string=>!!id))];
      if(await tx.resourceOccupancy.findFirst({where:{resourceId:{in:affected},OR:[{running:true},{endsAt:{gt:new Date()}}]}})) throw new ConflictException({code:'RESOURCE_HAS_DEPENDENCIES'});
    }
    await tx.court.updateMany({where:{venueId,gamingRoomId:{not:null},id:{notIn:proposed.flatMap(r=>r.children)}},data:{gamingRoomId:null}});
    for(const f of document.floors) for(const r of f.rooms) {
      const existing=await tx.gamingRoom.findUnique({where:{id:r.id}});
      if(existing&&existing.venueId!==venueId)throw new ForbiddenException({code:'ROOM_NOT_ACCESSIBLE'});
      await tx.gamingRoom.upsert({where:{id:r.id},create:{id:r.id,venueId,name:r.name,floorId:f.id,occupancy:r.occupancy,bookableCourtId:r.bookableCourtId},update:{name:r.name,floorId:f.id,occupancy:r.occupancy,bookableCourtId:r.bookableCourtId??null}});
    }
    await tx.court.updateMany({where:{venueId,id:{in:document.placements.filter(p=>p.unitId).map(p=>p.unitId!)}},data:{gamingPublished:true}});
    const ids=proposed.map(r=>r.id);
    // Retain stable room history; removed rooms stop grouping resources.
    await tx.gamingRoom.updateMany({where:{venueId,id:{notIn:ids}},data:{occupancy:'independent',bookableCourtId:null}});
    for(const p of document.placements)if(p.unitId&&p.roomId&&!previous.some(r=>r.id===p.roomId&&r.children.some(c=>c.id===p.unitId)))await tx.court.update({where:{id:p.unitId},data:{gamingRoomId:p.roomId}});
    // Guided whole-room setup keeps physical contents visible, but only the room itself bookable.
    // Preserve this when an owner moves furniture and publishes again. Legacy room policies stay intact.
    const wholeRoomChildren=await tx.court.findMany({where:{venueId,gamingRoomId:{in:proposed.filter(r=>r.occupancy==='exclusive').map(r=>r.id)}},select:{id:true,gamingConfig:true,tableConfig:true}});
    const hidden=wholeRoomChildren.filter(u=>(u.gamingConfig as {setupWholeRoomOnly?:boolean}|null)?.setupWholeRoomOnly||(u.tableConfig as {setupWholeRoomOnly?:boolean}|null)?.setupWholeRoomOnly).map(u=>u.id);
    if(hidden.length)await tx.court.updateMany({where:{venueId,id:{in:hidden}},data:{gamingPublished:false}});

  }
  async history(user: AuthenticatedUser, venueId: string) {
    await this.access(user,venueId,'layout.edit',false);
    return this.prisma.gamingLayoutRevision.findMany({where:{venueId},select:{id:true,revision:true,createdAt:true},orderBy:{revision:'desc'},take:100});
  }
  async restore(user: AuthenticatedUser, dto: RestoreGamingLayoutDto) {
    await this.access(user,dto.venueId,'layout.publish',true);
    const requestHash=createHash('sha256').update(JSON.stringify({actor:user.id,...dto})).digest('hex');
    return this.prisma.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM "Venue" WHERE id=${dto.venueId} FOR UPDATE`;
      await assertStaffPermission(tx as PrismaService,user,'layout.publish');
      const venue=await tx.venue.findUniqueOrThrow({where:{id:dto.venueId}});
      if(venue.status!=='active'||!venue.approvedAt)throw new ForbiddenException({code:'VENUE_NOT_APPROVED'});
      await this.checkApplication(tx,dto.venueId);
      const replay=await tx.gamingLayoutRevision.findUnique({where:{requestKey:dto.requestKey}});
      if(replay){if(replay.requestHash!==requestHash)throw new ConflictException({code:'OPERATION_KEY_REUSED'});return {revision:replay.revision,draftVersion:dto.draftVersion+1,document:replay.document};}
      const state=await tx.gamingLayout.findUniqueOrThrow({where:{venueId:dto.venueId}});
      if(state.revision!==dto.baseRevision||state.draftVersion!==dto.draftVersion)this.conflict(state.revision,state.draftVersion);
      const original=await tx.gamingLayoutRevision.findFirst({where:{id:dto.revisionId,venueId:dto.venueId}});
      if(!original)throw new ForbiddenException({code:'REVISION_NOT_ACCESSIBLE'});
      const units=await tx.court.findMany({where:{venueId:dto.venueId},select:{id:true}});
      const document=validateLayoutDocument(original.document,dto.venueId,new Set(units.map(u=>u.id)));
      await this.applyRooms(tx,dto.venueId,document);
      const revision=state.revision+1;
      await tx.gamingLayoutRevision.create({data:{venueId:dto.venueId,revision,document:document as unknown as Prisma.InputJsonValue,createdById:user.id,requestKey:dto.requestKey,requestHash}});
      await tx.gamingLayout.update({where:{venueId:dto.venueId},data:{revision,draft:document as unknown as Prisma.InputJsonValue,draftVersion:{increment:1}}});
      await tx.auditLogEntry.create({data:{actorUserId:user.id,action:'owner.layout.restored',targetType:'venue',targetId:dto.venueId,metadata:{revision,originalRevision:original.revision}}});
      await tx.gamingOutbox.create({data:{venueId:dto.venueId,entityId:dto.venueId,version:revision,type:'layout.published'}});
      return {revision,draftVersion:state.draftVersion+1,document};
    });
  }
}
