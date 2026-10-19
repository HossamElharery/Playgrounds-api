import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class RingingDto {
  @ApiPropertyOptional({ description: 'Whether the native call UI is ringing' })
  @IsOptional()
  @IsBoolean()
  native?: boolean;
}
