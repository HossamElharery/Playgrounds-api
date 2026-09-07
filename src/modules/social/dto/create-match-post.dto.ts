import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class CreateMatchPostDto {
  @ApiProperty({ example: 'sport-football-5' })
  @IsString()
  sportId!: string;

  @ApiPropertyOptional({ example: 'b0c6ee30-43c7-4d7c-b21b-2ba2768f1837' })
  @IsOptional()
  @IsString()
  venueId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  courtId?: string;

  @ApiPropertyOptional({ example: 'dist-nasr-city' })
  @IsOptional()
  @IsString()
  districtId?: string;

  @ApiProperty({ example: '2026-09-12T18:00:00.000Z' })
  @IsDateString()
  dateTime!: string;

  @ApiProperty({ example: 4 })
  @IsInt()
  @Min(1)
  playersNeeded!: number;

  @ApiPropertyOptional({
    example: 'silver',
    enum: ['bronze', 'silver', 'gold', 'platinum', 'legend'],
  })
  @IsOptional()
  @IsIn(['bronze', 'silver', 'gold', 'platinum', 'legend'])
  skillTier?: string;

  @ApiPropertyOptional({
    example: 5000,
    description: 'Cost per player in piasters',
  })
  @IsOptional()
  @IsInt()
  costPerPlayerAmount?: number;

  @ApiPropertyOptional({ example: 'Need 2 defenders, friendly game' })
  @IsOptional()
  @IsString()
  notes?: string;

  // Mal3ab gaming expansion — MAL3AB_GAMING_EXPANSION_BLUEPRINT.md §3.6/§3.10.
  @ApiPropertyOptional({
    description: 'GameCatalogEntry id/slug — only for gaming-station sports',
  })
  @IsOptional()
  @IsString()
  gameId?: string;

  @ApiPropertyOptional({ enum: ['match', 'watch-party'], default: 'match' })
  @IsOptional()
  @IsIn(['match', 'watch-party'])
  kind?: string;
}
