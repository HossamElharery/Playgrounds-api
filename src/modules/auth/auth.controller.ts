import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiBody } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { GuestJoinDto } from './dto/guest-join.dto';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { LoginEmailDto } from './dto/login-email.dto';
import { RegisterOwnerDto } from './dto/register-owner.dto';
import { RegisterEmailDto } from './dto/register-email.dto';
import { RequestEmailRegistrationOtpDto } from './dto/request-email-registration-otp.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { OAuthGoogleDto } from './dto/oauth-google.dto';
import { OAuthFacebookDto } from './dto/oauth-facebook.dto';
import { WebAuthnVerifyDto } from './dto/webauthn.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { Public } from '../../common/decorators/public.decorator';
import { AuthGuard } from '../../common/guards/auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { WebAuthnService } from './webauthn.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly webauthn: WebAuthnService,
  ) {}

  @Public()
  @Get('providers')
  providers() {
    return this.authService.listLoginProviders();
  }

  @Public()
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @Post('guest/join-link')
  @ApiOperation({ summary: 'Join a squad from an invite link as a guest' })
  async guestJoin(@Body() dto: GuestJoinDto) {
    const result = await this.authService.joinSquadAsGuest(dto);
    return { message: 'authenticated', result };
  }

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
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('register/email/otp')
  @ApiOperation({ summary: 'Send a single-use email verification code' })
  requestEmailRegistrationOtp(@Body() dto: RequestEmailRegistrationOtpDto) {
    return this.authService.requestEmailRegistrationOtp(dto.email);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('register/email')
  @ApiOperation({
    summary: 'Verify the email code and create a player account',
  })
  async registerEmail(@Body() dto: RegisterEmailDto) {
    const result = await this.authService.registerPlayerEmail(dto);
    return { message: 'account created', result };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @ApiOperation({
    summary: 'Login with email + password',
  })
  @ApiBody({
    type: LoginEmailDto,
    examples: {
      account: {
        summary: 'Registered account',
        value: { email: 'user@example.com', password: 'YourPassword123!' },
      },
    },
  })
  async login(@Body() dto: LoginEmailDto) {
    const result = await this.authService.loginEmail(dto);
    return { message: 'authenticated', result };
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('oauth/google')
  async oauthGoogle(@Body() dto: OAuthGoogleDto) {
    const result = await this.authService.oauthGoogle(dto);
    return { message: 'authenticated', result };
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('oauth/facebook')
  async oauthFacebook(@Body() dto: OAuthFacebookDto) {
    const result = await this.authService.oauthFacebook(dto);
    return { message: 'authenticated', result };
  }

  @Public()
  @Post('webauthn/authenticate/options')
  webauthnAuthOptions() {
    return this.webauthn.authenticationOptions();
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('webauthn/authenticate/verify')
  async webauthnAuthVerify(@Body() dto: WebAuthnVerifyDto) {
    const result = await this.webauthn.verifyAuthentication(dto);
    return { message: 'authenticated', result };
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Post('webauthn/register/options')
  webauthnRegisterOptions(@CurrentUser() user: AuthenticatedUser) {
    return this.webauthn.registrationOptions({
      id: user.id,
      email: user.email ?? null,
      name: user.name ?? 'Player',
      phone: user.phone ?? '',
    });
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Post('webauthn/register/verify')
  webauthnRegisterVerify(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: WebAuthnVerifyDto,
  ) {
    return this.webauthn.verifyRegistration({ id: user.id }, dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Get('webauthn/credentials')
  listPasskeys(@CurrentUser() user: AuthenticatedUser) {
    return this.webauthn.list(user.id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete('webauthn/credentials/:id')
  removePasskey(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.webauthn.remove(user.id, id);
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
    return this.authService.requestPasswordReset(dto);
  }

  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('password/reset')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto, dto.code, dto.newPassword);
  }
}
