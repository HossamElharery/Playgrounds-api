import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, Length, Matches, MaxLength } from 'class-validator';

export class CompleteGuestDto {
  @ApiProperty()
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty()
  @IsString()
  @Matches(/^\d{4,6}$/)
  code!: string;

  @ApiProperty()
  @IsString()
  @Length(8, 128)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d)[\s\S]+$/)
  password!: string;

  @ApiProperty()
  @IsString()
  @Length(2, 80)
  @Matches(/^[\p{L}\p{M}\p{N} .'\-]+$/u)
  name!: string;
}
