import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class SetMutedDto {
  @ApiProperty()
  @IsBoolean()
  muted!: boolean;
}
