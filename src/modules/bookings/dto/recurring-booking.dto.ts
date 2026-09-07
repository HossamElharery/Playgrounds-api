import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, Max, Min } from 'class-validator';

export class CreateRecurringSeriesDto {
  @ApiProperty({ example: '6ca20f0c-d7a9-4f97-989d-c2f5ac0f8a8f' })
  @IsString()
  courtId!: string;

  @ApiProperty({ example: 5, description: '0=Sunday … 6=Saturday. Egypt weekend is Fri/Sat (5,6)' })
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  @ApiProperty({ example: '18:00' })
  @IsString()
  startTime!: string;

  @ApiProperty({ example: 60 })
  @IsInt()
  @Min(30)
  durationMins!: number;
}
