import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PARTNER_EVENTS, type PartnerEvent } from './partner-links.util';

const UTM = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export class PartnerVisitDto {
  @ApiProperty({ example: 'nasr-city-arena' })
  @IsString()
  @Matches(/^[a-z0-9-]{1,120}$/)
  venueSlug!: string;

  @ApiProperty({ enum: PARTNER_EVENTS })
  @IsIn(PARTNER_EVENTS)
  event!: PartnerEvent;

  @ApiProperty({ example: 'partner' })
  @IsString()
  @Matches(UTM)
  source!: string;

  @ApiPropertyOptional({ example: 'badge' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(UTM)
  medium?: string;

  @ApiPropertyOptional({ example: 'nasr-city-arena' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(UTM)
  campaign?: string;
}
