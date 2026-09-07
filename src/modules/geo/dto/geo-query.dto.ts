import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class GeoGovernoratesQueryDto {
  @ApiPropertyOptional({
    example: 'EG',
    description: 'ISO 3166-1 alpha-2. Required by the service (400 if missing).',
  })
  @IsOptional()
  @IsString()
  country?: string;
}

export class GeoDistrictsQueryDto {
  @ApiPropertyOptional({ example: 'gov-cairo' })
  @IsOptional()
  @IsString()
  governorateId?: string;

  @ApiPropertyOptional({
    example: 'cairo',
    description: 'Governorate slug (alternative to governorateId)',
  })
  @IsOptional()
  @IsString()
  gov?: string;

  @ApiPropertyOptional({ example: 'EG' })
  @IsOptional()
  @IsString()
  country?: string;
}
