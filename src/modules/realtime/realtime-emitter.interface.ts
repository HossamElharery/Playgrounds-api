import { Injectable } from '@nestjs/common';

/**
 * Abstract emitter every feature module (friends/chat/squad/pulse) depends
 * on instead of the concrete gateway — keeps those modules decoupled from
 * Socket.IO wiring. RealtimeModule provides the real implementation.
 */
@Injectable()
export abstract class RealtimeGatewayEmitter {
  /** Drops every open socket of a user (suspended / removed accounts must not keep a live connection). */
  abstract disconnectUser(userId: string): void;
  abstract revokeRoomAccess(userId: string, room: string): void;
  abstract emitToUser(
    userId: string,
    event: { type: string; [key: string]: unknown },
  ): void;
  abstract emitToRoom(
    room: string,
    event: { type: string; [key: string]: unknown },
  ): void;
}
