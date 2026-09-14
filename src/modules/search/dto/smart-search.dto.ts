import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNumber, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class SmartSearchDto {
  @ApiProperty({ description: 'Free-text sentence, e.g. "عايز ملعب بادل الليلة في المعادي".' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  text!: string;

  @ApiProperty({ description: 'Client-generated id (sessionStorage) — scopes the short-lived follow-up memory.' })
  @IsString()
  @MinLength(8)
  @MaxLength(100)
  sessionId!: string;

  @ApiPropertyOptional({ enum: ['ar', 'en'] })
  @IsOptional()
  @IsIn(['ar', 'en'])
  lang?: 'ar' | 'en';

  @ApiPropertyOptional({ description: 'Only sent when the browser already granted geolocation — used for "قريب مني".' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  lat?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  lng?: number;
}
