import { GOAL_LINE_Z } from './ball-sim';
import { parseLobbyMove } from './lobby-move.util';
import { LobbyWorldService, type BallSink } from './lobby-world.service';
import {
  AIM_MS,
  KEEPER_BOX,
  KEEPER_SPOT,
  PENALTY_SPOT,
  RESULT_MS,
  SETUP_MS,
  SHOOTER_SPOT,
  ENDED_MS,
  type PenaltyView,
} from './penalty-rules';

const T0 = 1_790_000_000_000;
const SQUAD = '0ebf99c6-c133-4038-ae21-845eaa0c7d61';

function setup() {
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
    const m = parseLobbyMove({
      squadId: SQUAD,
      seq,
      x,
      z,
      vx: 0,
      vz: 0,
      h: 0,
      m: 0,
    })!;
    return world.acceptMove(m, userId, `sock-${userId}`, Date.now());
  };
  /** Walks in legal steps (the travel budget refills over time). */
  const walk = (userId: string, x: number, z: number) => {
    for (let i = 0; i < 12; i++) {
      jest.advanceTimersByTime(400);
      const r = move(userId, x, z);
      if (r && !r.correction) return r;
    }
    return move(userId, x, z);
  };
  const states = (): PenaltyView[] =>
    out
      .filter((o) => o.event === 'lobby.pen.state')
      .map((o) => o.payload as PenaltyView);
  const last = (): PenaltyView => states().at(-1)!;
  const kick = (userId: string, dirX = 0, dirZ = -1, power = 0.8) =>
    world.kick(
      { squadId: SQUAD, seq: 1, dirX, dirZ, power },
      userId,
      Date.now(),
    );
  /** Two players in the lobby, ball created, shootout started by a. */
  const start = (players = ['a', 'b']) => {
    players.forEach((id, i) => move(id, i * 0.9, 1));
    world.snapshot(SQUAD, Date.now(), true);
    const invite = world.startPenalty(SQUAD, players[0], Date.now());
    if (!invite) return null;
    for (const id of players.slice(1)) world.joinPenalty(SQUAD, id, Date.now());
    return last();
  };
  const toSpots = (shooter: string, keeper: string) => {
    walk(shooter, SHOOTER_SPOT.x, SHOOTER_SPOT.z);
    walk(keeper, KEEPER_SPOT.x, KEEPER_SPOT.z);
    jest.advanceTimersByTime(300); // a penalty tick
  };
  return { world, out, move, walk, states, last, kick, start, toSpots };
}

describe('LobbyWorldService — penalty shootout', () => {
  beforeEach(() => jest.useFakeTimers({ now: T0 }));
  afterEach(() => jest.useRealTimers());

  it('invites players without moving the ball, and cancels if nobody joins', () => {
    const { world, move, last } = setup();
    move('a', 0, 1);
    move('b', 0.9, 1);
    world.snapshot(SQUAD, Date.now(), true);
    const before = world.ballState(SQUAD)!;
    expect(world.startPenalty(SQUAD, 'a', Date.now())?.phase).toBe('gathering');
    const during = world.ballState(SQUAD)!;
    expect([during.x, during.z]).toEqual([before.x, before.z]);
    expect(world.declinePenalty(SQUAD, 'b', Date.now())).toBe(true);
    expect(last().phase).toBe('ended');
    expect(last().cancelled).toBe(true);
    world.onModuleDestroy();
  });

  it('assigns sidelines to waiting players and corrects entry into the penalty area', () => {
    const { world, start, toSpots, move, last } = setup();
    start(['a', 'b', 'c']);
    expect(last().spectatorSpots?.c).toEqual({ x: -3.5, z: -0.3 });
    toSpots('a', 'b');
    const correction = move('c', 0, PENALTY_SPOT.z);
    expect(correction?.correction?.x).toBe(-2.2);
    world.onModuleDestroy();
  });

  it('validates keeper dive once and keeps its arc authoritative against movement packets', () => {
    const { world, start, toSpots, move, kick, last } = setup();
    start();
    toSpots('a', 'b');
    const now = Date.now();
    expect(world.divePenalty(SQUAD, 'a', -1, now)).toBe(false);
    expect(world.divePenalty(SQUAD, 'b', -1, now)).toBe(true);
    expect(world.divePenalty(SQUAD, 'b', 1, now)).toBe(false);
    jest.advanceTimersByTime(250);
    const corrected = move('b', 1.5, KEEPER_SPOT.z);
    expect(corrected?.correction?.x).toBeLessThan(0);
    expect(last().dive?.dir).toBe(-1);
    expect(kick('a', 0.18, -0.984, 0.7)).toBe(true);
    jest.advanceTimersByTime(1600);
    expect(last().lastOutcome).toBe('goal'); // the shot went opposite the dive
    world.onModuleDestroy();
  });

  it('needs two players in the lobby world; the ball goes to the spot', () => {
    const { world, move, start } = setup();
    move('a', 0, 1);
    world.snapshot(SQUAD, Date.now(), true);
    expect(world.startPenalty(SQUAD, 'a', Date.now())).toBeNull();
    const view = start(['a', 'b']);
    expect(view).toEqual(
      expect.objectContaining({
        phase: 'setup',
        shooterId: 'a',
        keeperId: 'b',
        order: ['a', 'b'],
      }),
    );
    const b = world.ballState(SQUAD)!;
    expect([b.x, b.z]).toEqual([PENALTY_SPOT.x, PENALTY_SPOT.z]);
    expect(world.startPenalty(SQUAD, 'b', Date.now())).toBeNull(); // one at a time
    world.onModuleDestroy();
  });

  it('the kick phase starts when both are on their spots (or after the setup time)', () => {
    const { world, start, toSpots, last } = setup();
    start();
    toSpots('a', 'b');
    expect(last().phase).toBe('aim');
    world.onModuleDestroy();

    const other = setup();
    other.start();
    jest.advanceTimersByTime(SETUP_MS + 300);
    expect(other.last().phase).toBe('aim');
    other.world.onModuleDestroy();
  });

  it('only the shooter kicks, once, and only in the kick phase; onlookers never touch the ball', () => {
    const { world, start, toSpots, kick, walk, last } = setup();
    start(['a', 'b', 'c']);
    walk('c', 0, PENALTY_SPOT.z - 1); // an onlooker in the shot's path
    expect(kick('a')).toBe(false); // still walking to the spot
    toSpots('a', 'b');
    walk('b', 1.4, KEEPER_SPOT.z); // the keeper guesses right… the shot goes left
    walk('a', 0, PENALTY_SPOT.z + 0.6);
    expect(kick('b')).toBe(false); // the keeper
    expect(kick('a')).toBe(true);
    expect(last().phase).toBe('flight');
    jest.advanceTimersByTime(300);
    expect(kick('a')).toBe(false); // one kick per turn
    // c stood in the way, but the ball went through: a goal.
    jest.advanceTimersByTime(2000);
    expect(last()).toEqual(
      expect.objectContaining({
        phase: 'result',
        lastOutcome: 'goal',
        lastShooterId: 'a',
      }),
    );
    expect(last().goals).toEqual({ a: 1, b: 0, c: 0 });
    world.onModuleDestroy();
  });

  it('the keeper stays on the line during the kick (positions are clamped and corrected)', () => {
    const { world, start, toSpots, move, walk } = setup();
    start();
    toSpots('a', 'b');
    jest.advanceTimersByTime(500);
    const res = move('b', 0.2, KEEPER_BOX.maxZ + 0.8);
    expect(res?.correction).toEqual({
      x: 0.2,
      z: Math.round(KEEPER_BOX.maxZ * 100) / 100,
    });
    walk('b', 0.4, KEEPER_SPOT.z);
    world.onModuleDestroy();
  });

  it('a shot the keeper blocks is a save; a shot wide is a miss; no kick in time is a timeout', () => {
    const { world, start, toSpots, kick, walk, last } = setup();
    start();
    toSpots('a', 'b');
    walk('a', 0, PENALTY_SPOT.z + 0.6);
    kick('a', 0, -1, 0.5); // straight at the keeper standing in the middle
    jest.advanceTimersByTime(3600);
    expect(last().lastOutcome).toBe('saved');

    jest.advanceTimersByTime(RESULT_MS + 300); // b shoots, a keeps
    expect(last()).toEqual(
      expect.objectContaining({
        phase: 'setup',
        shooterId: 'b',
        keeperId: 'a',
      }),
    );
    toSpots('b', 'a');
    walk('a', -1.2, KEEPER_SPOT.z); // the keeper dives the wrong way
    walk('b', 0, PENALTY_SPOT.z + 0.6);
    const dx = 3.5;
    const dz = GOAL_LINE_Z - PENALTY_SPOT.z;
    const len = Math.hypot(dx, dz);
    expect(kick('b', dx / len, dz / len, 0.9)).toBe(true); // far wide of the post
    jest.advanceTimersByTime(3600);
    expect(last().lastOutcome).toBe('missed');

    jest.advanceTimersByTime(RESULT_MS + 300);
    toSpots('a', 'b');
    jest.advanceTimersByTime(AIM_MS + 300);
    expect(last().lastOutcome).toBe('timeout');
    world.onModuleDestroy();
  });

  it('cancel by a player ends it; afterwards the ball returns to free play', () => {
    const { world, start, last, out } = setup();
    start();
    expect(world.cancelPenalty(SQUAD, 'z', Date.now())).toBe(false); // not in it
    expect(world.cancelPenalty(SQUAD, 'b', Date.now())).toBe(true);
    expect(last()).toEqual(
      expect.objectContaining({ phase: 'ended', cancelled: true, winners: [] }),
    );
    jest.advanceTimersByTime(ENDED_MS + 300);
    expect(world.penalty(SQUAD)).toBeNull();
    const reset = out
      .filter((o) => o.event === 'lobby.ball.reset')
      .at(-1)!.payload as { b: number[] };
    expect([reset.b[0], reset.b[2]]).toEqual([0, 0]);
    world.onModuleDestroy();
  });

  it('a player who leaves is replaced in the pair; the last one standing ends it', () => {
    const { world, start, last } = setup();
    start(['a', 'b', 'c']);
    world.memberLeft(SQUAD, 'b');
    expect(last()).toEqual(
      expect.objectContaining({
        shooterId: 'a',
        keeperId: 'c',
        order: ['a', 'c'],
      }),
    );
    world.memberLeft(SQUAD, 'c');
    expect(last()).toEqual(
      expect.objectContaining({ phase: 'ended', cancelled: true }),
    );
    world.onModuleDestroy();
  });

  it('late joiners get the shootout in the snapshot', () => {
    const { world, start } = setup();
    start();
    const snap = world.snapshot(SQUAD, Date.now(), true);
    expect(snap.pen).toEqual(
      expect.objectContaining({ type: 'lobby.pen.state', shooterId: 'a' }),
    );
    world.onModuleDestroy();
  });
});
