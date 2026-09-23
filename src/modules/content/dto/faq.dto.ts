import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

export const FAQ_CATEGORIES = [
  'booking',
  'payments',
  'account',
  'play',
  'owners',
  'policies',
] as const;

export type FaqCategory = (typeof FAQ_CATEGORIES)[number];

export class UpsertFaqDto {
  @ApiProperty({ example: 'How do I cancel a booking?' })
  @IsString()
  questionEn!: string;

  @ApiProperty({ example: 'إزاي ألغي حجز؟' })
  @IsString()
  questionAr!: string;

  @ApiProperty({ example: 'Open My Bookings and tap Cancel before the cutoff.' })
  @IsString()
  answerEn!: string;

  @ApiProperty({ example: 'من حجوزاتي اضغط إلغاء قبل ميعاد الإلغاء.' })
  @IsString()
  answerAr!: string;

  @ApiPropertyOptional({
    enum: FAQ_CATEGORIES,
    example: 'booking',
    description: 'Help Center group: booking | payments | account | play | owners | policies',
  })
  @IsOptional()
  @IsIn([...FAQ_CATEGORIES])
  category?: FaqCategory;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsInt()
  position?: number;

  @ApiPropertyOptional({
    example: 'register',
    description: 'Destination without the locale prefix. register, app/wallet, owner/today, or mailto:/https:.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(180)
  ctaPath?: string;

  @ApiPropertyOptional({ example: 'Create an account' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  ctaLabelEn?: string;

  @ApiPropertyOptional({ example: 'اعمل حساب' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  ctaLabelAr?: string;
}
