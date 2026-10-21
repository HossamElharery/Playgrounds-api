import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export const CUSTOMER_MESSAGE_KINDS = ['confirm', 'reminder', 'balance', 'cancel'] as const;
export type CustomerMessageKind = (typeof CUSTOMER_MESSAGE_KINDS)[number];

export class CustomerMessageDto {
  @ApiProperty({ enum: CUSTOMER_MESSAGE_KINDS })
  @IsIn(CUSTOMER_MESSAGE_KINDS)
  kind!: CustomerMessageKind;
}
