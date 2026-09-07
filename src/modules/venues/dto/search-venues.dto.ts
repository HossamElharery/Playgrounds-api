import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PageQueryDto } from '../../../common/dto/page-query.dto';

export class SearchVenuesDto extends PageQueryDto {
  @ApiPropertyOptional({ example: 'football-5', description: 'Sport slug or id' })
  @IsOptional()
  @IsString()
  sport?: string;

  @ApiPropertyOptional({ example: 'sport-football-5' })
  @IsOptional()
  @IsString()
  sportId?: string;

  @ApiPropertyOptional({ example: 'nasr-city' })
  @IsOptional()
  @IsString()
  district?: string;

  @ApiPropertyOptional({ example: 'dist-nasr-city' })
  @IsOptional()
  @IsString()
  districtId?: string;

  @ApiPropertyOptional({ example: 'SA', description: 'ISO 3166-1 alpha-2' })
  @IsOptional()
  @IsString()
  country?: string;

  @ApiPropertyOptional({ example: 'cairo' })
  @IsOptional()
  @IsString()
  governorate?: string;

  @ApiPropertyOptional({ example: 'gov-cairo' })
  @IsOptional()
  @IsString()
  governorateId?: string;

  @ApiPropertyOptional({ example: '31.20,29.95,31.45,30.12', description: 'west,south,east,north' })
  @IsOptional()
  @IsString()
  bbox?: string;

  @ApiPropertyOptional({ example: '30.06,31.34', description: 'lat,lng for near-me' })
  @IsOptional()
  @IsString()
  center?: string;

  @ApiPropertyOptional({ example: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  radiusKm?: number;

  @ApiPropertyOptional({ example: 5000, description: 'Radius in meters (alternative to radiusKm)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  radius?: number;

  @ApiPropertyOptional({ example: '2026-09-10', description: 'YYYY-MM-DD availability window' })
  @IsOptional()
  @IsString()
  date?: string;

  @ApiPropertyOptional({ example: '18:00' })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional({ example: '21:00' })
  @IsOptional()
  @IsString()
  to?: string;

  @ApiPropertyOptional({ example: 10000, description: 'Min price in piasters' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  priceMin?: number;

  @ApiPropertyOptional({ example: 40000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  priceMax?: number;

  @ApiPropertyOptional({ example: 4 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  ratingMin?: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  instantBook?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  hasOffers?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  featured?: boolean;

  @ApiPropertyOptional({ example: 'parking,floodlights' })
  @IsOptional()
  @IsString()
  amenities?: string;

  @ApiPropertyOptional({ example: 'artificial' })
  @IsOptional()
  @IsString()
  surface?: string;

  @ApiPropertyOptional({ example: 'padel' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ example: 'pins,cards,count' })
  @IsOptional()
  @IsString()
  include?: string;

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  pageSize?: number;

  @ApiPropertyOptional({
    example: 'distance',
    enum: ['price', 'rating', 'distance', 'newest', 'popularity', 'discount'],
  })
  @IsOptional()
  @IsIn(['price', 'rating', 'distance', 'newest', 'popularity', 'discount'])
  sort?: string;
}
