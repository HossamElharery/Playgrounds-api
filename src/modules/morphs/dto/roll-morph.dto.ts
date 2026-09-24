import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class RollMorphDto {
  @ApiProperty({
    description:
      'Client-generated idempotency key (UUID v4); a retry with the same key returns the same result',
  })
  @IsUUID('4')
  clientRollId!: string;
}
