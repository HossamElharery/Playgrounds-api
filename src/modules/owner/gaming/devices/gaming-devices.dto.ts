import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
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
  @IsInt() @Min(3) @Max(60) seconds!: number;
}
export class DeviceOverrideDto extends GamingCommandDto {
  @IsBoolean() on!: boolean;
  /** 0 clears the override. */
  @IsInt() @Min(0) @Max(720) minutes!: number;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}
