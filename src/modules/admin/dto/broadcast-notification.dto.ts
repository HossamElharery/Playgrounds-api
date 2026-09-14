import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class BroadcastNotificationDto {
  @ApiProperty({ enum: ['owners', 'players', 'individual'] })
  @IsIn(['owners', 'players', 'individual'])
  audience!: 'owners' | 'players' | 'individual';

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  recipientIds?: string[];

  @ApiPropertyOptional({ description: 'Limit recipients to this governorate' })
  @IsOptional()
  @IsString()
  governorateId?: string;

  @ApiPropertyOptional({ description: 'Limit recipients to this district / area' })
  @IsOptional()
  @IsString()
  districtId?: string;

  @ApiProperty()
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  titleEn!: string;

  @ApiProperty()
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  titleAr!: string;

  @ApiProperty()
  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  bodyEn!: string;

  @ApiProperty()
  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  bodyAr!: string;

  @ApiPropertyOptional({ example: 'Book this pitch' })
  @ValidateIf((dto: BroadcastNotificationDto) => Boolean(dto.ctaUrl || dto.ctaLabelAr || dto.ctaLabelEn))
  @IsString()
  @MinLength(2)
  @MaxLength(40)
  ctaLabelEn?: string;

  @ApiPropertyOptional({ example: 'احجز الملعب' })
  @ValidateIf((dto: BroadcastNotificationDto) => Boolean(dto.ctaUrl || dto.ctaLabelAr || dto.ctaLabelEn))
  @IsString()
  @MinLength(2)
  @MaxLength(40)
  ctaLabelAr?: string;

  @ApiPropertyOptional({ example: '/en/venues/neon-arena' })
  @ValidateIf((dto: BroadcastNotificationDto) => Boolean(dto.ctaUrl || dto.ctaLabelAr || dto.ctaLabelEn))
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  ctaUrl?: string;
}
