import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class CheckinBookingDto {
  @ApiProperty({
    example: 'mal3ab.booking.signed-payload',
    description: 'QR payload from the confirmed booking (booking.qrPayload)',
  })
  @IsString()
  qrPayload!: string;
}
