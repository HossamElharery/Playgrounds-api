import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Body, Headers, UnauthorizedException, BadRequestException, NotFoundException, Logger, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import * as Sentry from '@sentry/nestjs';
import { AuthGuard } from '../../common/guards/auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { Inject } from '@nestjs/common';
import { GatewayError, InvalidWebhookSignatureError, PAYMENT_GATEWAY, type PaymentGateway } from '../payments/payment-gateway.interface';
import { PayBookingDto } from './dto/pay-booking.dto';
import { PaymentIntentsService } from './payment-intents.service';

@ApiTags('payments')
@Controller()
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(
    private readonly intents: PaymentIntentsService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  /** Lets the apps decide whether to offer "Pay now"; never reveals keys. */
  @Public()
  @Get('payments/config')
  config() {
    return this.intents.publicConfig();
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Post('bookings/:id/pay')
  pay(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PayBookingDto) {
    return this.intents.startPayment(user.id, id, dto.lang ?? 'ar');
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Get('bookings/:id/payment')
  status(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.intents.statusFor(user.id, id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Get('admin/payments/attention')
  attention() {
    return this.intents.needingAttention();
  }

  /**
   * The provider's server-to-server notification. Trusted only after its signature verifies;
   * answers 2xx for anything verified (even if it needs no action) so the provider stops
   * retrying, and 4xx for what fails to verify.
   */
  @Public()
  @SkipThrottle()
  @HttpCode(200)
  @Post('payments/webhooks/:provider')
  async webhook(
    @Param('provider') provider: string,
    @Body() body: unknown,
    @Query() query: Record<string, unknown>,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    if (!this.gateway.isLive || provider !== this.gateway.name) throw new NotFoundException();
    let event;
    try {
      event = this.gateway.parseWebhook({ body, query, headers });
    } catch (error) {
      if (error instanceof InvalidWebhookSignatureError) {
        this.logger.warn(`Rejected a ${provider} notification with a bad signature`);
        throw new UnauthorizedException('Invalid signature');
      }
      if (error instanceof GatewayError) {
        // Signed (or unsigned) but not something we understand: not worth a retry storm.
        this.logger.warn(`Unreadable ${provider} notification: ${error.message}`);
        throw new BadRequestException('Unreadable notification');
      }
      throw error;
    }
    try {
      const outcome = await this.intents.applyEvent(provider, event);
      return { received: true, outcome };
    } catch (error) {
      Sentry.captureException(error, { tags: { area: 'payment-webhook' }, extra: { eventId: event.eventId, intentId: event.intentId } });
      throw error; // 5xx: the provider retries, and the reconciler is the second net
    }
  }
}
