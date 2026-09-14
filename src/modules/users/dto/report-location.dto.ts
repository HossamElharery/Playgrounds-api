import { ApiProperty } from '@nestjs/swagger';
import { IsLatitude, IsLongitude } from 'class-validator';

export class ReportLocationDto {
  @ApiProperty({ example: 30.0626 })
  @IsLatitude()
  lat!: number;

  @ApiProperty({ example: 31.3428 })
  @IsLongitude()
  lng!: number;
}
