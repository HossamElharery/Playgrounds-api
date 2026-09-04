import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { LoginEmailDto } from './dto/login-email.dto';
import { RegisterOwnerDto } from './dto/register-owner.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { OAuthGoogleDto } from './dto/oauth-google.dto';
import { OAuthAppleDto } from './dto/oauth-apple.dto';
import { IsPhoneNumber, IsString, Length, MinLength } from 'class-validator';
import { Public } from '../../common/decorators/public.decorator';
import { AuthGuard } from '../../common/guards/auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';

class ForgotPasswordDto {
  @IsPhoneNumber()
  phone!: string;
}

class ResetPasswordDto extends ForgotPasswordDto {
  @IsString()
  @Length(4, 4)
  code!: string;

  @IsString()
  @MinLength(8)
  newPassword!: string;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('otp/request')
  requestOtp(@Body() dto: RequestOtpDto) {
    return this.authService.requestOtp(dto.phone);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('otp/verify')
  async verifyOtp(@Body() dto: VerifyOtpDto) {
    const result = await this.authService.verifyOtp(dto);
    return { message: 'authenticated', result };
  }

  @Public()
  @Post('register')
  async register(@Body() dto: RegisterOwnerDto) {
    const result = await this.authService.registerOwner(dto);
    return { message: 'account created', result };
  }

  @Public()
  @Post('login')
  async login(@Body() dto: LoginEmailDto) {
    const result = await this.authService.loginEmail(dto);
    return { message: 'authenticated', result };
  }

  @Public()
  @Post('oauth/google')
  async oauthGoogle(@Body() dto: OAuthGoogleDto) {
    const result = await this.authService.oauthGoogle(dto);
    return { message: 'authenticated', result };
  }

  @Public()
  @Post('oauth/apple')
  async oauthApple(@Body() dto: OAuthAppleDto) {
    const result = await this.authService.oauthApple(dto);
    return { message: 'authenticated', result };
  }

  @Public()
  @Post('refresh')
  async refresh(@Body() dto: RefreshTokenDto) {
    const result = await this.authService.refresh(dto.refreshToken);
    return { message: 'refreshed', result };
  }

  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('logout')
  logout(@Body() dto: RefreshTokenDto) {
    return this.authService.logout(dto.refreshToken);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('logout-all')
  logoutAll(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.logoutAll(user.id);
  }

  // Never returns the OTP — it only ever leaves the server via OtpDelivery (console/SMS provider).
  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('password/forgot')
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.requestPasswordReset(dto.phone);
  }

  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('password/reset')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto.phone, dto.code, dto.newPassword);
  }
}
