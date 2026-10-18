import { Injectable } from '@nestjs/common';

@Injectable()
export abstract class RealtimeGatewayEmitter {
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
