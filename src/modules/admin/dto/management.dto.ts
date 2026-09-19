import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsPhoneNumber,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { UserRole, UserStatus, VenueStatus } from '@prisma/client';
import { PageQueryDto } from '../../../common/dto/page-query.dto';
import { UpdateVenueDto } from '../../venues/dto/update-venue.dto';
import { normalizeOptionalPhone } from '../../../common/utils/phone.util';

export class ManagementQuery extends PageQueryDto {
  @IsOptional() @IsString() @MaxLength(150) search?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsIn(['player', 'owner', 'staff', 'admin']) role?: UserRole;
  @IsOptional() @IsString() userId?: string;
  @IsOptional() @IsString() venueId?: string;
}
export class ReasonDto {
  @IsString() @MinLength(5) @MaxLength(500) reason!: string;
}
export class AdminUserDto extends ReasonDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(100) name?: string;
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined ? undefined : normalizeOptionalPhone(value),
  )
  @ValidateIf((_, v) => typeof v === 'string' && v.length > 0)
  @IsPhoneNumber()
  phone?: string | null;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(50) username?: string;
  @IsOptional() @IsIn(['active', 'suspended', 'banned']) status?: UserStatus;
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsIn(['player', 'owner', 'staff', 'admin'], { each: true })
  roles?: UserRole[];
  @IsOptional() @IsIn(['ar', 'en']) preferredLang?: string;
  @IsOptional() @Matches(/^[A-Z]{2}$/) countryCode?: string;
  @IsOptional() @IsString() @MaxLength(500) bioAr?: string;
  @IsOptional() @IsString() @MaxLength(500) bioEn?: string;
  @IsOptional() @IsString() @MaxLength(2048) avatarUrl?: string;
  @IsOptional() @IsString() governorateId?: string;
  @IsOptional() @IsString() districtId?: string;
}
export class CoinAdjustmentDto extends ReasonDto {
  @IsInt() @Min(-1000000) @Max(1000000) amount!: number;
}
export class AdminVenueDto extends UpdateVenueDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  @IsOptional() @IsIn(['pending', 'active', 'suspended']) status?: VenueStatus;
  @IsOptional() @IsBoolean() featured?: boolean;
  @IsOptional() @IsString() ownerId?: string;
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined ? undefined : normalizeOptionalPhone(value),
  )
  @ValidateIf((_, v) => typeof v === 'string' && v.length > 0)
  @IsPhoneNumber()
  contactPhone?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) houseRules?: string;
}
export class AdminReviewDto extends ReasonDto {
  @IsOptional() @IsInt() @Min(1) @Max(5) stars?: number;
  @IsOptional() @IsString() @MaxLength(5000) text?: string;
  @IsOptional() @IsString() @MaxLength(5000) ownerReply?: string;
}
