import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { PLAN_KEYS, type PlanKey } from '../subscription-plans';

export class ExtendSubscriptionDto {
  @ApiPropertyOptional({ description: 'Days to add, 1–3650' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  days!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  amount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  method?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  paidAt?: string;
}

export class UpdateSubscriptionTermsDto {
  @ApiPropertyOptional({ enum: PLAN_KEYS, description: 'Changing the plan also sets its list price unless listPriceAmount is sent.' })
  @IsOptional()
  @IsIn(PLAN_KEYS)
  planKey?: PlanKey;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  listPriceAmount?: number;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  agreedPriceAmount?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  graceDays?: number;

  @ApiPropertyOptional({ description: 'Set the paid-through date directly' })
  @IsOptional()
  @IsDateString()
  currentPeriodEnd?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}
