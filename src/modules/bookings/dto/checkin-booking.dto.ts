import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class CheckinBookingDto {
  @ApiProperty({
    example: 'matchena.booking.signed-payload',
    description: 'QR payload from the confirmed booking (booking.qrPayload)',
  })
  @IsString()
  qrPayload!: string;
}
