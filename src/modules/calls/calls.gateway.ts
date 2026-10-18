import { Injectable, Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { RealtimeGatewayEmitter } from '../realtime/realtime-emitter.interface';
import { CallsService } from './calls.service';

const MAX_SIGNAL_BYTES = 24_000;
const MAX_ID = 64;

type Signal = 'call.offer' | 'call.answer' | 'call.ice';

@Injectable()
@WebSocketGateway({ cors: { origin: true, credentials: true } })
export class CallsGateway {
  private readonly logger = new Logger(CallsGateway.name);

  constructor(
    private readonly calls: CallsService,
    private readonly emitter: RealtimeGatewayEmitter,
  ) {}

  @SubscribeMessage('call.ringing')
  ringing(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { callId?: unknown; native?: unknown },
  ) {
    return this.inOrder(client, async (userId) => {
      const callId = this.id(data?.callId);
      if (callId)
        await this.calls.markRinging(userId, callId, data?.native === true);
    });
  }

  @SubscribeMessage('call.offer')
  offer(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { callId?: unknown; sdp?: unknown },
  ) {
    return this.relay(client, 'call.offer', data, 'sdp');
  }

  @SubscribeMessage('call.answer')
  answer(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { callId?: unknown; sdp?: unknown },
  ) {
    return this.relay(client, 'call.answer', data, 'sdp');
  }

  @SubscribeMessage('call.ice')
  ice(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { callId?: unknown; candidate?: unknown },
  ) {
    return this.relay(client, 'call.ice', data, 'candidate');
  }

  private relay(
    client: Socket,
    type: Signal,
    data: { callId?: unknown } & Record<string, unknown>,
    key: 'sdp' | 'candidate',
  ) {
    return this.inOrder(client, async (userId) => {
      const callId = this.id(data?.callId);
      const body = data?.[key];
      if (!callId || !body || typeof body !== 'object') return;
      if (JSON.stringify(body).length > MAX_SIGNAL_BYTES) return;
      const peer = await this.calls.relayPeer(userId, callId);
      if (!peer) return;
      this.emitter.emitToUser(peer, {
        type,
        callId,
        fromUserId: userId,
        [key]: body,
      });
    });
  }

  private id(value: unknown): string | null {
    return typeof value === 'string' &&
      value.length > 0 &&
      value.length <= MAX_ID
      ? value
      : null;
  }

  private inOrder(
    client: Socket,
    task: (userId: string) => Promise<void>,
  ): Promise<void> {
    const data = client.data as {
      authReady?: Promise<void>;
      callChain?: Promise<void>;
      userId?: unknown;
    };
    const next = (
      data.callChain ??
      (data.authReady ?? Promise.resolve()).catch(() => undefined)
    )
      .then(() => {
        const userId =
          typeof data.userId === 'string' && data.userId ? data.userId : null;
        return userId ? task(userId) : undefined;
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `call signal failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    data.callChain = next;
    return next;
  }
}
