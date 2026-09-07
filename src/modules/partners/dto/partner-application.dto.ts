import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  Allow,
  IsBoolean,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
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
  @IsOptional()
  @IsString()
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

  @ApiProperty({ example: 'Corrected public address after map review' })
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  reason!: string;

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

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  note?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
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
