import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
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
}
