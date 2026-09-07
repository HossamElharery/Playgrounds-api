import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { UserStatus } from '@prisma/client';

export class UpdateUserStatusDto {
  @ApiProperty({ example: 'suspended', enum: ['active', 'suspended', 'banned'] })
  @IsIn(['active', 'suspended', 'banned'])
  status!: UserStatus;
}
