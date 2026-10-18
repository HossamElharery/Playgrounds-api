import { IsOptional, IsPhoneNumber, ValidateIf } from 'class-validator';
import { Transform } from 'class-transformer';
import { UpdateVenueDto } from './update-venue.dto';
import { normalizeOptionalPhone } from '../../../common/utils/phone.util';

export class OwnerVenueDto extends UpdateVenueDto {
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : normalizeOptionalPhone(value)))
  @ValidateIf((_, v) => typeof v === 'string' && v.length > 0)
  @IsPhoneNumber()
  contactPhone?: string | null;
}
