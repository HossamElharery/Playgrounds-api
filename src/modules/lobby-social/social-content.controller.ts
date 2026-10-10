import { Body, Controller, Get, Post, Put, Param, UseGuards, Injectable, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { IsIn, IsInt, IsString, Min, MaxLength, MinLength, Matches, IsArray, ArrayMaxSize } from 'class-validator';
import { AuthGuard } from '../../common/guards/auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { SocialQuestion } from './social.types';
import { EGYPTIAN_SOCIAL_BANK } from './social.egyptian-bank';

export class SocialQuestionDto {
  @IsString() @MinLength(8) @MaxLength(300) text!:string;
  @IsIn(['light','stories','closer']) mode!:SocialQuestion['mode'];
  @IsString() @Matches(/^[a-z0-9][a-z0-9-]{1,79}$/) familyId!:string;
  @IsArray() @ArrayMaxSize(8) @IsString({each:true}) @MaxLength(40,{each:true}) tags!:string[];
  @IsIn(['draft','published']) status!:SocialQuestion['status'];
  @IsInt() @Min(0) version!:number;
}
@Injectable()
export class SocialContentService {
  constructor(private readonly prisma:PrismaService){}
  async list():Promise<SocialQuestion[]> {
    const rows=await this.prisma.$queryRaw<{data:SocialQuestion;version:number}[]>(Prisma.sql`SELECT "data", "version" FROM "LobbySocialQuestion" ORDER BY "id"`);
    const overrides=new Map(rows.map(r=>[r.data.id,{...r.data,version:r.version}]));
    return [...EGYPTIAN_SOCIAL_BANK.map(q=>overrides.get(q.id)??q),...rows.filter(r=>!EGYPTIAN_SOCIAL_BANK.some(q=>q.id===r.data.id)).map(r=>({...r.data,version:r.version}))];
  }
  async save(id:string,dto:SocialQuestionDto,adminId:string):Promise<SocialQuestion> {
    if(dto.text.trim().length<8)throw new BadRequestException('Question text is too short');
    return this.prisma.$transaction(async tx=>{
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`social-content:${id}`}))`);
      const rows=await tx.$queryRaw<{version:number}[]>(Prisma.sql`SELECT "version" FROM "LobbySocialQuestion" WHERE "id"=${id}`);
      const seed=EGYPTIAN_SOCIAL_BANK.find(q=>q.id===id);
      const current=rows[0]?.version??seed?.version??0;
      if(current!==dto.version)throw new ConflictException('Question changed; refresh before saving');
      const question:SocialQuestion={id,text:dto.text.trim(),familyId:dto.familyId,mode:dto.mode,tags:dto.tags,locale:'ar-EG',status:dto.status,version:current+1,reviewedAt:dto.status==='published'?new Date().toISOString():null};
      await tx.$executeRaw(Prisma.sql`INSERT INTO "LobbySocialQuestion" ("id","data","version","updatedBy") VALUES (${id},${JSON.stringify(question)}::jsonb,${question.version},${adminId}) ON CONFLICT ("id") DO UPDATE SET "data"=EXCLUDED."data", "version"=EXCLUDED."version", "updatedBy"=EXCLUDED."updatedBy", "updatedAt"=CURRENT_TIMESTAMP`);
      return question;
    });
  }
}
@Controller('admin/social-questions')
@UseGuards(AuthGuard)
@Roles('admin')
export class SocialContentController {
  constructor(private readonly content:SocialContentService){}
  @Get() list(){return this.content.list();}
  @Post() create(@Body() dto:SocialQuestionDto,@CurrentUser() admin:{id:string}){return this.content.save(crypto.randomUUID(),{...dto,version:0},admin.id);}
  @Put(':id') async update(@Param('id') id:string,@Body() dto:SocialQuestionDto,@CurrentUser() admin:{id:string}){
    if(!(await this.content.list()).some(q=>q.id===id))throw new NotFoundException();
    return this.content.save(id,dto,admin.id);
  }
}
