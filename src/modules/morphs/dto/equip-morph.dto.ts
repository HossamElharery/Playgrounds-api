import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';
import { MORPH_ID_MAX_LENGTH, MORPH_ID_PATTERN } from './morph-id.validation';

export class EquipMorphDto {
  @ApiProperty({ example: 'potato' })
  @IsString()
  @MaxLength(MORPH_ID_MAX_LENGTH)
  @Matches(MORPH_ID_PATTERN)
  morphId!: string;
}
