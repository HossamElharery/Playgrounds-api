import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

/** The file travels as multipart; everything else is one JSON string (validated by `sanitizeConfig`). */
export class ImportBodyDto {
  @ApiProperty({ description: 'JSON: { venueId, kind, headerRow?, mapping?, options?, skipRows? }' })
  @IsString()
  @MaxLength(30_000)
  config!: string;
}
