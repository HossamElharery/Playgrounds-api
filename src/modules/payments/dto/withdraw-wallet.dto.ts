import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, Max, Min, MaxLength, MinLength } from 'class-validator';

export class WithdrawWalletDto {
  @ApiProperty({ description: 'Amount in minor currency units (piasters)', example: 20000 })
  @IsInt()
  @Min(5000)
  @Max(10_000_000)
  amount!: number;

  @ApiProperty({
    description: 'Where the payout should be sent — a mobile wallet number, IBAN, etc.',
    example: '01012345678 (Vodafone Cash)',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  destination!: string;
}
