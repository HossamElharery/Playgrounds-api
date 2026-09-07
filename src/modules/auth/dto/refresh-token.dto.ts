import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIuLi4ifQ.example',
    description: 'refreshToken from login / OTP verify response',
  })
  @IsString()
  refreshToken!: string;
}
