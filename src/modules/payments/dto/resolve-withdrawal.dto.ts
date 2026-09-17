import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class ResolveWithdrawalDto {
  @ApiProperty({ enum: ['paid', 'rejected'] })
  @IsIn(['paid', 'rejected'])
  status!: 'paid' | 'rejected';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
