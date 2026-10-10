import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateIf } from 'class-validator';
export class GamingQueryDto { @IsUUID() venueId!: string; @IsOptional() @IsUUID() cursor?: string; @IsOptional() @IsDateString() at?: string; @IsOptional() @IsIn(['open']) state?: 'open'; }
export class GamingCommandDto {
  @IsUUID() venueId!: string;
  @IsUUID('4') requestKey!: string;
}
export class GamingVersionDto extends GamingCommandDto { @IsInt() @Min(1) expectedVersion!: number; }
export class StartSessionDto extends GamingCommandDto {
  @IsUUID() unitId!: string;
  @IsOptional() @IsIn(['standard','multi']) playMode?: 'standard'|'multi';
  @IsIn(['now','manual']) startMode!: 'now'|'manual';
  @IsOptional() @IsDateString() startsAt?: string;
  @IsOptional() @IsInt() @Min(1) @Max(720) durationMinutes?: number;
  @IsOptional() @IsUUID() bookingId?: string;
  @IsOptional() @IsUUID() orderId?: string;
  @IsOptional() @IsInt() @Min(1) orderVersion?: number;
  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @IsString() @MaxLength(120) guestName?: string;
  @IsOptional() @IsString() @MaxLength(32) guestPhone?: string;
}
export class ChangePlayModeDto extends GamingVersionDto { @IsIn(['standard','multi']) playMode!: 'standard'|'multi'; }
export class UnitTariffDto extends GamingCommandDto {
 @IsUUID() unitId!: string;
 @IsInt() @Min(1) @Max(10000000) hourlyRateMinor!: number;
 @IsOptional() @IsInt() @Min(1) @Max(10000000) multiHourlyRateMinor?: number;
}
export class TransferSessionDto extends GamingVersionDto { @IsUUID() targetUnitId!: string; }
export class ExtendSessionDto extends GamingVersionDto { @IsInt() @Min(1) @Max(720) additionalMinutes!: number; }
export class ReasonCommandDto extends GamingVersionDto { @IsString() @MaxLength(300) reason!: string; }
export class CreateOrderDto extends GamingCommandDto {
  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @IsString() @MaxLength(120) guestName?: string;
  @IsOptional() @IsString() @MaxLength(32) guestPhone?: string;
}
export class ProductDto extends GamingCommandDto {
  @IsString() @MaxLength(120) nameAr!: string;
  @IsString() @MaxLength(120) nameEn!: string;
  @IsString() @MaxLength(60) category!: string;
  @IsOptional() @IsString() @MaxLength(80) sku?: string;
  @IsInt() @Min(0) @Max(10000000) priceMinor!: number;
  @IsBoolean() stockTracked!: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsInt() @Min(1) expectedVersion?: number;
}
export class StockDto extends GamingVersionDto {
  @IsInt() @Min(-1000000) @Max(1000000) delta!: number;
  @IsString() @MaxLength(300) reason!: string;
}
export class ProductLineDto extends GamingVersionDto { @IsUUID() productId!: string; @IsInt() @Min(1) @Max(1000) quantity!: number; }
export class QuantityDto extends GamingVersionDto { @IsInt() @Min(0) @Max(1000) quantity!: number; }
export class ReturnLineDto extends GamingVersionDto {
  @IsInt() @Min(1) @Max(1000) quantity!: number;
  @IsBoolean() restock!: boolean;
  @IsString() @MaxLength(300) reason!: string;
}
export class CollectOrderDto extends GamingVersionDto {
  @IsInt() @Min(1) @Max(100000000) amountMinor!: number;
  @IsIn(['cash','instapay','card','vodafone','orange','etisalat','fawry','mada','stc_pay','benefit','knet']) method!: 'cash'|'instapay'|'card'|'vodafone'|'orange'|'etisalat'|'fawry'|'mada'|'stc_pay'|'benefit'|'knet';
  @IsOptional() @IsUUID() lineId?: string;
}
export class RefundOrderDto extends GamingVersionDto { @IsOptional() @IsInt() @Min(1) @Max(100000000) amountMinor?: number; @IsUUID() paymentId!: string; @IsString() @MaxLength(300) reason!: string; }
export class DiscountOrderDto extends GamingVersionDto { @IsInt() @Min(1) @Max(10000000) amountMinor!: number; @IsString() @MaxLength(300) reason!: string; }
export class ReceiptSettingsDto extends GamingCommandDto {
  @IsOptional() @IsBoolean() enabled?:boolean;
  @IsOptional() @IsUUID() logoPhotoId?:string|null;
  @IsInt() @Min(1) expectedVersion!: number;
  @IsIn([58,80]) widthMm!: number;
  @IsIn(['ar','en','bilingual']) language!: string;
  @IsString() @MaxLength(300) header!: string;
  @IsString() @MaxLength(300) footer!: string;
  @IsInt() @Min(1) @Max(3) copies!: number;
  @IsBoolean() autoPrint!: boolean;
}
export class BookingReceiptDto extends GamingCommandDto {@IsOptional() @IsUUID() paymentId?:string;}
export class PrintJobDto extends GamingCommandDto { @IsUUID() terminalId!: string; }
export class PrintStatusDto extends GamingCommandDto { @IsIn(['sent','failed','unknown']) status!: string; }
export class BillingSettingsDto extends GamingCommandDto {
  @IsIn(['exact-time','ceil-started-minute','step-minutes']) mode!: string;
  @IsInt() @Min(0) @Max(720) minimumMinutes!: number;
  @IsInt() @Min(1) @Max(720) stepMinutes!: number;
}

export class GamingCapabilitiesDto extends GamingCommandDto {
 @IsBoolean() sessionsEnabled!: boolean;
 @IsBoolean() productsEnabled!: boolean;
 @IsBoolean() receiptsEnabled!: boolean;
}
export class CreateGamingUnitsDto extends GamingCommandDto {
 @IsIn(['ps4','ps5','xbox-series','pc','vr','billiards','table-tennis']) assetKey!: string;
 @IsInt() @Min(1) @Max(100) count!: number;
 @IsString() @MaxLength(80) namePrefix!: string;
 @IsInt() @Min(0) @Max(10000000) hourlyRateMinor!: number;
}

export class CorrectSessionEndDto extends ReasonCommandDto { @IsDateString() endedAt!: string; }
export class DuplicateGamingUnitsDto extends GamingCommandDto {
 @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsUUID('all',{each:true}) sourceUnitIds!: string[];
}
export class GamingMaintenanceDto extends GamingCommandDto {
 @IsUUID() unitId!:string;
 @IsInt() @Min(1) @Max(720) durationMinutes!:number;
 @IsString() @MaxLength(300) reason!:string;
}
