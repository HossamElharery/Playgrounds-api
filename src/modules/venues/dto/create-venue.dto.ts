import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
} from 'class-validator';

export class CreateVenueDto {
  @ApiProperty({ example: 'El Dawlia Pitch' })
  @IsString()
  nameEn!: string;

  @ApiProperty({ example: 'ملعب الدولية' })
  @IsString()
  nameAr!: string;

  @ApiPropertyOptional({ example: '5-a-side floodlit pitch in Nasr City' })
  @IsOptional()
  @IsString()
  descriptionEn?: string;

  @ApiPropertyOptional({ example: 'ملعب خماسي بإضاءة في مدينة نصر' })
  @IsOptional()
  @IsString()
  descriptionAr?: string;

  @ApiPropertyOptional({ example: 'SA', description: 'ISO 3166-1 alpha-2. Derived from governorate when omitted.' })
  @IsOptional()
  @IsString()
  countryCode?: string;

  @ApiPropertyOptional({ example: 'dist-nasr-city' })
  @IsOptional()
  @IsString()
  districtId?: string;

  @ApiPropertyOptional({ example: 'gov-cairo' })
  @IsOptional()
  @IsString()
  governorateId?: string;

  @ApiPropertyOptional({ example: 'Abbas El Akkad, Nasr City' })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiProperty({ example: 30.0626 })
  @IsLatitude()
  lat!: number;

  @ApiProperty({ example: 31.3428 })
  @IsLongitude()
  lng!: number;

  @ApiPropertyOptional({ example: 'artificial' })
  @IsOptional()
  @IsString()
  surface?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  instantBook?: boolean;

  @ApiPropertyOptional({ example: 'Free cancel until 6 hours before kickoff' })
  @IsOptional()
  @IsString()
  cancellationPolicy?: string;

  @ApiPropertyOptional({ example: ['sport-football-5'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sportIds?: string[];

  @ApiPropertyOptional({ example: ['parking', 'floodlights'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  amenityKeys?: string[];
}
