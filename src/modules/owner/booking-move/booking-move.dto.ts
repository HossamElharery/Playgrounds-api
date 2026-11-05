import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsUUID, Matches } from 'class-validator';

/** An instant that names its own offset. A bare local time would be read on the server's clock. */
const INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export class MoveBookingPreviewDto {
  @ApiPropertyOptional({
    description: 'Unit to check. Omit to only list suggestions.',
  })
  @IsOptional()
  @IsUUID()
  courtId?: string;

  @ApiPropertyOptional({
    description: 'Start to check (ISO instant with offset).',
  })
  @IsOptional()
  @Matches(INSTANT)
  startsAt?: string;

  @ApiPropertyOptional({
    description:
      'Venue-local day (YYYY-MM-DD) to list suggestions for. Defaults to the booking day.',
  })
  @IsOptional()
  @Matches(YMD)
  date?: string;
}

export class MoveBookingDto {
  @ApiProperty({
    description:
      'Client-generated UUID. Repeating it returns the first result instead of moving twice.',
  })
  @IsUUID()
  requestKey!: string;

  @ApiProperty({
    description:
      'The unit the owner was looking at. A stale screen is refused.',
  })
  @IsUUID()
  fromCourtId!: string;

  @ApiProperty({
    description:
      'The start the owner was looking at. A stale screen is refused.',
  })
  @Matches(INSTANT)
  fromStartsAt!: string;

  @ApiProperty()
  @IsUUID()
  courtId!: string;

  @ApiProperty()
  @Matches(INSTANT)
  startsAt!: string;

  @ApiPropertyOptional({ enum: ['keep', 'reprice'], default: 'keep' })
  @IsOptional()
  @IsIn(['keep', 'reprice'])
  priceMode?: 'keep' | 'reprice';

  @ApiPropertyOptional({
    description:
      'Matchena bookings only: keep the price the player paid even though the new time costs more.',
  })
  @IsOptional()
  @IsBoolean()
  honorOriginalPrice?: boolean;
}
