import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn } from 'class-validator';

export class SetPromoActiveDto {
  @ApiProperty({ example: false })
  @IsBoolean()
  active!: boolean;
}

export class SetStaffStatusDto {
  @ApiProperty({ enum: ['accepted', 'suspended', 'revoked'] })
  @IsIn(['accepted', 'suspended', 'revoked'])
  status!: 'accepted' | 'suspended' | 'revoked';
}
