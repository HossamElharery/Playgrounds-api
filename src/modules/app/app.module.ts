import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AppController } from './app.controller';
import { AuthenticationMiddleware } from '../auth/middlewares/authentication.middleware';
import { AppService } from './app.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { UsersModule } from '../users/users.module';
import { EmailModule } from '../email/email.module';
import { ServicesModule } from '../services/services.module';
import { ServiceRequestsModule } from '../service-requests/service-requests.module';
import { SettingsModule } from '../settings/settings.module';
import { BlogsModule } from '../blogs/blogs.module';
import { DashboardModule } from '../dashboard/dashboard.module';
@Module({
  imports: [
    EmailModule,
    PrismaModule,
    AuthModule,
    StorageModule,
    UsersModule,
    ServicesModule,
    ServiceRequestsModule,
    SettingsModule,
    BlogsModule,
    DashboardModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply().forRoutes().apply(AuthenticationMiddleware).forRoutes('*');
  }
}
