import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class CustomerNoteDto {
  @ApiProperty()
  @IsUUID()
  venueId!: string;

  @ApiProperty({ description: 'p:<userId> | m:<phone> | n:<name>' })
  @IsString()
  @MaxLength(90)
  key!: string;

  @ApiPropertyOptional({ description: 'Empty clears the note.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
