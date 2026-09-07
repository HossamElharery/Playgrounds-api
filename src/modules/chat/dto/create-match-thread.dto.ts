import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class CreateMatchThreadDto {
  @ApiProperty({ example: 'match-post-uuid' })
  @IsString()
  matchPostId!: string;

  @ApiPropertyOptional({ example: 'Nasr City Friday game' })
  @IsOptional()
  @IsString()
  title?: string;
}

export class CreateTeamThreadDto {
  @ApiProperty({ example: 'team-uuid' })
  @IsString()
  teamId!: string;

  @ApiPropertyOptional({ example: 'Lions chat' })
  @IsOptional()
  @IsString()
  title?: string;
}
