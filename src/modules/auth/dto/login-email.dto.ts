import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';

export class LoginEmailDto {
  @ApiProperty({
    example: 'admin@matchena.com',
    description: 'Use admin@matchena.com or owner@matchena.com from seed data',
  })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'Password123!' })
  @IsString()
  @MinLength(8)
  password!: string;
}
