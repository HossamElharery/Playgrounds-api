import { IsOptional, IsPhoneNumber, IsString, Length } from 'class-validator';

export class VerifyOtpDto {
  @IsPhoneNumber()
  phone!: string;

  @IsString()
  @Length(4, 4)
  code!: string;

  /** Required only when the OTP verification is creating a brand-new account. */
  @IsOptional()
  @IsString()
  name?: string;
}
