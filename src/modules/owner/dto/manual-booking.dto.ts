import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateManualBookingDto {
  @ApiProperty()
  @IsUUID()
  venueId!: string;

  @ApiProperty()
  @IsUUID()
  courtId!: string;

  @ApiProperty()
  @IsDateString()
  startsAt!: string;

  @ApiProperty({ minimum: 15, maximum: 720 })
  @Type(() => Number)
  @IsInt()
  @Min(15)
  @Max(720)
  durationMinutes!: number;

  @ApiProperty({ minimum: 0, maximum: 10_000_000 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  priceAmount!: number;

  @ApiPropertyOptional({ enum: ['paid', 'unpaid', 'partial'], default: 'paid' })
  @IsOptional()
  @IsIn(['paid', 'unpaid', 'partial'])
  paymentStatus?: 'paid' | 'unpaid' | 'partial';

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  paidAmount?: number;

  @ApiPropertyOptional({ enum: ['cash', 'instapay', 'wallet', 'card', 'other'] })
  @IsOptional()
  @IsIn(['cash', 'instapay', 'wallet', 'card', 'other'])
  paymentMethod?: 'cash' | 'instapay' | 'wallet' | 'card' | 'other';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  customerName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  customerPhone?: string;

  @ApiPropertyOptional({ enum: ['walk_in', 'phone', 'whatsapp', 'other_platform'] })
  @IsOptional()
  @IsIn(['walk_in', 'phone', 'whatsapp', 'other_platform'])
  sourceKey?: 'walk_in' | 'phone' | 'whatsapp' | 'other_platform';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  sourceLabel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class UpdateManualBookingDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  courtId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(15)
  @Max(720)
  durationMinutes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  priceAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(['paid', 'unpaid', 'partial'])
  paymentStatus?: 'paid' | 'unpaid' | 'partial';

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  paidAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(['cash', 'instapay', 'wallet', 'card', 'other'])
  paymentMethod?: 'cash' | 'instapay' | 'wallet' | 'card' | 'other';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  customerName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  customerPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(['walk_in', 'phone', 'whatsapp', 'other_platform'])
  sourceKey?: 'walk_in' | 'phone' | 'whatsapp' | 'other_platform';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  sourceLabel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class AddManualPaymentDto {
  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  amount!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(['cash', 'instapay', 'wallet', 'card', 'other'])
  method?: 'cash' | 'instapay' | 'wallet' | 'card' | 'other';
}

export class OwnerSummaryQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  venueId?: string;

  @ApiPropertyOptional({ enum: ['today', 'yesterday', 'this_week', 'last_7_days', 'this_month', 'last_month', 'custom'] })
  @IsOptional()
  @IsIn(['today', 'yesterday', 'this_week', 'last_7_days', 'this_month', 'last_month', 'custom'])
  range?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  to?: string;
}

export class OwnerRemittanceDto {
  @ApiProperty()
  @IsUUID()
  venueId!: string;

  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  amount!: number;

  @ApiProperty()
  @IsIn(['bank', 'instapay', 'wallet', 'cash', 'other'])
  method!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  reference?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  receiptUrl?: string;
}
