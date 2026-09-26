import {
  INestApplication,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as cookieParser from 'cookie-parser';
import * as express from 'express';
import helmet from 'helmet';
import * as path from 'path';
import { SocketIoAdapter } from './common/adapters/socket-io.adapter';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';

/**
 * Shared app configuration used by both the real server (main.ts) and the
 * e2e test bootstrap — keeps them from drifting apart (global prefix,
 * filters, interceptors, pipes must be identical in both).
 */
export function configureApp(app: INestApplication): ConfigService {
  const config = app.get(ConfigService);

  // Coolify terminates TLS at its reverse proxy. Trust exactly that first hop
  // so secure-protocol/IP-aware middleware reads X-Forwarded-* correctly.
  if (config.get<string>('NODE_ENV') === 'production') {
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
  }

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.use(cookieParser());
  // Thumbnail URLs are immutable derivatives; avoid downloading them on each visit.
  app.use('/uploads/posts/thumbnails', express.static(path.join(process.cwd(), 'uploads/posts/thumbnails'), { maxAge: '1y', immutable: true }));
  app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

  const corsOrigins = config
    .get<string>('CORS_ORIGINS', 'http://localhost:4200')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.enableCors({
    origin: corsOrigins,
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

  app.useWebSocketAdapter(new SocketIoAdapter(app, corsOrigins));

  return config;
}
