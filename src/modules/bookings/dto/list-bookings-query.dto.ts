import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class ListMyBookingsQueryDto {
  @ApiPropertyOptional({
    enum: ['upcoming', 'past', 'all'],
    example: 'upcoming',
    description: 'Omit for all bookings',
  })
  @IsOptional()
  @IsIn(['upcoming', 'past', 'all'])
  scope?: 'upcoming' | 'past' | 'all';
}

export class ListVenueBookingsQueryDto {
  @ApiPropertyOptional({
    enum: ['held', 'confirmed', 'cancelled', 'completed', 'no_show'],
    example: 'confirmed',
  })
  @IsOptional()
  @IsIn(['held', 'confirmed', 'cancelled', 'completed', 'no_show'])
  status?: 'held' | 'confirmed' | 'cancelled' | 'completed' | 'no_show';

  @ApiPropertyOptional({ example: 'Ahmed' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  q?: string;
}
