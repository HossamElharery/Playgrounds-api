import {
  INestApplication,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as cookieParser from 'cookie-parser';
import * as express from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import * as path from 'path';
import { SocketIoAdapter } from './common/adapters/socket-io.adapter';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { imageVariantMiddleware } from './modules/storage/image-variants';
import { isShutdownDraining } from './common/lifecycle/shutdown-state';

export function configureApp(app: INestApplication): ConfigService {
  const config = app.get(ConfigService);

  if (config.get<string>('NODE_ENV') === 'production') {
    const expressApp = app
      .getHttpAdapter()
      .getInstance() as express.Application;
    expressApp.set('trust proxy', 1);
  }

  app.use(
    (
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (!isShutdownDraining()) return next();
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil(config.get<number>('SHUTDOWN_DRAIN_MS', 5_000) / 1000),
      );
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(503).json({ status: 'draining' });
    },
  );

  app.use(
    (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      const supplied = req.get('x-request-id');
      const requestId =
        supplied && /^[a-zA-Z0-9_-]{1,64}$/.test(supplied)
          ? supplied
          : randomUUID();
      req.headers['x-request-id'] = requestId;
      res.setHeader('X-Request-ID', requestId);
      const started = Date.now();
      res.once('finish', () => {
        if (res.statusCode >= 500)
          console.error(
            '[http-error]',
            JSON.stringify({
              requestId,
              method: req.method,
              path: req.path,
              status: res.statusCode,
              durationMs: Date.now() - started,
            }),
          );
      });
      next();
    },
  );

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.use(cookieParser());
  app.use(
    '/uploads/posts/thumbnails',
    express.static(path.join(process.cwd(), 'uploads/posts/thumbnails'), {
      maxAge: '1y',
      immutable: true,
    }),
  );
  app.use(
    '/uploads',
    express.static(path.join(process.cwd(), 'uploads'), {
      maxAge: '1y',
      immutable: true,
    }),
  );
  app.use(
    '/uploads',
    imageVariantMiddleware(path.join(process.cwd(), 'uploads')),
  );

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
