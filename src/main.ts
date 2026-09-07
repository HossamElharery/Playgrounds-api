import { NestFactory } from '@nestjs/core';
import { AppModule } from './modules/app/app.module';
import { configureApp } from './bootstrap';
import { setupSwagger } from './common/swagger/swagger.setup';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = configureApp(app);
  setupSwagger(app);

  const port = config.get<number>('PORT', 3000);
  await app.listen(port);

  console.log(`Mal3ab API listening on :${port} — docs at /api/docs`);
}
bootstrap();
