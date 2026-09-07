import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class ValidatePromoDto {
  @ApiProperty({ example: 'WELCOME25' })
  @IsString()
  code!: string;

  @ApiPropertyOptional({
    example: 25000,
    description: 'Booking amount in piasters (250 EGP = 25000)',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  amount?: number;
}
