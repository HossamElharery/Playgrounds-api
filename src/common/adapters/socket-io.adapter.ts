import { INestApplication } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { IncomingMessage } from 'node:http';
import type { Server, ServerOptions, Socket } from 'socket.io';
import { SocketAbuseLimiter } from './socket-abuse-limiter';
import { validSocketPacket } from './socket-packet-validator';
import { isShutdownDraining } from '../lifecycle/shutdown-state';

export class SocketIoAdapter extends IoAdapter {
  private readonly limiter = new SocketAbuseLimiter();

  constructor(
    app: INestApplication,
    private readonly corsOrigins: string[],
  ) {
    super(app);
  }

  createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, {
      ...options,
      // Reject oversized packets before JSON parsing or gateway dispatch. Game
      // messages are tiny; 64 KiB leaves ample room for every valid payload.
      maxHttpBufferSize: 64 * 1024,
      perMessageDeflate: false,
      connectTimeout: 20_000,
      pingInterval: 25_000,
      pingTimeout: 20_000,
      allowRequest: (
        request: IncomingMessage,
        callback: (error: string | null | undefined, success: boolean) => void,
      ) => {
        if (isShutdownDraining()) {
          callback('server_draining', false);
          return;
        }
        const forwarded = request.headers['x-forwarded-for'];
        // Traefik appends the real peer to X-Forwarded-For. Use the final hop so
        // a client cannot choose its own limiter bucket with a forged prefix.
        const ip =
          (Array.isArray(forwarded)
            ? forwarded.at(-1)
            : forwarded?.split(',').at(-1)
          )?.trim() ||
          request.socket.remoteAddress ||
          'unknown';
        callback(null, this.limiter.allowConnection(ip));
      },
      cors: {
        origin: this.corsOrigins,
        credentials: true,
      },
    }) as Server;

    server.use((socket: Socket, next) => {
      socket.use((_packet, packetNext) => {
        if (!this.limiter.allowEvent(socket.id)) {
          return packetNext(new Error('rate_limited'));
        }
        if (!validSocketPacket(_packet)) {
          return packetNext(new Error('invalid_payload'));
        }
        return packetNext();
      });
      socket.once('disconnect', () => this.limiter.forget(socket.id));
      next();
    });
    return server;
  }
}
