import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class AssistantTurnDto {
  @ApiProperty({ enum: ['owner', 'assistant'] })
  @IsIn(['owner', 'assistant'])
  from!: 'owner' | 'assistant';

  @ApiProperty({ maxLength: 600 })
  @IsString()
  @MaxLength(600)
  text!: string;
}

export class AssistantAskDto {
  @ApiProperty()
  @IsUUID()
  venueId!: string;

  @ApiProperty({ minLength: 2, maxLength: 400 })
  @IsString()
  @Length(2, 400)
  text!: string;

  /** The last few turns, oldest first, so a short answer is read in context. */
  @ApiPropertyOptional({ type: () => [AssistantTurnDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => AssistantTurnDto)
  history?: AssistantTurnDto[];

  /** The `draft` of the previous plan, if it was a question. Re-validated server-side. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  draft?: Record<string, unknown>;
}

/**
 * One confirmed action. Deliberately flat and fully validated: the execute
 * endpoint re-runs every business rule through the owner services, but a
 * malformed body should never get that far.
 */
export class AssistantActionDto {
  @ApiProperty({
    enum: [
      'create_booking',
      'record_payment',
      'cancel_booking',
      'add_expense',
      'update_booking',
    ],
  })
  @IsIn([
    'create_booking',
    'record_payment',
    'cancel_booking',
    'add_expense',
    'update_booking',
  ])
  kind!:
    | 'create_booking'
    | 'record_payment'
    | 'cancel_booking'
    | 'add_expense'
    | 'update_booking';

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  courtId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(15)
  @Max(720)
  durationMinutes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  priceAmount?: number;

  @ApiPropertyOptional({ enum: ['paid', 'unpaid', 'partial'] })
  @IsOptional()
  @IsIn(['paid', 'unpaid', 'partial'])
  paymentStatus?: 'paid' | 'unpaid' | 'partial';

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  paidAmount?: number;

  @ApiPropertyOptional({
    enum: ['cash', 'instapay', 'wallet', 'card', 'other'],
  })
  @IsOptional()
  @IsIn(['cash', 'instapay', 'wallet', 'card', 'other'])
  paymentMethod?: 'cash' | 'instapay' | 'wallet' | 'card' | 'other';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  customerName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  customerPhone?: string;

  @ApiPropertyOptional({
    enum: ['walk_in', 'phone', 'whatsapp', 'other_platform'],
  })
  @IsOptional()
  @IsIn(['walk_in', 'phone', 'whatsapp', 'other_platform'])
  sourceKey?: 'walk_in' | 'phone' | 'whatsapp' | 'other_platform';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  overrideBlocks?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  bookingId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  amount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  method?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(30)
  category?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  incurredOn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class AssistantExecuteDto {
  @ApiProperty()
  @IsUUID()
  venueId!: string;

  @ApiProperty({ type: [AssistantActionDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => AssistantActionDto)
  actions!: AssistantActionDto[];
}

export class UndoAssistantActionsDto {
  @ApiProperty()
  @IsUUID()
  venueId!: string;

  @ApiProperty({ description: 'The `undoId` returned by assistant/execute.' })
  @IsUUID()
  undoId!: string;
}
