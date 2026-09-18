import { INestApplication } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';

/**
 * Socket.IO CORS must echo a concrete origin when `credentials: true`.
 * The default Engine.IO policy (`Access-Control-Allow-Origin: *`) is invalid
 * with credentialed XHR and is what blocked local `localhost:4200 → :3000`
 * polling. Mirror the HTTP `CORS_ORIGINS` list so handshake and REST agree.
 */
export class SocketIoAdapter extends IoAdapter {
  constructor(
    app: INestApplication,
    private readonly corsOrigins: string[],
  ) {
    super(app);
  }

  createIOServer(port: number, options?: ServerOptions) {
    return super.createIOServer(port, {
      ...options,
      cors: {
        origin: this.corsOrigins,
        credentials: true,
      },
    });
  }
}
