import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class UpsertFeatureFlagDto {
  @ApiProperty({ example: 'pulse.enabled' })
  @IsString()
  key!: string;

  @ApiProperty({ example: true })
  @IsBoolean()
  enabled!: boolean;

  @ApiPropertyOptional({ example: 'Show Pulse feed to players' })
  @IsOptional()
  @IsString()
  description?: string;
}
