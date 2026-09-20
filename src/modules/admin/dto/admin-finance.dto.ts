import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';

export class AdminReasonDto {
  @ApiProperty({ minLength: 5, maxLength: 300 })
  @IsString()
  @MinLength(5)
  @MaxLength(300)
  reason!: string;
}

export class AdminCommissionDto extends AdminReasonDto {
  @ApiPropertyOptional({ nullable: true, minimum: 0, maximum: 5000 })
  @ValidateIf((_, v) => v !== null)
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(5000)
  percentageBps?: number | null;
}

export class AdminPaymentModeDto extends AdminReasonDto {
  @ApiProperty({ enum: ['at_venue', 'online'] })
  @IsIn(['at_venue', 'online'])
  paymentMode!: 'at_venue' | 'online';
}

export class AdminGlobalCommissionDto extends AdminReasonDto {
  @ApiProperty({ minimum: 0, maximum: 5000 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(5000)
  percentageBps!: number;
}

export class AdminPayoutDto extends AdminReasonDto {
  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  amount!: number;

  @ApiProperty()
  @IsString()
  @MinLength(3)
  @MaxLength(8)
  currency!: string;

  @ApiProperty({ enum: ['bank', 'instapay', 'wallet', 'cash', 'other'] })
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  allowOverpay?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  expectedBalance?: number;
}

export class AdminRemittanceDto extends AdminPayoutDto {}

export class AdminAdjustmentDto {
  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  amount!: number;

  @ApiProperty({ minLength: 10, maxLength: 300 })
  @IsString()
  @MinLength(10)
  @MaxLength(300)
  reason!: string;
}

export class AdminConfirmSettlementDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(5)
  @MaxLength(300)
  reason?: string;
}

export class AdminRejectSettlementDto {
  @ApiProperty({ minLength: 5, maxLength: 300 })
  @IsString()
  @MinLength(5)
  @MaxLength(300)
  reason!: string;
}

export class AdminVerifyLedgerDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  repair?: boolean;

  @ApiProperty({ minLength: 5, maxLength: 300 })
  @IsString()
  @MinLength(5)
  @MaxLength(300)
  reason!: string;
}

export class AdminBalancesQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ enum: ['matchena_owes', 'owner_owes', 'settled'] })
  @IsOptional()
  @IsIn(['matchena_owes', 'owner_owes', 'settled'])
  direction?: 'matchena_owes' | 'owner_owes' | 'settled';

  @ApiPropertyOptional({ enum: ['at_venue', 'online'] })
  @IsOptional()
  @IsIn(['at_venue', 'online'])
  paymentMode?: 'at_venue' | 'online';

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minAbsBalance?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
