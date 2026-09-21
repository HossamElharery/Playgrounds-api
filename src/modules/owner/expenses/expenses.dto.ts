import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

export const EXPENSE_CATEGORIES = [
  'electricity',
  'water',
  'rent',
  'salaries',
  'maintenance',
  'marketing',
  'supplies',
  'other',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class CreateExpenseDto {
  @ApiProperty()
  @IsUUID()
  venueId!: string;

  @ApiProperty({ enum: EXPENSE_CATEGORIES })
  @IsIn(EXPENSE_CATEGORIES as unknown as string[])
  category!: ExpenseCategory;

  @ApiPropertyOptional({ description: 'Required when category = other' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  categoryLabel?: string;

  @ApiProperty({ description: 'Minor units' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000_000)
  amount!: number;

  @ApiProperty({ description: 'Venue-local date YYYY-MM-DD' })
  @Matches(LOCAL_DATE)
  incurredOn!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  recurringMonthly?: boolean;

  @ApiPropertyOptional({ description: 'Last month (any day in it) the expense repeats in' })
  @IsOptional()
  @Matches(LOCAL_DATE)
  recurringUntil?: string;
}

export class UpdateExpenseDto {
  @ApiPropertyOptional({ enum: EXPENSE_CATEGORIES })
  @IsOptional()
  @IsIn(EXPENSE_CATEGORIES as unknown as string[])
  category?: ExpenseCategory;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  categoryLabel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000_000)
  amount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(LOCAL_DATE)
  incurredOn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;

  @ApiPropertyOptional({ description: 'Stop (false) or keep repeating a template' })
  @IsOptional()
  @IsBoolean()
  recurringMonthly?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(LOCAL_DATE)
  recurringUntil?: string;
}
