import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

export class ResolveReportDto {
  @ApiProperty({ example: 'resolved', enum: ['resolved', 'dismissed'] })
  @IsIn(['resolved', 'dismissed'])
  status!: 'resolved' | 'dismissed';

  @ApiPropertyOptional({ example: 'Warned the user' })
  @IsOptional()
  @IsString()
  resolutionNote?: string;
}
