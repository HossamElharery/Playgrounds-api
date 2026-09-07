import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class CreateTeamDto {
  @ApiProperty({ example: 'Nasr City Lions' })
  @IsString()
  name!: string;

  @ApiPropertyOptional({ example: 'https://example.com/logo.png' })
  @IsOptional()
  @IsString()
  logoUrl?: string;

  @ApiPropertyOptional({ example: 'sport-football-5' })
  @IsOptional()
  @IsString()
  sportId?: string;
}
