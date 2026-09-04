import { IsInt, IsString, Max, Min } from 'class-validator';

/** Matches AvatarConfig in core/models/mal3ab.model.ts (§13.2) — five values, no meshes stored server-side. */
export class UpdateAvatarConfigDto {
  @IsString()
  skinTone!: string;

  @IsString()
  hairColor!: string;

  @IsString()
  kitColor!: string;

  @IsString()
  sportId!: string;

  @IsInt()
  @Min(0)
  @Max(99)
  number!: number;
}
