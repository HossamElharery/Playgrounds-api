import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsPhoneNumber,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class CreateWalkInDto {
  @ApiProperty({ example: 'venue-uuid' })
  @IsString()
  venueId!: string;

  @ApiProperty({ example: 'court-uuid' })
  @IsString()
  courtId!: string;

  @ApiProperty({ example: '2026-09-10T18:00:00.000Z' })
  @IsDateString()
  slotStart!: string;

  @ApiProperty({ example: '2026-09-10T19:00:00.000Z' })
  @IsDateString()
  slotEnd!: string;

  @ApiProperty({ example: 'Walk-in customer' })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  customerName!: string;

  @ApiPropertyOptional({ example: '+201001234567' })
  @IsOptional()
  @IsPhoneNumber()
  customerPhone?: string;

  @ApiPropertyOptional({ example: 25000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  priceAmount?: number;
}

export class CreateStaffInviteDto {
  @ApiProperty({ example: 'venue-uuid' })
  @IsString()
  venueId!: string;

  @ApiPropertyOptional({ example: '+201001234567' })
  @ValidateIf((o: CreateStaffInviteDto) => !o.inviteeEmail)
  @IsPhoneNumber()
  inviteePhone?: string;

  @ApiPropertyOptional({ example: 'reception@venue.com' })
  @ValidateIf((o: CreateStaffInviteDto) => !o.inviteePhone)
  @IsEmail()
  inviteeEmail?: string;

  @ApiPropertyOptional({ example: 'role-staff-uuid' })
  @IsOptional()
  @IsString()
  roleId?: string;

  @ApiPropertyOptional({ enum: ['reception', 'manager', 'accountant'] })
  @IsOptional()
  @IsIn(['reception', 'manager', 'accountant'])
  operationalRole?: 'reception' | 'manager' | 'accountant';
}

export class CreateCalendarBlockDto {
  @ApiProperty()
  @IsString()
  venueId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  courtId?: string;

  @ApiProperty({ enum: ['maintenance', 'private'] })
  @IsIn(['maintenance', 'private'])
  kind!: 'maintenance' | 'private';

  @ApiProperty()
  @IsDateString()
  startsAt!: string;

  @ApiProperty()
  @IsDateString()
  endsAt!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(240)
  note?: string;
}

export class CreatePayoutMethodDto {
  @ApiProperty({ enum: ['bank', 'instapay', 'wallet'] })
  @IsIn(['bank', 'instapay', 'wallet'])
  kind!: 'bank' | 'instapay' | 'wallet';

  @ApiProperty({ example: 'Ahmed El-Malek' })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  accountHolder!: string;

  @ApiProperty({
    example: '1234567890123456',
    description: 'Full identifier. Only a masked form is stored/returned.',
  })
  @IsString()
  @MinLength(4)
  @MaxLength(64)
  identifier!: string;

  @ApiPropertyOptional({ example: 'CIB' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  bankName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class VerifyVenueQrDto {
  @ApiProperty()
  @IsString()
  venueId!: string;

  @ApiPropertyOptional({ description: 'Signed QR payload from the player ticket' })
  @IsOptional()
  @IsString()
  qrPayload?: string;

  @ApiPropertyOptional({ description: 'Visible booking code fallback' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  code?: string;
}

export class OwnerBookingActionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(240)
  reason?: string;
}
