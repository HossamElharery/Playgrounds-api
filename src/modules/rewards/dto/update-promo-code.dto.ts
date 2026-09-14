import { PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreatePromoCodeDto } from './create-promo-code.dto';
export class UpdatePromoCodeDto extends PartialType(CreatePromoCodeDto) {
  @IsOptional() @IsBoolean() active?: boolean;
}
