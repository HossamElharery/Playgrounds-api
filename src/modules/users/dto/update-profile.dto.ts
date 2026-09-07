import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Omar Hassan' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ example: 'ar', enum: ['ar', 'en'] })
  @IsOptional()
  @IsIn(['ar', 'en'])
  preferredLang?: string;

  @ApiPropertyOptional({ example: 'Football lover since childhood' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  bioEn?: string;

  @ApiPropertyOptional({ example: 'بحب الكورة من وأنا صغير' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  bioAr?: string;

  @ApiPropertyOptional({ example: 'SA' })
  @IsOptional()
  @IsString()
  countryCode?: string;
}
