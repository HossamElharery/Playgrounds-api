import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaymentMethod } from '@prisma/client';

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

export class BundleItemDto {
  @ApiProperty()
  @IsString()
  courtId!: string;

  @ApiProperty({ minimum: 1, maximum: 4 })
  @IsInt()
  @Min(1)
  @Max(4)
  durationUnits!: number;
}

export class CreateBundleDto {
  @IsString()
  @MaxLength(120)
  nameEn!: string;

  @IsString()
  @MaxLength(120)
  nameAr!: string;

  @ApiProperty({ minimum: 5, maximum: 50 })
  @IsInt()
  @Min(5)
  @Max(50)
  discountPercent!: number;

  @ApiProperty({ type: [BundleItemDto], minItems: 2, maxItems: 4 })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => BundleItemDto)
  items!: BundleItemDto[];
}

export class UpdateBundleDto extends PartialType(CreateBundleDto) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class PurchaseBundleDto {
  @ApiProperty()
  @IsString()
  bundleId!: string;

  @ApiProperty({ example: '2026-09-10' })
  @IsString()
  date!: string;

  /** Wall-clock start time (HH:mm) per courtId — every bundle item needs one. */
  @ApiProperty({ example: { 'court-1': '18:00', 'court-2': '19:00' } })
  @IsObject()
  startTimes!: Record<string, string>;

  @ApiProperty({ example: 'card', enum: PAYMENT_METHODS })
  @IsIn([...PAYMENT_METHODS])
  paymentMethod!: PaymentMethod;
}
