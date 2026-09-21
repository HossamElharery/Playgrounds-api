import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  Allow,
  IsBoolean,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsObject,
  IsOptional,
  IsPhoneNumber,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * Normalizes optional free-text so that empty/whitespace strings become
 * `undefined`. Combined with `@IsOptional()`, this lets clients send an empty
 * note/reason (e.g. approving without feedback) without tripping `@MinLength`.
 */
const OptionalText = () =>
  Transform(({ value }) =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined,
  );
import { CursorPaginationQueryDto } from '../../../common/pagination/cursor-pagination.dto';

export class PartnerCourtDraftDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  id?: string;

  @ApiPropertyOptional({ example: 'Court 1' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ example: 'sport-padel' })
  @IsOptional()
  @IsString()
  sportId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  surface?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  indoor?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  format?: string;

  @ApiPropertyOptional({ example: 90 })
  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(180)
  slotDurationMins?: number;

  @ApiPropertyOptional({ example: 15000 })
  @IsOptional()
  @IsInt()
  @Min(1)
  basePriceAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  peakPriceAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString({ each: true })
  amenityKeys?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  spec?: Record<string, unknown>;
}

export class PartnerPhotoDraftDto {
  @ApiProperty()
  @IsString()
  @MaxLength(2000)
  url!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isCover?: boolean;
}

export class PartnerApplicationPayloadDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  publicNameEn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  publicNameAr?: string;

  @ApiPropertyOptional()
  @OptionalText()
  @IsOptional()
  @IsPhoneNumber()
  @MaxLength(20)
  contactPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  descriptionEn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  descriptionAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(160)
  legalBusinessName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  registrationNumber?: string;

  @ApiPropertyOptional({ example: 'EG' })
  @IsOptional()
  @IsString()
  @MaxLength(2)
  countryCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  governorateId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  districtId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(240)
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsLatitude()
  lat?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsLongitude()
  lng?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  locationConfirmed?: boolean;

  @ApiPropertyOptional({ type: [PartnerCourtDraftDto] })
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => PartnerCourtDraftDto)
  courts?: PartnerCourtDraftDto[];

  @ApiPropertyOptional({
    description: 'Weekday 0=Sun .. 6=Sat → { closed, open, close }',
  })
  @IsOptional()
  @IsObject()
  weeklyHours?: Record<string, { closed: boolean; open?: string; close?: string }>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  cancellationPolicy?: string;

  @ApiPropertyOptional({
    enum: ['flexible_24h', 'flexible_12h', 'non_refundable', 'custom'],
  })
  @IsOptional()
  @IsIn(['flexible_24h', 'flexible_12h', 'non_refundable', 'custom'])
  cancellationPreset?: 'flexible_24h' | 'flexible_12h' | 'non_refundable' | 'custom';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  houseRules?: string;

  @ApiPropertyOptional({ type: [PartnerPhotoDraftDto] })
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => PartnerPhotoDraftDto)
  photos?: PartnerPhotoDraftDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  verificationDocumentUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  consent?: boolean;
}

export class CreatePartnerApplicationDto {
  @ApiProperty({ type: PartnerApplicationPayloadDto })
  @ValidateNested()
  @Type(() => PartnerApplicationPayloadDto)
  payload!: PartnerApplicationPayloadDto;
}

export class PatchPartnerApplicationDto {
  @ApiProperty({ type: PartnerApplicationPayloadDto })
  @ValidateNested()
  @Type(() => PartnerApplicationPayloadDto)
  payload!: PartnerApplicationPayloadDto;

  @ApiPropertyOptional({
    description: 'Expected version. Stale writes return 409 APPLICATION_VERSION_CONFLICT.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}

export class AdminAmendPartnerApplicationDto {
  @ApiPropertyOptional({
    description:
      'Full listing payload. When provided, the admin can edit everything (gallery, courts, hours, policies, amenities…) — same shape owners submit.',
    type: PartnerApplicationPayloadDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => PartnerApplicationPayloadDto)
  payload?: PartnerApplicationPayloadDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  publicNameEn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  publicNameAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  descriptionEn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  descriptionAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(240)
  address?: string;

  @ApiPropertyOptional({
    description:
      'Optional. When provided (10–1000 chars) it is recorded in the timeline and the partner is notified. Omit for silent admin curation.',
    example: 'Corrected public address after map review',
  })
  @IsOptional()
  @OptionalText()
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  reason?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}

export class PartnerDecisionDto {
  @ApiProperty({
    enum: ['approve', 'reject', 'request_changes', 'suspend'],
  })
  @IsIn(['approve', 'reject', 'request_changes', 'suspend'])
  action!: 'approve' | 'reject' | 'request_changes' | 'suspend';

  @ApiPropertyOptional({
    description:
      'Optional for approve and suspend. Required (10–1000 chars) only for reject and request_changes; enforced in the service. Admins do not need a note to publish.',
  })
  @IsOptional()
  @OptionalText()
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  note?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;

  @ApiPropertyOptional({
    description: 'Approve only: how many days the venue is covered for (1–3650), e.g. 90 for three months paid.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  subscriptionDays?: number;

  @ApiPropertyOptional({ description: 'Approve only: the price agreed with the owner, minor units. Admin-only.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  agreedPriceAmount?: number;
}

export class AdminPartnerApplicationsQueryDto extends CursorPaginationQueryDto {
  @ApiPropertyOptional({
    enum: [
      'draft',
      'pending',
      'changes_requested',
      'approved',
      'rejected',
      'suspended',
    ],
  })
  @IsOptional()
  @IsIn([
    'draft',
    'pending',
    'changes_requested',
    'approved',
    'rejected',
    'suspended',
  ])
  status?:
    | 'draft'
    | 'pending'
    | 'changes_requested'
    | 'approved'
    | 'rejected'
    | 'suspended';
}

/** Keeps class-validator happy if a client sends an unused wrapper field. */
export class EmptyBodyDto {
  @Allow()
  @IsOptional()
  noop?: never;
}
