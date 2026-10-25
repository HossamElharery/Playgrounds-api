import './instrument';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './modules/app/app.module';
import { configureApp } from './bootstrap';
import { setupSwagger } from './common/swagger/swagger.setup';
import { beginShutdownDrain } from './common/lifecycle/shutdown-state';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = configureApp(app);
  setupSwagger(app);
  const port = config.get<number>('PORT', 3000);
  await app.listen(port);

  const drainMs = config.get<number>('SHUTDOWN_DRAIN_MS', 5_000);
  let shutdownStarted = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    beginShutdownDrain();
    console.log(
      `Received ${signal}; draining for ${drainMs}ms before shutdown`,
    );
    try {
      if (drainMs > 0) await wait(drainMs);
      await app.close();
      process.exitCode = 0;
    } catch (error) {
      console.error('Graceful shutdown failed', error);
      process.exitCode = 1;
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  console.log(`Matchena API listening on :${port} — docs at /api/docs`);
}
void bootstrap();
