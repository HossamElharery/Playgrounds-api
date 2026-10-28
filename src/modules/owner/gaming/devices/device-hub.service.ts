import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { PrismaService } from '../../../prisma/prisma.service';
import { isShutdownDraining } from '../../../../common/lifecycle/shutdown-state';
import {
  isAuthError,
  parseShellyFrame,
  shellyRequest,
  ShellySwitchState,
} from './shelly-protocol';

/** Path a plug dials; the venue's device token is the last segment. */
export const DEVICE_SOCKET_PREFIX = '/api/v1/gaming/devices/shelly/';
const TOKEN = /^[A-Za-z0-9_-]{24,64}$/;
const MAX_PER_VENUE = 120;
const RPC_TIMEOUT_MS = 8_000;
const PING_MS = 30_000;

export interface DeviceHubHandler {
  connected(venueId: string, deviceId: string): Promise<void>;
  status(
    venueId: string,
    deviceId: string,
    full: boolean,
    switches: ShellySwitchState[],
  ): Promise<void>;
  disconnected(venueId: string, deviceId: string): Promise<void>;
}

export class DeviceRpcError extends Error {
  constructor(
    readonly code: 'offline' | 'timeout' | 'auth' | 'device',
    message: string,
  ) {
    super(message);
  }
}

interface Link {
  socket: WebSocket;
  venueId: string;
  deviceId: string | null;
  alive: boolean;
}

/**
 * Raw WebSocket endpoint for Shelly Gen2+ outbound connections (Shelly does not speak socket.io).
 * Holds the live sockets in memory: the API runs as one instance, so whoever holds a plug's socket
 * is the one that reconciles it.
 */
@Injectable()
export class DeviceHubService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(DeviceHubService.name);
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
  });
  private readonly links = new Map<string, Link>();
  private readonly sockets = new Set<Link>();
  /** Per-plug chain so connect / status / disconnect are applied in arrival order. */
  private readonly queues = new Map<string, Promise<void>>();
  private readonly pending = new Map<
    number,
    {
      deviceId: string;
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private handler: DeviceHubHandler | null = null;
  private nextId = 1;
  private pinger?: NodeJS.Timeout;
  private server?: Server;
  private readonly onUpgrade = (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => void this.upgrade(req, socket, head);

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly prisma: PrismaService,
  ) {}

  setHandler(handler: DeviceHubHandler) {
    this.handler = handler;
  }

  onApplicationBootstrap() {
    const server = this.adapterHost.httpAdapter?.getHttpServer() as
      | Server
      | undefined;
    if (!server?.on) return;
    this.server = server;
    server.on('upgrade', this.onUpgrade);
    this.pinger = setInterval(() => this.ping(), PING_MS);
    this.pinger.unref?.();
  }

  onApplicationShutdown() {
    this.server?.off('upgrade', this.onUpgrade);
    if (this.pinger) clearInterval(this.pinger);
    for (const link of this.links.values())
      link.socket.close(1001, 'server restart');
    this.wss.close();
  }

  /** Device ids with a live socket. */
  connectedIds(): string[] {
    return [...this.links.keys()];
  }

  isOnline(deviceId: string) {
    return this.links.has(deviceId);
  }

  disconnect(deviceId: string) {
    this.links.get(deviceId)?.socket.close(4001, 'removed');
  }

  call(
    deviceId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const link = this.links.get(deviceId);
    if (!link || link.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new DeviceRpcError('offline', 'device offline'));
    const id = this.nextId++;
    if (this.nextId > 2_000_000_000) this.nextId = 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DeviceRpcError('timeout', `${method} timed out`));
      }, RPC_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { deviceId, resolve, reject, timer });
      link.socket.send(shellyRequest(id, method, params), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new DeviceRpcError('offline', error.message));
      });
    });
  }

  private reject(socket: Duplex, status: number, text: string) {
    socket.write(
      `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
    socket.destroy();
  }

  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const path = (req.url ?? '').split('?')[0];
    if (!path.startsWith(DEVICE_SOCKET_PREFIX)) return; // socket.io and others handle their own paths
    try {
      const token = decodeURIComponent(
        path.slice(DEVICE_SOCKET_PREFIX.length).replace(/\/+$/, ''),
      );
      if (isShutdownDraining())
        return this.reject(socket, 503, 'Service Unavailable');
      if (!TOKEN.test(token)) return this.reject(socket, 404, 'Not Found');
      const venue = await this.prisma.venue.findUnique({
        where: { gamingDeviceToken: token },
        select: { id: true },
      });
      if (!venue) return this.reject(socket, 401, 'Unauthorized');
      const count = [...this.sockets].filter(
        (l) => l.venueId === venue.id,
      ).length;
      if (count >= MAX_PER_VENUE)
        return this.reject(socket, 429, 'Too Many Requests');
      this.wss.handleUpgrade(req, socket, head, (ws) =>
        this.accept(ws, venue.id),
      );
    } catch (error) {
      this.logger.warn(`device upgrade failed: ${(error as Error).message}`);
      this.reject(socket, 500, 'Internal Server Error');
    }
  }

  private accept(socket: WebSocket, venueId: string) {
    const link: Link = { socket, venueId, deviceId: null, alive: true };
    this.sockets.add(link);
    socket.on('pong', () => (link.alive = true));
    socket.on('message', (data, binary) => {
      link.alive = true;
      if (binary) return;
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.from(data as ArrayBuffer).toString('utf8');
      void this.message(link, text).catch((error) =>
        this.logger.warn(`device frame failed: ${(error as Error).message}`),
      );
    });
    socket.on('close', () => void this.closed(link));
    socket.on('error', () => socket.terminate());
  }

  private async message(link: Link, raw: string) {
    const frame = parseShellyFrame(raw);
    if (frame.kind === 'ignored') return;
    if (link.deviceId === null) {
      link.deviceId = frame.deviceId;
      const previous = this.links.get(frame.deviceId);
      this.links.set(frame.deviceId, link);
      if (previous && previous !== link) {
        previous.deviceId = null; // its close must not mark the new link offline
        previous.socket.close(4000, 'replaced');
      }
      const deviceId = frame.deviceId;
      void this.serial(deviceId, () =>
        this.handler?.connected(link.venueId, deviceId),
      );
    } else if (frame.deviceId !== link.deviceId) {
      link.socket.close(4002, 'device id changed');
      return;
    }
    if (frame.kind === 'response') {
      const waiting = this.pending.get(frame.id);
      if (!waiting || waiting.deviceId !== frame.deviceId) return;
      this.pending.delete(frame.id);
      clearTimeout(waiting.timer);
      if (frame.error)
        waiting.reject(
          new DeviceRpcError(
            isAuthError(frame.error) ? 'auth' : 'device',
            frame.error.message || `error ${frame.error.code}`,
          ),
        );
      else waiting.resolve(frame.result);
      return;
    }
    void this.serial(frame.deviceId, () =>
      this.handler?.status(
        link.venueId,
        frame.deviceId,
        frame.full,
        frame.switches,
      ),
    );
  }

  private serial(deviceId: string, work: () => Promise<void> | undefined) {
    const next = (this.queues.get(deviceId) ?? Promise.resolve())
      .then(work)
      .catch((error) =>
        this.logger.warn(`device event failed: ${(error as Error).message}`),
      );
    this.queues.set(deviceId, next);
    void next.then(() => {
      if (this.queues.get(deviceId) === next) this.queues.delete(deviceId);
    });
    return next;
  }

  private async closed(link: Link) {
    this.sockets.delete(link);
    const deviceId = link.deviceId;
    if (!deviceId || this.links.get(deviceId) !== link) return;
    this.links.delete(deviceId);
    for (const [id, waiting] of this.pending) {
      if (waiting.deviceId !== deviceId) continue;
      clearTimeout(waiting.timer);
      this.pending.delete(id);
      waiting.reject(new DeviceRpcError('offline', 'device disconnected'));
    }
    await this.serial(deviceId, () =>
      this.handler?.disconnected(link.venueId, deviceId),
    );
  }

  private ping() {
    for (const link of this.sockets) {
      if (!link.alive) {
        link.socket.terminate();
        continue;
      }
      link.alive = false;
      link.socket.ping();
    }
  }
}
