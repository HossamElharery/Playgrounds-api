import { IsEmail, IsPhoneNumber, IsString, MinLength } from 'class-validator';

/** Venue-owner / staff-facing signup (email+password), separate from the phone-OTP player flow. */
export class RegisterOwnerDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsString()
  name!: string;

  @IsPhoneNumber()
  phone!: string;
}
