import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class RequestUploadDto {
  @ApiProperty()
  @IsString()
  filename!: string;

  @ApiProperty()
  @IsString()
  mimeType!: string;

  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(80 * 1024 * 1024)
  byteSize!: number;

  @ApiProperty({ enum: ['image', 'video'] })
  @IsIn(['image', 'video'])
  type!: 'image' | 'video';

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  width?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  height?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  durationSeconds?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  altText?: string;
}
