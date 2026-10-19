import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class RespondRequestDto {
  @ApiProperty({ enum: ['accept', 'decline'] })
  @IsIn(['accept', 'decline'])
  action!: 'accept' | 'decline';
}
