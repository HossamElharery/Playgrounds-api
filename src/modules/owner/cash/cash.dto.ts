import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

export const SHIFT_SCOPES = ['mine', 'user', 'shared'] as const;
export type ShiftScope = (typeof SHIFT_SCOPES)[number];

export class CashDrawerQueryDto {
  @ApiProperty()
  @IsUUID()
  venueId!: string;
}

export class CloseShiftDto {
  @ApiProperty()
  @IsUUID()
  venueId!: string;

  @ApiProperty({
    enum: SHIFT_SCOPES,
    description:
      'mine = my own drawer; user = close one colleague\'s drawer (needs shifts.review); shared = one drawer for everybody\'s cash (needs shifts.review).',
  })
  @IsIn(SHIFT_SCOPES as unknown as string[])
  scope!: ShiftScope;

  @ApiPropertyOptional({ description: 'Required when scope = user.' })
  @IsOptional()
  @IsUUID()
  targetUserId?: string;

  @ApiProperty({ description: 'Cash counted by hand, minor units.' })
  @Type(() => Number)
  @IsNumber({maxDecimalPlaces:3})
  @Min(0)
  @Max(1_000_000_000)
  countedCash!: number;

  @ApiPropertyOptional({ description: 'Cash that was in the drawer when the shift started. Defaults to what the last close left.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({maxDecimalPlaces:3})
  @Min(0)
  @Max(1_000_000_000)
  openingFloat?: number;

  @ApiPropertyOptional({ description: 'Cash left in the drawer for the next shift (the rest is handed to the owner). Defaults to 0.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({maxDecimalPlaces:3})
  @Min(0)
  @Max(1_000_000_000)
  carryOver?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class OpenShiftDto {
  @ApiProperty()
  @IsUUID()
  venueId!: string;

  @ApiProperty({ enum: SHIFT_SCOPES, description: 'Same meaning as when closing: whose drawer is being taken over.' })
  @IsIn(SHIFT_SCOPES as unknown as string[])
  scope!: ShiftScope;

  @ApiPropertyOptional({ description: 'Required when scope = user.' })
  @IsOptional()
  @IsUUID()
  targetUserId?: string;

  @ApiProperty({ description: 'Cash the incoming person counted in the drawer, minor units.' })
  @Type(() => Number)
  @IsNumber({maxDecimalPlaces:3})
  @Min(0)
  @Max(1_000_000_000)
  countedFloat!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class ShiftListQueryDto {
  @ApiProperty()
  @IsUUID()
  venueId!: string;

  @ApiPropertyOptional({ description: 'Venue-local date YYYY-MM-DD' })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  to?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({ description: 'Only shifts that did not balance' })
  @IsOptional()
  @IsString()
  unbalanced?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  cursor?: string;
}

export class ReviewShiftDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}
