import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { envValidationSchema } from '../../common/config/env.validation';
import { AuthContextMiddleware } from '../../common/middlewares/auth-context.middleware';
import { AuthGuard } from '../../common/guards/auth.guard';

import { PrismaModule } from '../prisma/prisma.module';
import { PresenceModule } from '../presence/presence.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { UsersModule } from '../users/users.module';
import { EmailModule } from '../email/email.module';
import { SmsModule } from '../sms/sms.module';
import { RbacModule } from '../rbac/rbac.module';
import { ContentModule } from '../content/content.module';
import { GeoModule } from '../geo/geo.module';
import { VenuesModule } from '../venues/venues.module';
import { BookingsModule } from '../bookings/bookings.module';
import { PaymentsModule } from '../payments/payments.module';
import { ReviewsModule } from '../reviews/reviews.module';
import { SocialModule } from '../social/social.module';
import { ChatModule } from '../chat/chat.module';
import { SquadModule } from '../squad/squad.module';
import { RewardsModule } from '../rewards/rewards.module';
import { PulseModule } from '../pulse/pulse.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OwnerModule } from '../owner/owner.module';
import { PartnersModule } from '../partners/partners.module';
import { AdminModule } from '../admin/admin.module';
import { JobsModule } from '../jobs/jobs.module';
import { GamesModule } from '../games/games.module';
import { BundlesModule } from '../bundles/bundles.module';
import { MembershipModule } from '../membership/membership.module';
import { TournamentsModule } from '../tournaments/tournaments.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
    }),
    ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 120 }] }),
    ScheduleModule.forRoot(),
    PrismaModule,
    PresenceModule,
    RealtimeModule,
    EmailModule,
    SmsModule,
    AuthModule,
    RbacModule,
    StorageModule,
    UsersModule,
    ContentModule,
    GeoModule,
    VenuesModule,
    PaymentsModule,
    BookingsModule,
    ReviewsModule,
    SocialModule,
    ChatModule,
    SquadModule,
    RewardsModule,
    PulseModule,
    NotificationsModule,
    OwnerModule,
    PartnersModule,
    AdminModule,
    JobsModule,
    GamesModule,
    BundlesModule,
    MembershipModule,
    TournamentsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    AuthContextMiddleware,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuthContextMiddleware).forRoutes('*');
  }
}
