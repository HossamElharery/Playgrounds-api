import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString } from 'class-validator';

export class WebAuthnVerifyDto {
  @ApiProperty({
    description: 'Short-lived challenge token returned by the matching /options endpoint',
  })
  @IsString()
  challengeToken!: string;

  @ApiProperty({
    description: 'WebAuthn authenticator response JSON from the browser',
    type: 'object',
    additionalProperties: true,
  })
  @IsObject()
  credential!: Record<string, unknown>;

  @ApiPropertyOptional({ example: 'iPhone Face ID' })
  @IsOptional()
  @IsString()
  friendlyName?: string;
}
