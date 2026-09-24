import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { MORPH_ID_MAX_LENGTH, MORPH_ID_PATTERN } from './morph-id.validation';

export class MarkMorphsSeenDto {
  @ApiProperty({ type: [String], maxItems: 50 })
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(MORPH_ID_MAX_LENGTH, { each: true })
  @Matches(MORPH_ID_PATTERN, { each: true })
  morphIds!: string[];
}
