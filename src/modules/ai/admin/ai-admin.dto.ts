import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PageQueryDto } from '../../../common/dto/page-query.dto';
import { TRANSCRIPT_FLAGS, type TranscriptFlag } from '../transcript/transcript-flags';

const OUTCOMES = ['answered_fact', 'answered_faq', 'venues', 'no_results', 'bookings', 'nav', 'smalltalk', 'unanswered', 'clarify', 'limited', 'unavailable', 'blocked'] as const;
const STATUSES = ['new', 'reviewed', 'resolved', 'ignored'] as const;

export class ListAiQuestionsDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: OUTCOMES })
  @IsOptional()
  @IsIn(OUTCOMES as unknown as string[])
  outcome?: (typeof OUTCOMES)[number];

  @ApiPropertyOptional({ enum: ['ar', 'en'] })
  @IsOptional()
  @IsIn(['ar', 'en'])
  lang?: 'ar' | 'en';

  @ApiPropertyOptional({ enum: ['guest', 'player'] })
  @IsOptional()
  @IsIn(['guest', 'player'])
  userKind?: 'guest' | 'player';

  @ApiPropertyOptional({ enum: STATUSES })
  @IsOptional()
  @IsIn(STATUSES as unknown as string[])
  status?: (typeof STATUSES)[number];

  @ApiPropertyOptional({ enum: ['up', 'down'] })
  @IsOptional()
  @IsIn(['up', 'down'])
  feedback?: 'up' | 'down';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;
}

export class ListOwnerRequestsDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: ['planned', 'clarify', 'denied', 'unavailable', 'limited', 'error'] })
  @IsOptional()
  @IsIn(['planned', 'clarify', 'denied', 'unavailable', 'limited', 'error'])
  outcome?: string;

  @ApiPropertyOptional({ description: 'Searches the sentence, the owner’s name and the venue’s name.' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  venueId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  ownerId?: string;

  @ApiPropertyOptional({ enum: TRANSCRIPT_FLAGS })
  @IsOptional()
  @IsIn(TRANSCRIPT_FLAGS)
  flag?: TranscriptFlag;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  notable?: boolean;
}

export class OwnerRequestsSummaryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 90 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  days?: number;
}

export class SetQuestionStatusDto {
  @ApiProperty({ enum: STATUSES })
  @IsIn(STATUSES as unknown as string[])
  status!: (typeof STATUSES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  ids?: string[];
}

export class ResolveQuestionDto {
  @ApiPropertyOptional({ description: 'The knowledge entry that now answers it; the question is re-asked to prove it is chosen.' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  knowledgeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  ids?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  verify?: boolean;
}

export class KnowledgeBodyDto {
  @IsOptional() @IsString() @MaxLength(80) id?: string;
  @IsOptional() @IsString() @MaxLength(400) topicAr?: string;
  @IsOptional() @IsString() @MaxLength(400) topicEn?: string;
  @IsOptional() @IsString() @MaxLength(2000) ar?: string;
  @IsOptional() @IsString() @MaxLength(2000) en?: string;
  @IsOptional() @IsString() @MaxLength(200) ctaTarget?: string;
  @IsOptional() @IsString() @MaxLength(200) ctaLabelAr?: string;
  @IsOptional() @IsString() @MaxLength(200) ctaLabelEn?: string;
  @IsOptional() @IsString() @MaxLength(20) flag?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class ValidateKnowledgeDto {
  @IsObject()
  entry!: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  creating?: boolean;
}

export class RestoreKnowledgeDto {
  @ApiProperty()
  @IsString()
  @MaxLength(60)
  revisionId!: string;
}

export class ReorderKnowledgeDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(300)
  @IsString({ each: true })
  ids!: string[];
}

export class PreviewKnowledgeDto {
  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(300)
  text!: string;

  @ApiPropertyOptional({ enum: ['ar', 'en'] })
  @IsOptional()
  @IsIn(['ar', 'en'])
  lang?: 'ar' | 'en';

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  loggedIn?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  draft?: Record<string, unknown>;
}

export class DraftKnowledgeDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  question?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(700)
  answerAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(700)
  answerEn?: string;
}

export class UpdateLimitsDto {
  @ApiProperty()
  @IsObject()
  values!: Record<string, unknown>;
}

export class StartEvalDto {
  @ApiProperty({ enum: ['captain', 'owner', 'both'] })
  @IsIn(['captain', 'owner', 'both'])
  kind!: 'captain' | 'owner' | 'both';

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsString({ each: true })
  models?: string[];

  @ApiPropertyOptional({ enum: ['minimal', 'low', 'medium', 'high'] })
  @IsOptional()
  @IsIn(['minimal', 'low', 'medium', 'high'])
  reasoning?: string;
}

export class StartShadowDto {
  @ApiProperty({ example: 'google/gemini-3.6-flash' })
  @IsString()
  @MaxLength(100)
  model!: string;

  @ApiPropertyOptional({ maximum: 40 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(40)
  sampleSize?: number;

  @ApiPropertyOptional({ maximum: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30)
  days?: number;
}

export class ListVenueCreditDto {
  @ApiPropertyOptional({ description: 'Searches the venue’s and the owner’s name.' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;
}

export class UpdateVenueCreditDto {
  @ApiPropertyOptional({ description: 'The assistant for the owner and every staff login of this venue.' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: 'Monthly credit in USD instead of the plan’s; null goes back to the plan.', nullable: true })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(500)
  overrideUsd?: number | null;

  @ApiPropertyOptional({ description: 'End the trial now: the plan’s monthly credit starts with a fresh window.' })
  @IsOptional()
  @IsIn([true])
  endTrial?: true;
}

export class AiCreditTopUpDto {
  @ApiProperty({ description: 'What Matchena collected, in minor units. Admin only; 0 for a gift.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  receivedAmount!: number;

  @ApiProperty({ example: 'EGP' })
  @Matches(/^[A-Z]{3}$/)
  receivedCurrency!: string;

  @ApiProperty({ description: 'What the venue gets, in USD. The only number the owner ever sees.' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(500)
  creditedUsd!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
