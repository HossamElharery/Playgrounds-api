import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class CreatePlayerRatingDto {
  @ApiPropertyOptional({ example: 'booking-uuid' })
  @IsOptional()
  @IsString()
  bookingId?: string;

  @ApiPropertyOptional({ example: 'match-post-uuid' })
  @IsOptional()
  @IsString()
  matchPostId?: string;

  @ApiProperty({ example: 'ratee-user-uuid' })
  @IsString()
  rateeId!: string;

  @ApiProperty({ example: 5, minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  sportsmanship!: number;

  @ApiProperty({ example: 4, minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  skill!: number;

  @ApiProperty({ example: 5, minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  punctuality!: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  mvpVote?: boolean;
}
