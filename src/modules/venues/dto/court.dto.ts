import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class CreateCourtDto {
  @ApiProperty({ example: 'sport-football-5' })
  @IsString()
  sportId!: string;

  @ApiProperty({ example: 'Court 1' })
  @IsString()
  name!: string;

  @ApiPropertyOptional({ example: 'artificial' })
  @IsOptional()
  @IsString()
  surface?: string;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  indoor?: boolean;

  @ApiPropertyOptional({ example: '5v5' })
  @IsOptional()
  @IsString()
  format?: string;

  @ApiPropertyOptional({ example: 60 })
  @IsOptional()
  @IsInt()
  @Min(15)
  slotDurationMins?: number;
}

export class UpdateCourtDto {
  @ApiPropertyOptional({ example: 'Court 1 — floodlit' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ example: 'artificial' })
  @IsOptional()
  @IsString()
  surface?: string;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  indoor?: boolean;

  @ApiPropertyOptional({ example: '5v5' })
  @IsOptional()
  @IsString()
  format?: string;

  @ApiPropertyOptional({ example: 60 })
  @IsOptional()
  @IsInt()
  @Min(15)
  slotDurationMins?: number;
}
