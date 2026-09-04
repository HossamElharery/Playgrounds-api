import { IsIn } from 'class-validator';
import { UserStatus } from '@prisma/client';

export class UpdateUserStatusDto {
  @IsIn(['active', 'suspended', 'banned'])
  status!: UserStatus;
}
