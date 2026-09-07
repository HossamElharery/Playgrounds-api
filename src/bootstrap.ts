import {
  INestApplication,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import * as cookieParser from 'cookie-parser';
import * as express from 'express';
import helmet from 'helmet';
import * as path from 'path';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';

/**
 * Shared app configuration used by both the real server (main.ts) and the
 * e2e test bootstrap — keeps them from drifting apart (global prefix,
 * filters, interceptors, pipes must be identical in both).
 */
export function configureApp(app: INestApplication): ConfigService {
  const config = app.get(ConfigService);

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.use(cookieParser());
  app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

  app.enableCors({
    origin: config
      .get<string>('CORS_ORIGINS', 'http://localhost:4200')
      .split(','),
    credentials: true,
  });

  app.setGlobalPrefix('api/v1', {
    exclude: [{ path: '', method: RequestMethod.GET }],
  });

  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.useWebSocketAdapter(new IoAdapter(app));

  return config;
}
