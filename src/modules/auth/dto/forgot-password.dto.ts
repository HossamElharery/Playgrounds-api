import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsPhoneNumber,
  ValidateIf,
} from 'class-validator';

export class ForgotPasswordDto {
  @ApiProperty({ example: '+201000000002', required: false })
  @ValidateIf((dto: ForgotPasswordDto) => !dto.email || dto.phone !== undefined)
  @IsPhoneNumber()
  @IsOptional()
  phone?: string;

  @ApiProperty({ example: 'owner@matchena.com', required: false })
  @ValidateIf((dto: ForgotPasswordDto) => !dto.phone || dto.email !== undefined)
  @IsEmail()
  @IsOptional()
  email?: string;
}
