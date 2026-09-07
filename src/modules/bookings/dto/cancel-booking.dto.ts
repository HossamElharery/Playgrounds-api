import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class CancelBookingDto {
  @ApiPropertyOptional({ example: 'Plans changed' })
  @IsOptional()
  @IsString()
  reason?: string;
}
