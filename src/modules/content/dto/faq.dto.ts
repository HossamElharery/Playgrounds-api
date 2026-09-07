import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString } from 'class-validator';

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

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsInt()
  position?: number;
}
