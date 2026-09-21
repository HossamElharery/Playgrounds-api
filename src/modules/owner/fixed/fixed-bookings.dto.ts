import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class FixedSeriesShapeDto {
  @ApiProperty()
  @IsUUID()
  venueId!: string;

  @ApiProperty()
  @IsUUID()
  courtId!: string;

  /** First session, as an instant. Weekday and hour are read in the venue's timezone. */
  @ApiProperty()
  @IsDateString()
  startsAt!: string;

  @ApiProperty({ minimum: 15, maximum: 720 })
  @Type(() => Number)
  @IsInt()
  @Min(15)
  @Max(720)
  durationMinutes!: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 53, description: 'Number of weekly sessions' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(53)
  weeks?: number;

  @ApiPropertyOptional({ description: 'Last session date (venue-local YYYY-MM-DD), inclusive' })
  @IsOptional()
  @Matches(LOCAL_DATE)
  until?: string;

  @ApiPropertyOptional({ description: 'Fixed price per session in minor units; omit to quote each session' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  priceAmount?: number;

  @ApiPropertyOptional({ type: [String], description: 'Local dates to leave out' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @Matches(LOCAL_DATE, { each: true })
  skipDates?: string[];
}

export class CreateFixedSeriesDto extends FixedSeriesShapeDto {
  @ApiProperty()
  @IsString()
  @MaxLength(80)
  customerName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  customerPhone?: string;

  @ApiPropertyOptional({ enum: ['per_session', 'prepaid'], default: 'per_session' })
  @IsOptional()
  @IsIn(['per_session', 'prepaid'])
  paymentPlan?: 'per_session' | 'prepaid';

  /** Deposit taken on the first session when the plan is `prepaid` (minor units). */
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  prepaidAmount?: number;

  @ApiPropertyOptional({ enum: ['cash', 'instapay', 'wallet', 'card', 'other'] })
  @IsOptional()
  @IsIn(['cash', 'instapay', 'wallet', 'card', 'other'])
  paymentMethod?: 'cash' | 'instapay' | 'wallet' | 'card' | 'other';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  sourceKey?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  sourceLabel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class SeriesDateDto {
  @ApiProperty({ description: 'Venue-local date YYYY-MM-DD' })
  @Matches(LOCAL_DATE)
  date!: string;
}

export class RescheduleSeriesDto {
  @ApiProperty({ description: 'First local date that gets the new time' })
  @Matches(LOCAL_DATE)
  fromDate!: string;

  @ApiProperty({ example: '21:00' })
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  startTime!: string;

  @ApiPropertyOptional({ minimum: 15, maximum: 720 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(15)
  @Max(720)
  durationMinutes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  courtId?: string;

  @ApiPropertyOptional({ description: 'Only report conflicts, change nothing' })
  @IsOptional()
  preview?: boolean;
}
