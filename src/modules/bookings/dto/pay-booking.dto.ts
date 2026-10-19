import { IsIn, IsOptional } from 'class-validator';

export class PayBookingDto {
  /** The app language, so the provider sends the player back to the right page. */
  @IsOptional()
  @IsIn(['ar', 'en'])
  lang?: 'ar' | 'en';
}
