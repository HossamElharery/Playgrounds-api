import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';

export class LoginEmailDto {
  @ApiProperty({
    example: 'admin@mal3ab.app',
    description: 'Use admin@mal3ab.app or owner@mal3ab.app from seed data',
  })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'Password123!' })
  @IsString()
  @MinLength(8)
  password!: string;
}
