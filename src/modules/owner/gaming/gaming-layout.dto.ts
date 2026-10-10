import { IsInt, IsObject, IsUUID, Min } from 'class-validator';
export class GamingVenueQueryDto { @IsUUID() venueId!: string; }
export class SaveGamingLayoutDto extends GamingVenueQueryDto {
  @IsInt() @Min(0) baseRevision!: number;
  @IsInt() @Min(0) draftVersion!: number;
  @IsObject() document!: Record<string, unknown>;
}
export class PublishGamingLayoutDto extends GamingVenueQueryDto {
  @IsInt() @Min(0) baseRevision!: number;
  @IsInt() @Min(1) draftVersion!: number;
  @IsUUID('4') requestKey!: string;
}
export class RestoreGamingLayoutDto extends PublishGamingLayoutDto { @IsUUID() revisionId!: string; }
