import { Injectable } from '@nestjs/common';

export type VoiceScopeVerifier = (scopeId: string, userId: string) => boolean;

/**
 * A scope whose members must stay anonymous to each other names them by an opaque id on the wire: `toUser` turns what
 * a sender wrote into the real user id (null = unknown), `toKey` is how the receiver is told who it came from.
 */
export interface VoiceScopeNames {
  toUser(scopeId: string, viewerId: string, key: string): string | null;
  toKey(scopeId: string, userId: string): string | null;
}

/**
 * Voice signalling is checked against a "scope": a squad (the default, a database lookup) or another kind of room
 * that registers itself here (the camo game: `camo:<matchId>`). The gateway asks, so it never depends on the game.
 */
@Injectable()
export class VoiceScopeRegistry {
  private readonly verifiers = new Map<string, VoiceScopeVerifier>();
  private readonly names = new Map<string, VoiceScopeNames>();

  register(kind: string, verifier: VoiceScopeVerifier, names?: VoiceScopeNames): void {
    this.verifiers.set(kind, verifier);
    if (names) this.names.set(kind, names);
  }

  unregister(kind: string): void {
    this.verifiers.delete(kind);
    this.names.delete(kind);
  }

  private namesOf(scope: string): { names: VoiceScopeNames; id: string } | null {
    const i = scope.indexOf(':');
    const names = i > 0 ? this.names.get(scope.slice(0, i)) : undefined;
    return names ? { names, id: scope.slice(i + 1) } : null;
  }

  /** The real user a sender addressed. A plain squad (or a scope without opaque names) uses user ids as they are. */
  resolveTarget(scope: string, viewerId: string, key: string): string | null {
    const n = this.namesOf(scope);
    return n ? n.names.toUser(n.id, viewerId, key) : key;
  }

  /** What the receiver is told about the sender. */
  senderKey(scope: string, userId: string): string | null {
    const n = this.namesOf(scope);
    return n ? n.names.toKey(n.id, userId) : userId;
  }

  /** `kind:id` → the registered check; null when the id is a plain squad id. */
  check(scope: string, userId: string): boolean | null {
    const i = scope.indexOf(':');
    if (i <= 0) return null;
    const verifier = this.verifiers.get(scope.slice(0, i));
    return verifier ? verifier(scope.slice(i + 1), userId) : false;
  }
}
