import { IsBoolean, IsOptional } from 'class-validator';

/** Body of the three owner switches: listing, booking-availability, operations. */
export class VenueSwitchDto {
  @IsBoolean()
  enabled!: boolean;

  /** Required when hiding / pausing a venue that still has upcoming bookings. */
  @IsOptional()
  @IsBoolean()
  acknowledgeFutureBookings?: boolean;
}

import { IsString, MaxLength, MinLength } from 'class-validator';

/** Every sensitive admin decision states why. */
export class AdminReasonDto {
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}
