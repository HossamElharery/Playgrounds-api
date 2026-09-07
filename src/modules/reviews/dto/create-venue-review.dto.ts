import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class CreateVenueReviewDto {
  @ApiProperty({ example: 'booking-uuid' })
  @IsString()
  bookingId!: string;

  @ApiProperty({ example: 5, minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  stars!: number;

  @ApiPropertyOptional({ example: ['clean', 'good-lighting'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ example: 'Pitch was great, showers worked.' })
  @IsOptional()
  @IsString()
  text?: string;

  @ApiPropertyOptional({ example: ['https://cdn.mal3ab.app/reviews/1.jpg'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  photos?: string[];
}
