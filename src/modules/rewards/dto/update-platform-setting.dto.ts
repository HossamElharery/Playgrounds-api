import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional } from 'class-validator';

export class UpdatePlatformSettingDto {
  @ApiPropertyOptional({ example: 5, description: 'Platform fee percent' })
  @IsOptional()
  @IsNumber()
  serviceFeePct?: number;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @IsNumber()
  coinsPerHundredEgp?: number;

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @IsNumber()
  coinToEgpRate?: number;
}
