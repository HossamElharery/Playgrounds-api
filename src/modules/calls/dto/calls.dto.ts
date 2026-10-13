import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, Max, Min } from 'class-validator';
import { MAX_MUTE_MINUTES } from '../calls.constants';

export class CreateCallDto {
  @ApiProperty({ example: 'user-uuid' })
  @IsString()
  calleeId!: string;
}

export class MuteCallsDto {
  @ApiProperty({
    example: 60,
    description: 'Minutes to stop ringing for this person (1 – 480)',
  })
  @IsInt()
  @Min(1)
  @Max(MAX_MUTE_MINUTES)
  minutes!: number;
}

export class DoNotDisturbDto {
  @ApiProperty({
    example: 60,
    description: 'Minutes of do-not-disturb; 0 switches it off',
  })
  @IsInt()
  @Min(0)
  @Max(MAX_MUTE_MINUTES)
  minutes!: number;
}
