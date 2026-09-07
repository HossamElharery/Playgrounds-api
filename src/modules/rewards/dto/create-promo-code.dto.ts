import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class CreatePromoCodeDto {
  @ApiProperty({ example: 'WELCOME25' })
  @IsString()
  code!: string;

  @ApiProperty({ example: 'percentage', enum: ['percentage', 'fixed_amount'] })
  @IsIn(['percentage', 'fixed_amount'])
  type!: 'percentage' | 'fixed_amount';

  @ApiProperty({ example: 25, description: 'Percent or piasters depending on type' })
  @IsInt()
  @Min(1)
  value!: number;

  @ApiPropertyOptional({ example: 'sport-padel' })
  @IsOptional()
  @IsString()
  sportId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  venueId?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  firstBookingOnly?: boolean;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  offPeakOnly?: boolean;

  @ApiPropertyOptional({ example: 10000 })
  @IsOptional()
  @IsInt()
  minBookingAmount?: number;

  @ApiPropertyOptional({ example: 1000 })
  @IsOptional()
  @IsInt()
  usageLimitTotal?: number;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsInt()
  usageLimitPerUser?: number;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  stackableWithCoins?: boolean;

  @ApiProperty({ example: '2026-09-01T00:00:00.000Z' })
  @IsDateString()
  validFrom!: string;

  @ApiProperty({ example: '2026-12-31T23:59:59.000Z' })
  @IsDateString()
  validUntil!: string;
}
