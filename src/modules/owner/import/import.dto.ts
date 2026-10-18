import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class ImportBodyDto {
  @ApiProperty({ description: 'JSON: { venueId, kind, headerRow?, mapping?, options?, skipRows? }' })
  @IsString()
  @MaxLength(30_000)
  config!: string;
}
