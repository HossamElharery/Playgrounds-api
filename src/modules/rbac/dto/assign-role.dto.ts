import { IsOptional, IsString } from 'class-validator';

export class AssignRoleDto {
  @IsString()
  userId!: string;

  @IsString()
  roleId!: string;

  @IsOptional()
  @IsString()
  venueId?: string;
}
