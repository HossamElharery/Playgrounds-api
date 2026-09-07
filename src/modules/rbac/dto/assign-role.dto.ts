import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class AssignRoleDto {
  @ApiProperty({ example: 'user-uuid' })
  @IsString()
  userId!: string;

  @ApiProperty({ example: 'role-uuid' })
  @IsString()
  roleId!: string;

  @ApiPropertyOptional({ example: 'venue-uuid' })
  @IsOptional()
  @IsString()
  venueId?: string;
}
