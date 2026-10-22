import { Injectable } from '@nestjs/common';

export type VoiceScopeVerifier = (scopeId: string, userId: string) => boolean;

/**
 * Voice signalling is checked against a "scope": a squad (the default, a database lookup) or another kind of room
 * that registers itself here (the camo game: `camo:<matchId>`). The gateway asks, so it never depends on the game.
 */
@Injectable()
export class VoiceScopeRegistry {
  private readonly verifiers = new Map<string, VoiceScopeVerifier>();

  register(kind: string, verifier: VoiceScopeVerifier): void {
    this.verifiers.set(kind, verifier);
  }

  unregister(kind: string): void {
    this.verifiers.delete(kind);
  }

  /** `kind:id` → the registered check; null when the id is a plain squad id. */
  check(scope: string, userId: string): boolean | null {
    const i = scope.indexOf(':');
    if (i <= 0) return null;
    const verifier = this.verifiers.get(scope.slice(0, i));
    return verifier ? verifier(scope.slice(i + 1), userId) : false;
  }
}
