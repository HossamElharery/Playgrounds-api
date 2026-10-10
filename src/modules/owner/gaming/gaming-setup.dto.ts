import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { GamingCommandDto } from './gaming-operations.dto';
export const SETUP_KINDS = ['ps5','ps4','xbox-series','pc','vr','billiards','table-tennis'] as const;
export type SetupKind = typeof SETUP_KINDS[number];
export class SetupGroupDto {
 @IsIn(SETUP_KINDS) assetKey!: SetupKind;
 @IsInt() @Min(1) @Max(100) count!: number;
 @IsInt() @Min(1) @Max(10000000) hourlyRateMinor!: number;
 @IsOptional() @IsInt() @Min(1) @Max(10000000) multiHourlyRateMinor?: number;
 @IsOptional() @IsInt() @Min(1) @Max(10000000) privateHourlyRateMinor?: number;
 @IsOptional() @IsInt() @Min(1) @Max(10000000) privateMultiHourlyRateMinor?: number;
 /** Zero based floor for the remaining open-hall stations. */
 @IsInt() @Min(0) @Max(19) floorIndex!: number;
 @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @IsInt({each:true}) @Min(0,{each:true}) @Max(100,{each:true}) floorCounts?:number[];
}
export class SetupRoomMemberDto {
 @IsIn(SETUP_KINDS) assetKey!: SetupKind;
 @IsInt() @Min(1) @Max(12) count!: number;
}
export class SetupRoomDto {
 @IsString() @MaxLength(80) name!: string;
 @IsInt() @Min(0) @Max(19) floorIndex!: number;
 @IsIn(['independent','exclusive']) occupancy!: 'independent'|'exclusive';
 @IsArray() @ArrayMinSize(1) @ArrayMaxSize(7) @ValidateNested({each:true}) @Type(()=>SetupRoomMemberDto) members!: SetupRoomMemberDto[];
 @IsOptional() @IsInt() @Min(1) @Max(10000000) hourlyRateMinor?: number;
 @IsOptional() @IsInt() @Min(1) @Max(10000000) multiHourlyRateMinor?: number;
}
export class GamingSetupDto extends GamingCommandDto {
 @IsArray() @ArrayMinSize(1) @ArrayMaxSize(7) @ValidateNested({each:true}) @Type(()=>SetupGroupDto) groups!: SetupGroupDto[];
 @IsArray() @ArrayMaxSize(20) @ValidateNested({each:true}) @Type(()=>SetupRoomDto) rooms!: SetupRoomDto[];
 @IsInt() @Min(1) @Max(20) floorCount!: number;
 @IsIn(['rows','walls']) arrangement!: 'rows'|'walls';
 @IsIn(['neon','cafe','industrial','majlis']) ambience!: 'neon'|'cafe'|'industrial'|'majlis';
 @IsIn(['ar','en']) language!: 'ar'|'en';
 @IsInt() @Min(0) expectedRevision!: number;
 @IsBoolean() reuseExisting!: boolean;
}
