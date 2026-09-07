import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';

const GENRES = ['sports', 'shooter', 'racing', 'fighting', 'other'];
const AGE_RATINGS = ['everyone', 'teen', 'mature'];

export class CreateGameCatalogEntryDto {
  @ApiPropertyOptional({ example: 'ea-fc' })
  @IsString()
  @MaxLength(80)
  slug!: string;

  @IsString()
  @MaxLength(120)
  nameEn!: string;

  @IsString()
  @MaxLength(120)
  nameAr!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl()
  iconUrl?: string;

  @ApiPropertyOptional({ enum: GENRES })
  @IsIn(GENRES)
  genre!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  supportsCompetitiveTier?: boolean;

  @ApiPropertyOptional({ enum: AGE_RATINGS })
  @IsOptional()
  @IsIn(AGE_RATINGS)
  ageRating?: string;
}

export class UpdateGameCatalogEntryDto extends PartialType(
  CreateGameCatalogEntryDto,
) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
