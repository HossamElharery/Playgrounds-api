import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { createHash } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { isShutdownDraining } from '../../../../common/lifecycle/shutdown-state';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  HUB_SOCKET_PATH,
  HubConsole,
  HubFrame,
  hubRequest,
  hubWelcome,
  parseHubFrame,
} from './hub-protocol';

const PING_MS = 30_000;
const MAX_HUBS_PER_VENUE = 8;
const BEARER = /^Bearer ([A-Za-z0-9_-]{32,96})$/;

export const hashHubSecret = (secret: string) =>
  createHash('sha256').update(secret).digest('hex');

export class HubRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ConsoleHubHandler {
  hello(
    hubId: string,
    venueId: string,
    frame: Extract<HubFrame, { kind: 'hello' }>,
  ): Promise<void>;
  consoles(hubId: string, venueId: string, list: HubConsole[]): Promise<void>;
  closed(hubId: string, venueId: string): Promise<void>;
}

interface Link {
  socket: WebSocket;
  hubId: string;
  venueId: string;
  alive: boolean;
}

/**
 * The WebSocket endpoint Matchena Hubs dial. One link per hub; the API runs as a single instance so
 * whoever holds a hub's socket is the one that talks to its consoles (same model as the plug hub).
 */
@Injectable()
export class ConsoleHubService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(ConsoleHubService.name);
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: 256 * 1024,
    perMessageDeflate: false,
  });
  private readonly links = new Map<string, Link>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly pending = new Map<
    number,
    {
      hubId: string;
      resolve: (v: Record<string, unknown>) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private handler: ConsoleHubHandler | null = null;
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

  setHandler(handler: ConsoleHubHandler) {
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

  isOnline(hubId: string) {
    return this.links.get(hubId)?.socket.readyState === WebSocket.OPEN;
  }

  connectedIds(): string[] {
    return [...this.links.keys()];
  }

  disconnect(hubId: string, reason = 'removed') {
    this.links.get(hubId)?.socket.close(4001, reason);
  }

  /** Ask a hub to do something and wait for its answer. */
  call(
    hubId: string,
    op: string,
    args: Record<string, unknown> = {},
    timeoutMs = 30_000,
  ): Promise<Record<string, unknown>> {
    const link = this.links.get(hubId);
    if (!link || link.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new HubRpcError('HUB_OFFLINE', 'hub offline'));
    const id = this.nextId++;
    if (this.nextId > 2_000_000_000) this.nextId = 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HubRpcError('HUB_TIMEOUT', `${op} timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { hubId, resolve, reject, timer });
      link.socket.send(hubRequest(id, op, args), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new HubRpcError('HUB_OFFLINE', error.message));
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
    const path = (req.url ?? '').split('?')[0].replace(/\/+$/, '');
    if (path !== HUB_SOCKET_PATH) return; // other upgrade handlers own their paths
    try {
      if (isShutdownDraining())
        return this.reject(socket, 503, 'Service Unavailable');
      const header = req.headers.authorization;
      const match = typeof header === 'string' ? BEARER.exec(header) : null;
      if (!match) return this.reject(socket, 401, 'Unauthorized');
      const hub = await this.prisma.gamingHub.findUnique({
        where: { tokenHash: hashHubSecret(match[1]) },
        select: { id: true, venueId: true },
      });
      if (!hub) return this.reject(socket, 401, 'Unauthorized');
      const venueLinks = [...this.links.values()].filter(
        (l) => l.venueId === hub.venueId,
      ).length;
      if (!this.links.has(hub.id) && venueLinks >= MAX_HUBS_PER_VENUE)
        return this.reject(socket, 429, 'Too Many Requests');
      this.wss.handleUpgrade(req, socket, head, (ws) =>
        this.accept(ws, hub.id, hub.venueId),
      );
    } catch (error) {
      this.logger.warn(`hub upgrade failed: ${(error as Error).message}`);
      this.reject(socket, 500, 'Internal Server Error');
    }
  }

  private accept(socket: WebSocket, hubId: string, venueId: string) {
    const previous = this.links.get(hubId);
    const link: Link = { socket, hubId, venueId, alive: true };
    this.links.set(hubId, link);
    if (previous && previous !== link) previous.socket.close(4000, 'replaced');
    socket.on('pong', () => (link.alive = true));
    socket.on('message', (data, binary) => {
      link.alive = true;
      if (binary) return;
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.from(data as ArrayBuffer).toString('utf8');
      void this.message(link, text).catch((error) =>
        this.logger.warn(`hub frame failed: ${(error as Error).message}`),
      );
    });
    socket.on('close', () => void this.closed(link));
    socket.on('error', () => socket.terminate());
    socket.send(hubWelcome(new Date()));
  }

  private async message(link: Link, raw: string) {
    if (this.links.get(link.hubId) !== link) return;
    const frame = parseHubFrame(raw);
    if (frame.kind === 'ignored') return;
    if (frame.kind === 'response') {
      const waiting = this.pending.get(frame.id);
      if (!waiting || waiting.hubId !== link.hubId) return;
      this.pending.delete(frame.id);
      clearTimeout(waiting.timer);
      if (frame.ok) waiting.resolve(frame.data ?? {});
      else
        waiting.reject(
          new HubRpcError(
            frame.code || 'HUB_ERROR',
            frame.message || frame.code || 'hub error',
          ),
        );
      return;
    }
    // hello and snapshots are applied in arrival order per hub
    void this.serial(link.hubId, () =>
      frame.kind === 'hello'
        ? this.handler?.hello(link.hubId, link.venueId, frame)
        : this.handler?.consoles(link.hubId, link.venueId, frame.list),
    );
  }

  private serial(hubId: string, work: () => Promise<void> | undefined) {
    const next = (this.queues.get(hubId) ?? Promise.resolve())
      .then(work)
      .catch((error) =>
        this.logger.warn(`hub event failed: ${(error as Error).message}`),
      );
    this.queues.set(hubId, next);
    void next.then(() => {
      if (this.queues.get(hubId) === next) this.queues.delete(hubId);
    });
    return next;
  }

  private async closed(link: Link) {
    if (this.links.get(link.hubId) !== link) return; // replaced by a newer link
    this.links.delete(link.hubId);
    for (const [id, waiting] of this.pending) {
      if (waiting.hubId !== link.hubId) continue;
      clearTimeout(waiting.timer);
      this.pending.delete(id);
      waiting.reject(new HubRpcError('HUB_OFFLINE', 'hub disconnected'));
    }
    await this.serial(link.hubId, () =>
      this.handler?.closed(link.hubId, link.venueId),
    );
  }

  private ping() {
    for (const link of this.links.values()) {
      if (!link.alive) {
        link.socket.terminate();
        continue;
      }
      link.alive = false;
      link.socket.ping();
    }
  }
}
