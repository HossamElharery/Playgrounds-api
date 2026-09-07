import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { PaymentMethod } from '@prisma/client';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const PAYMENT_METHODS = [
  'card',
  'wallet',
  'apple_pay',
  'google_pay',
  'paypal',
  'cash',
  'vodafone',
  'orange',
  'etisalat',
  'fawry',
  'instapay',
  'mada',
  'stc_pay',
  'benefit',
  'knet',
] as const satisfies readonly PaymentMethod[];

export class CreateMembershipPlanDto {
  @IsString()
  @MaxLength(80)
  slug!: string;

  @IsString()
  @MaxLength(120)
  nameEn!: string;

  @IsString()
  @MaxLength(120)
  nameAr!: string;

  @ApiProperty({ enum: ['gaming', 'all-activities'] })
  @IsIn(['gaming', 'all-activities'])
  scope!: string;

  @ApiProperty({ description: 'Minor currency units (e.g. piasters)' })
  @IsInt()
  @Min(0)
  priceAmount!: number;

  @ApiPropertyOptional({ default: 'EGP' })
  @IsOptional()
  @IsString()
  priceCurrency?: string;

  @IsInt()
  @Min(1)
  includedHours!: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  overageDiscountPercent?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  perksEn?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  perksAr?: string[];
}

export class UpdateMembershipPlanDto extends PartialType(
  CreateMembershipPlanDto,
) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class SubscribeMembershipDto {
  @ApiProperty()
  @IsString()
  planId!: string;

  @ApiProperty({ example: 'card', enum: PAYMENT_METHODS })
  @IsIn([...PAYMENT_METHODS])
  paymentMethod!: PaymentMethod;
}
