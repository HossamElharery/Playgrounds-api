import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PaymentMethod } from '@prisma/client';

export class SplitShareInputDto {
  @ApiPropertyOptional({ example: 'user-uuid-of-teammate' })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ example: '+201001234567' })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiProperty({ example: 12500, description: 'Share amount in piasters (EGP × 100)' })
  @IsInt()
  @Min(1)
  amount!: number;
}

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

export class ConfirmBookingDto {
  @ApiProperty({
    example: 'card',
    enum: PAYMENT_METHODS,
    description: 'card/wallet settle instantly in mock; cash stays pending until check-in',
  })
  @IsIn([...PAYMENT_METHODS])
  paymentMethod!: PaymentMethod;

  @ApiPropertyOptional({ type: [SplitShareInputDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SplitShareInputDto)
  splitShares?: SplitShareInputDto[];
}
