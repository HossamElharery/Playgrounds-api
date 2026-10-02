import type { KnowledgeEntry, KnowledgeFlag } from './default-knowledge';

const FLAG_ENV: Record<KnowledgeFlag, string> = {
  morphs: 'LOBBY_MORPHS_ENABLED',
  movement: 'LOBBY_MOVEMENT_ENABLED',
  ball: 'LOBBY_BALL_ENABLED',
  kiosk: 'LOBBY_KIOSK_ENABLED',
};

/** A lobby feature that is switched off in this deployment must not be promised to players. */
export function filterKnowledgeByFlags(
  entries: KnowledgeEntry[],
  get: (name: string) => string | undefined,
): KnowledgeEntry[] {
  const on = (k: KnowledgeFlag) => (get(FLAG_ENV[k]) ?? '').trim() === 'true';
  return entries.filter((e) => {
    if (!e.when) return true;
    // The ball needs movement, exactly as the lobby itself does.
    return e.when === 'ball' ? on('movement') && on('ball') : on(e.when);
  });
}
