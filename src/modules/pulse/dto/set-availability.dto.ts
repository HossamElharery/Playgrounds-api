import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsNumber, IsString, Min } from 'class-validator';

export class SetAvailabilityDto {
  @ApiProperty({ example: 'tonight', enum: ['now', 'tonight', 'weekend'] })
  @IsIn(['now', 'tonight', 'weekend'])
  window!: 'now' | 'tonight' | 'weekend';

  @ApiProperty({ example: 'sport-football-5' })
  @IsString()
  sportId!: string;

  @ApiProperty({ example: 'casual', enum: ['casual', 'competitive'] })
  @IsIn(['casual', 'competitive'])
  mode!: 'casual' | 'competitive';

  @ApiProperty({ example: 8 })
  @IsNumber()
  @Min(0.5)
  radiusKm!: number;

  @ApiProperty({ example: 25000, description: 'Max budget in piasters' })
  @IsInt()
  @Min(0)
  maxBudgetAmount!: number;
}
