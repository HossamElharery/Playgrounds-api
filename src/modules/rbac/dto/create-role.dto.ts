import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsString } from 'class-validator';

export class CreateRoleDto {
  @ApiProperty({ example: 'front-desk' })
  @IsString()
  name!: string;

  @ApiProperty({ example: ['bookings.checkin', 'venues.read'] })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  permissionKeys!: string[];
}
