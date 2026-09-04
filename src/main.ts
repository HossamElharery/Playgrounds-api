/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { NestFactory } from '@nestjs/core';
import { AppModule } from './modules/app/app.module';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { AllExceptionsFilter } from './common/exceptions/allExceptionsFilter';
import * as express from 'express';

import corsOptions from './common/config/corsOptions';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use(express.urlencoded({ extended: true })); // Enables form-data parsing

  // Enable CORS with custom options
  app.enableCors(corsOptions);

  // Set global prefix
  app.setGlobalPrefix('api/v1', {
    exclude: [{ path: '', method: RequestMethod.GET }],
  });

  // Use the global exception filter
  // app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalFilters(new AllExceptionsFilter()); // Use DI to get the filter instance

  // Enable the global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // Remove properties not defined in the DTO
      forbidNonWhitelisted: true, // Throw an error for unknown properties
      transform: true, // Automatically transform request payloads to DTO instances
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.useWebSocketAdapter(new IoAdapter(app));

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
