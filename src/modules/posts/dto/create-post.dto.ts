import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class CreatePostDto {
  @ApiPropertyOptional({
    default: false,
    description: 'Hide the author from public post responses',
  })
  @IsOptional()
  // Global implicit conversion would turn the JSON string "false" into true.
  @Transform(({ obj, key }) => obj[key], { toClassOnly: true })
  @IsBoolean()
  isAnonymous?: boolean;

  @ApiPropertyOptional({ example: 'Night game at El Nozha #padel' })
  @IsOptional()
  @IsString()
  @MaxLength(2200)
  text?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID('4', { each: true })
  mediaAssetIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  taggedVenueId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  linkedMatchId?: string;

  @ApiPropertyOptional({ enum: ['user', 'official', 'venue'] })
  @IsOptional()
  @IsIn(['user', 'official', 'venue'])
  authorKind?: 'user' | 'official' | 'venue';
}
