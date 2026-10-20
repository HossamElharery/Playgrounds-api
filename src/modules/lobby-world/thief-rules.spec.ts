import { parseLobbyMove } from './lobby-move.util';
import { LobbyWorldService, type BallSink } from './lobby-world.service';
import {
  DODGE_COOLDOWN_MS,
  DODGE_MS,
  KICKOFF_SPOT,
  MISS_COOLDOWN_MS,
  STEAL_IMMUNITY_MS,
  THIEF_GATHER_MS,
  THIEF_GOLDEN_MS,
  THIEF_KICKOFF_MS,
  THIEF_PLAY_MS,
  THIEF_RESULT_MS,
  VICTIM_STUN_MS,
  beginKickoff,
  beginPlay,
  createThief,
  dodge,
  finishThief,
  joinThief,
  leaveThief,
  tackle,
  tickThief,
  type ThiefPos,
  type ThiefView,
} from './thief-rules';

const T0 = 1_790_000_000_000;
const SQUAD = '0ebf99c6-c133-4038-ae21-845eaa0c7d61';

function playing(ids: string[]) {
  const s = createThief(SQUAD, ids[0], T0);
  for (const id of ids.slice(1)) joinThief(s, id);
  beginKickoff(s, T0);
  beginPlay(s, T0 + THIEF_KICKOFF_MS);
  return s;
}

describe('thief rules', () => {
  const at: Record<string, ThiefPos> = {};
  const pos = (id: string) => at[id] ?? null;
  beforeEach(() => {
    for (const k of Object.keys(at)) delete at[k];
  });

  it('needs two players for the kickoff', () => {
    const s = createThief(SQUAD, 'a', T0);
    expect(s.phaseUntil).toBe(T0 + THIEF_GATHER_MS);
    expect(beginKickoff(s, T0 + 1)).toBe(false);
    expect(s.cancelled).toBe(true);
  });

  it('the first player to reach the loose ball takes it, then banks time', () => {
    const s = playing(['a', 'b']);
    const t = s.lastTickAt;
    at.a = { x: KICKOFF_SPOT.x + 3, z: 0 };
    at.b = { x: KICKOFF_SPOT.x + 0.5, z: KICKOFF_SPOT.z };
    tickThief(s, pos, t + 100);
    expect(s.holderId).toBe('b');
    expect(s.event?.kind).toBe('grab');
    at.b = { x: 2, z: 2 };
    tickThief(s, pos, t + 1100);
    expect(s.heldMs.b).toBe(1000);
    expect(s.ball).toEqual({ x: 2, z: 2 });
  });

  it('the golden stretch counts double, from exactly its first millisecond', () => {
    const s = playing(['a', 'b']);
    at.a = { ...KICKOFF_SPOT };
    tickThief(s, pos, s.lastTickAt + 10);
    const line = s.playUntil - THIEF_GOLDEN_MS;
    s.lastTickAt = line - 500;
    s.heldMs.a = 0;
    tickThief(s, pos, line + 500);
    expect(s.heldMs.a).toBe(500 + 1000);
    expect(s.event?.kind).toBe('golden');
  });

  it('a tackle in reach steals; out of reach or on a fresh thief it misses and costs a cooldown', () => {
    const s = playing(['a', 'b', 'c']);
    at.a = { ...KICKOFF_SPOT };
    at.b = { x: 5, z: 5 };
    at.c = { x: -5, z: 5 };
    tickThief(s, pos, s.lastTickAt + 10);
    const t = s.holdSince;
    expect(s.holderId).toBe('a');
    at.b = { x: at.a.x + 1, z: at.a.z };
    expect(tackle(s, 'b', pos, t + 100)).toBe('miss'); // immune right after the grab
    expect(tackle(s, 'b', pos, t + STEAL_IMMUNITY_MS + 10)).toBe('invalid'); // still cooling down
    const later = t + MISS_COOLDOWN_MS + 200;
    expect(tackle(s, 'c', pos, later)).toBe('miss'); // too far
    expect(tackle(s, 'b', pos, later)).toBe('steal');
    expect(s.holderId).toBe('b');
    expect(s.steals.b).toBe(1);
    // The victim is stunned, the new thief immune.
    at.a = { x: at.b.x + 0.5, z: at.b.z };
    expect(tackle(s, 'a', pos, later + VICTIM_STUN_MS - 100)).toBe('invalid');
    expect(tackle(s, 'a', pos, later + VICTIM_STUN_MS + 50)).toBe('miss');
    expect(tackle(s, 'b', pos, later + 5000)).toBe('invalid'); // the holder cannot tackle
  });

  it('a dodge beats tackles for a moment, then needs to recharge', () => {
    const s = playing(['a', 'b']);
    at.a = { ...KICKOFF_SPOT };
    tickThief(s, pos, s.lastTickAt + 10);
    const t = s.holdSince + STEAL_IMMUNITY_MS + 100;
    at.b = { x: at.a.x + 0.8, z: at.a.z };
    expect(dodge(s, 'b', t)).toBe(false);
    expect(dodge(s, 'a', t)).toBe(true);
    expect(tackle(s, 'b', pos, t + DODGE_MS - 50)).toBe('dodged');
    expect(dodge(s, 'a', t + DODGE_MS + 10)).toBe(false);
    expect(dodge(s, 'a', t + DODGE_COOLDOWN_MS)).toBe(true);
  });

  it('the holder leaving drops the ball where they stood; too few players ends the game', () => {
    const s = playing(['a', 'b', 'c']);
    at.a = { ...KICKOFF_SPOT };
    tickThief(s, pos, s.lastTickAt + 10);
    at.a = { x: 3, z: -2 };
    expect(leaveThief(s, 'a', pos, s.lastTickAt + 500)).toBe(true);
    expect(s.holderId).toBeNull();
    expect(s.ball).toEqual({ x: 3, z: -2 });
    expect(leaveThief(s, 'b', pos, s.lastTickAt + 600)).toBe(false);
    expect(s.phase).toBe('ended');
    expect(s.cancelled).toBe(false);
  });

  it('the result names the winner, the best stealer and the longest hold', () => {
    const s = playing(['a', 'b', 'c']);
    s.heldMs = { a: 30000, b: 45000, c: 45000 };
    s.steals = { a: 4, b: 1, c: 0 };
    s.longestMs = { a: 9000, b: 21000, c: 12000 };
    finishThief(s, T0 + THIEF_PLAY_MS);
    expect(s.result).toEqual({
      winners: ['b', 'c'],
      topStealer: 'a',
      longestId: 'b',
      longestMs: 21000,
    });
    expect(s.phaseUntil).toBe(T0 + THIEF_PLAY_MS + THIEF_RESULT_MS);
  });
});

describe('thief in the lobby service', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
  });
  afterEach(() => jest.useRealTimers());

  it('runs a game on the lobby ball: no kicks while carried, the ball drops at the whistle', () => {
    const world = new LobbyWorldService();
    const out: { event: string; payload: unknown }[] = [];
    const sink: BallSink = {
      toRoom: (_s, event, payload) => out.push({ event, payload }),
    };
    world.attachBallSink(sink);
    const seqs = new Map<string, number>();
    const move = (userId: string, x: number, z: number) => {
      const seq = (seqs.get(userId) ?? 0) + 1;
      seqs.set(userId, seq);
      return world.acceptMove(
        parseLobbyMove({
          squadId: SQUAD,
          seq,
          x,
          z,
          vx: 0,
          vz: 0,
          h: 0,
          m: 0,
        })!,
        userId,
        'sock-' + userId,
        Date.now(),
      );
    };
    const states = () =>
      out
        .filter((o) => o.event === 'lobby.thief.state')
        .map((o) => o.payload as ThiefView);
    const last = () => states().at(-1)!;
    move('a', KICKOFF_SPOT.x, KICKOFF_SPOT.z + 3);
    move('b', 3, 3);
    world.snapshot(SQUAD, Date.now(), true);
    expect(world.startThief(SQUAD, 'a', Date.now())?.phase).toBe('gathering');
    expect(world.startDakhla(SQUAD, 'b', 'nafas', 1, Date.now())).toBeNull();
    expect(world.startPenalty(SQUAD, 'b', Date.now())).toBeNull();
    world.joinThief(SQUAD, 'b', Date.now());
    world.goThief(SQUAD, 'a', Date.now());
    expect(last().phase).toBe('kickoff');
    expect(out.some((o) => o.event === 'lobby.ball.reset')).toBe(true);
    expect(
      world.kick(
        { squadId: SQUAD, seq: 1, dirX: 0, dirZ: -1, power: 0.5 },
        'a',
        Date.now(),
      ),
    ).toBe(false);
    jest.advanceTimersByTime(THIEF_KICKOFF_MS + 150);
    expect(last().phase).toBe('playing');
    jest.advanceTimersByTime(500);
    move('a', KICKOFF_SPOT.x, KICKOFF_SPOT.z + 2);
    jest.advanceTimersByTime(500);
    move('a', KICKOFF_SPOT.x, KICKOFF_SPOT.z + 1);
    jest.advanceTimersByTime(500);
    move('a', KICKOFF_SPOT.x, KICKOFF_SPOT.z + 0.3);
    jest.advanceTimersByTime(300);
    expect(last().holderId).toBe('a');
    jest.advanceTimersByTime(THIEF_PLAY_MS);
    expect(last().phase).toBe('ended');
    expect(last().result?.winners).toEqual(['a']);
    expect(last().heldMs.a).toBeGreaterThan(THIEF_PLAY_MS - 5000);
    const resets = out.filter((o) => o.event === 'lobby.ball.reset');
    expect(resets.length).toBeGreaterThanOrEqual(2);
    jest.advanceTimersByTime(THIEF_RESULT_MS + 200);
    expect(world.snapshot(SQUAD, Date.now(), true).thief).toBeUndefined();
    world.onModuleDestroy();
  });
});
