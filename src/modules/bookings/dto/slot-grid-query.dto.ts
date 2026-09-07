import { ApiProperty } from '@nestjs/swagger';
import { IsDateString } from 'class-validator';

export class SlotGridQueryDto {
  @ApiProperty({ example: '2026-09-10', description: 'Local calendar date YYYY-MM-DD' })
  @IsDateString()
  date!: string;
}
