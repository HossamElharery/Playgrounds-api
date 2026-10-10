import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { CreateVenueDto } from './create-venue.dto';

export class UpdateVenueDto extends PartialType(CreateVenueDto) {
  @ApiPropertyOptional({ description: 'Venue name in the owner\'s own language; the other language is filled in automatically.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ description: 'Description in the owner\'s own language; the other language is filled in automatically.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}
