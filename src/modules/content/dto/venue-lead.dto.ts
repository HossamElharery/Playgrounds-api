import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsPhoneNumber,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { normalizeOptionalPhone } from '../../../common/utils/phone.util';

function trimString(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

function upperCode(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toUpperCase() : value;
}

function emptyToUndefined(value: unknown): unknown {
  const trimmed = trimString(value);
  return trimmed === '' || trimmed === null ? undefined : trimmed;
}

/**
 * A venue owner asking to try the Matchena system from the /partners landing pages.
 * Phone comes first: owners in Egypt answer WhatsApp, not email.
 */
export class CreateVenueLeadDto {
  @ApiProperty({ example: 'Omar Hassan' })
  @Transform(({ value }) => trimString(value))
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  fullName!: string;

  @ApiProperty({ example: '+201001234567' })
  @Transform(({ value }) => normalizeOptionalPhone(value) ?? undefined)
  @IsPhoneNumber()
  phone!: string;

  @ApiPropertyOptional({ example: 'Golden Goal Courts' })
  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @IsString()
  @MaxLength(120)
  venueName?: string;

  @ApiPropertyOptional({ example: 'Nasr City, Cairo' })
  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @IsString()
  @MaxLength(80)
  city?: string;

  @ApiPropertyOptional({ example: ['football', 'padel'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  sports?: string[];

  @ApiPropertyOptional({
    example: 3,
    description: 'Courts, tables or devices at the venue.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  units?: number;

  @ApiPropertyOptional({ example: 'owner@mail.com' })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' && value.trim()
      ? value.trim().toLowerCase()
      : undefined,
  )
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional({ example: 'We take bookings on WhatsApp today.' })
  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @IsString()
  @MaxLength(1000)
  message?: string;

  @ApiPropertyOptional({
    example: '/ar/partners/padel',
    description: 'Landing page the form was sent from.',
  })
  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @IsString()
  @MaxLength(160)
  source?: string;

  @ApiPropertyOptional({ example: 'facebook / cpc / owners-cairo' })
  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @IsString()
  @MaxLength(200)
  campaign?: string;

  @ApiPropertyOptional({
    example: 'SA',
    description:
      'Country the owner picked or the page guessed (ISO 3166-1 alpha-2).',
  })
  @IsOptional()
  @Transform(({ value }) => upperCode(value))
  @Matches(/^[A-Z]{2}$/)
  country?: string;

  @ApiPropertyOptional({ enum: ['ar', 'en'] })
  @IsOptional()
  @IsIn(['ar', 'en'])
  lang?: 'ar' | 'en';

  /** Honeypot. Hidden from people; a filled value means a bot, and the lead is dropped quietly. */
  @ApiPropertyOptional({ description: 'Leave empty.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string;
}
