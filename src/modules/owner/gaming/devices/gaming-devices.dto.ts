import { BadRequestException } from '@nestjs/common';
import { plainToInstance, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  validateSync,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { GamingCommandDto } from '../gaming-operations.dto';
import { MAX_GRACE_MINUTES } from './device-policy';

export class DeviceSettingsDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsBoolean() autoOn?: boolean;
  @IsOptional() @IsBoolean() autoOff?: boolean;
  @IsOptional() @IsBoolean() cutAtEnd?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(MAX_GRACE_MINUTES) graceMinutes?: number;
  @IsOptional() @IsBoolean() guard?: boolean;
  @IsOptional() @IsBoolean() invert?: boolean;
}
export class UpdateGamingDeviceDto extends GamingCommandDto {
  /** null unassigns the plug. */
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsUUID() unitId?:
    | string
    | null;
  @IsOptional() @IsString() @MaxLength(60) name?: string;
  @IsOptional() @IsInt() @Min(0) @Max(3) channel?: number;
  @IsOptional()
  @ValidateNested()
  @Type(() => DeviceSettingsDto)
  settings?: DeviceSettingsDto;
}
export class DeviceTestDto extends GamingCommandDto {
  @IsInt() @Min(3) @Max(300) seconds!: number;
}
export class DeviceOverrideDto extends GamingCommandDto {
  @IsBoolean() on!: boolean;
  /** 0 clears the override. */
  @IsInt() @Min(0) @Max(720) minutes!: number;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

export class RenameHubDto extends GamingCommandDto {
  @IsString() @MaxLength(60) name!: string;
}
export class PsnSigninDto extends GamingCommandDto {
  /** Language of the owner page; the Sony sign-in window follows it. */
  @IsOptional() @IsIn(['ar', 'en']) lang?: 'ar' | 'en';
}
export class PsnLinkDto extends GamingCommandDto {
  /** The address Sony redirects to after sign-in (carries a one-time code). */
  @IsString() @MaxLength(2000) redirectUrl!: string;
}
export class PairConsoleDto extends GamingCommandDto {
  /** The 8-digit code the console shows under Remote Play > Link Device. */
  @IsString() @Matches(/^\d{8}$/) pin!: string;
}
export class ClaimHubDto {
  @IsString() @MaxLength(40) code!: string;
  @IsOptional() @IsString() @MaxLength(80) hostname?: string;
  @IsOptional() @IsString() @MaxLength(24) platform?: string;
  @IsOptional() @IsString() @MaxLength(24) hubVersion?: string;
}

/**
 * DELETE has no standard body, and clients differ: the owner web sends venueId/requestKey as a JSON body,
 * curl and older callers as a query string. Accept either and validate the result as a normal command.
 */
export function commandFrom(query: unknown, body: unknown): GamingCommandDto {
  const raw = {
    ...(body && typeof body === 'object' ? body : {}),
    ...(query && typeof query === 'object' ? query : {}),
  };
  const dto = plainToInstance(GamingCommandDto, {
    venueId: (raw as Record<string, unknown>).venueId,
    requestKey: (raw as Record<string, unknown>).requestKey,
  });
  if (validateSync(dto).length)
    throw new BadRequestException({ code: 'INVALID_REQUEST' });
  return dto;
}
