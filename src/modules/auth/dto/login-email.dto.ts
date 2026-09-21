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
  // Sign-in only checks the password; strength rules apply where passwords are CHOSEN.
  // A manager may give staff a short one, and it must still be able to sign in.
  @MinLength(1)
  password!: string;
}
