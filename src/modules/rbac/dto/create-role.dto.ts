import { ArrayNotEmpty, IsArray, IsString } from 'class-validator';

export class CreateRoleDto {
  @IsString()
  name!: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  permissionKeys!: string[];
}
