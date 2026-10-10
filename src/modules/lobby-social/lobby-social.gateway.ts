import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConnectedSocket, MessageBody, OnGatewayInit, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { LobbySocialService } from './lobby-social.service';
import { SocialCommand } from './social.types';
import { SocialRuleError } from './social.engine';

@Injectable()
@WebSocketGateway({ cors: { origin: true, credentials: true } })
export class LobbySocialGateway implements OnGatewayInit, OnModuleDestroy {
  @WebSocketServer() server!: Server;
  private budgets = new Map<string, { at: number; count: number }>();
  constructor(private readonly social: LobbySocialService) {}
  afterInit(): void {
    this.social.publish = (squadId, snapshots) => {
      this.server?.to(`squad:${squadId}`).emit('lobby.social.public', snapshots.get(''));
      for (const [userId, state] of snapshots) if (userId) {
        this.server?.to(`user:${userId}`).emit('lobby.social.state', state);
      }
    };
  }
  onModuleDestroy(): void { this.social.publish = null; this.budgets.clear(); }
  @SubscribeMessage('lobby.social.state.request')
  async state(@ConnectedSocket() client: Socket, @MessageBody() data: { squadId?: unknown }): Promise<void> {
    const userId = await this.guard(client, data?.squadId);
    if (!userId) return;
    try { client.emit('lobby.social.state', await this.social.snapshot(data.squadId as string, userId)); }
    catch { client.emit('lobby.social.error', { squadId: data.squadId, code: 'unavailable' }); }
  }
  @SubscribeMessage('lobby.social.command')
  async command(@ConnectedSocket() client: Socket, @MessageBody() data: SocialCommand): Promise<void> {
    const userId = await this.guard(client, data?.squadId, data?.requestId);
    if (!userId) return;
    if (!data || typeof data.action !== 'string' || typeof data.requestId !== 'string' || data.requestId.length > 80 || !data.requestId.length) return;
    try {
      const state = await this.social.command(userId, data);
      client.emit('lobby.social.ack', { requestId: data.requestId, state });
    } catch (e) {
      client.emit('lobby.social.error', { squadId: data.squadId, requestId: data.requestId,
        code: e instanceof SocialRuleError ? e.code : 'unavailable' });
    }
  }
  private async guard(client: Socket, squadId: unknown, requestId?: unknown): Promise<string | null> {
    await client.data?.authReady;
    const userId = client.data?.userId;
    if (typeof userId !== 'string' || typeof squadId !== 'string' || !squadId.length || squadId.length > 64 || !client.rooms.has(`squad:${squadId}`)) return null;
    const now = Date.now();
    let budget = this.budgets.get(userId);
    if (!budget || now - budget.at > 10_000) { budget = { at: now, count: 0 }; this.budgets.set(userId, budget); }
    if (++budget.count > 45) { client.emit('lobby.social.error', { squadId, code: 'cooldown',
      ...(typeof requestId === 'string' && requestId.length<=80 ? {requestId} : {}) }); return null; }
    if (this.budgets.size > 2000) for (const [id, b] of this.budgets) if (now - b.at > 10_000) this.budgets.delete(id);
    return userId;
  }
}
