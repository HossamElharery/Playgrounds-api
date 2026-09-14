import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, Max, Min } from 'class-validator';
import { PaymentMethod } from '@prisma/client';

/** PSP methods allowed for wallet top-up. Cash stays owner walk-in only. */
export const WALLET_TOP_UP_METHODS = [
  'card',
  'vodafone',
  'orange',
  'etisalat',
  'fawry',
  'instapay',
  'apple_pay',
  'google_pay',
  'mada',
  'stc_pay',
  'benefit',
  'knet',
  'paypal',
] as const satisfies readonly PaymentMethod[];

export class TopUpWalletDto {
  @ApiProperty({ description: 'Amount in minor currency units (piasters)', example: 20000 })
  @IsInt()
  @Min(5000)
  @Max(10_000_000)
  amount!: number;

  @ApiProperty({ enum: WALLET_TOP_UP_METHODS, example: 'card' })
  @IsIn([...WALLET_TOP_UP_METHODS])
  method!: PaymentMethod;
}
