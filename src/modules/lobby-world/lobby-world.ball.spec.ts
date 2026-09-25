import { writeFileSync } from 'node:fs';
import { BALL_RADIUS, GOAL_LINE_Z, ballResting } from './ball-sim';
import { parseLobbyKick, parseLobbyMove } from './lobby-move.util';
import {
  BALL_TICK_HZ,
  GOAL_FREEZE_MS,
  KICK_COOLDOWN_MS,
  LOBBY_IDLE_MS,
  LOBBY_SWEEP_MS,
  LobbyWorldService,
  type BallSink,
  type KickInput,
} from './lobby-world.service';

type Out = {
  squadId: string;
  event: string;
  payload: any;
  volatile: boolean;
  at: number;
};

const T0 = 1_790_000_000_000;
const SQUAD = '0ebf99c6-c133-4038-ae21-845eaa0c7d61';

function setup() {
  const world = new LobbyWorldService();
  const out: Out[] = [];
  const sink: BallSink = {
    toRoom: (squadId, event, payload, volatile) =>
      out.push({ squadId, event, payload, volatile, at: Date.now() }),
  };
  world.attachBallSink(sink);
  const seqs = new Map<string, number>();
  /** Put a member at (x, z) through the normal validated move path. */
  const place = (
    userId: string,
    x: number,
    z: number,
    opts: {
      vx?: number;
      vz?: number;
      m?: 0 | 1 | 2 | 3;
      squadId?: string;
    } = {},
  ) => {
    const seq = (seqs.get(userId) ?? 0) + 1;
    seqs.set(userId, seq);
    const m = opts.m ?? 0;
    const move = parseLobbyMove({
      squadId: opts.squadId ?? SQUAD,
      seq,
      x,
      z,
      vx: opts.vx ?? 0,
      vz: opts.vz ?? 0,
      h: 0,
      m,
    });
    if (!move) throw new Error('invalid test move');
    return world.acceptMove(move, userId, `sock-${userId}`, Date.now());
  };
  const kick = (
    userId: string,
    over: Partial<KickInput> = {},
    now = Date.now(),
  ): boolean =>
    world.kick(
      { squadId: SQUAD, seq: 1, dirX: 0, dirZ: -1, power: 0.3, ...over },
      userId,
      now,
    );
  const events = (name: string) => out.filter((o) => o.event === name);
  /** The ball, created as on the first lobby join with the flag on. */
  const ball = () => {
    world.snapshot(SQUAD, Date.now(), true);
    return world.ballState(SQUAD)!;
  };
  return { world, out, place, kick, events, ball };
}

describe('LobbyWorldService — ball (Stage 2)', () => {
  beforeEach(() => jest.useFakeTimers({ now: T0 }));
  afterEach(() => jest.useRealTimers());

  describe('snapshot', () => {
    it('has no ball while the ball flag is off, and creates none', () => {
      const { world } = setup();
      const snap = world.snapshot(SQUAD, T0);
      expect(snap.ball).toBeUndefined();
      expect(snap.score).toBeUndefined();
      expect(world.hasBall(SQUAD)).toBe(false);
    });

    it('creates the ball lazily at the centre and reports it with the score', () => {
      const { world } = setup();
      const snap = world.snapshot(SQUAD, T0, true);
      expect(snap.ball).toEqual({
        x: 0,
        y: BALL_RADIUS,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        moving: false,
      });
      expect(snap.score).toEqual({ total: 0, byUser: {} });
      expect(world.ballTicking).toBe(false); // a resting ball costs nothing
      world.onModuleDestroy();
    });
  });

  describe('kick validation', () => {
    it('refuses a kick before the squad has a ball', () => {
      const { world, place, kick } = setup();
      place('a', 0, 0.5);
      expect(kick('a')).toBe(false);
      world.onModuleDestroy();
    });

    it('refuses a member the server has no position for (never moved or announced)', () => {
      const { world, ball, kick } = setup();
      ball();
      expect(kick('ghost')).toBe(false);
      world.onModuleDestroy();
    });

    it('measures reach from the server position (≤ 1.3 u), not from the client', () => {
      const { world, ball, place, kick } = setup();
      ball();
      place('a', 0, 1.35);
      expect(kick('a')).toBe(false);
      jest.advanceTimersByTime(200);
      place('a', 0, 1.25);
      expect(kick('a')).toBe(true);
      world.onModuleDestroy();
    });

    it('allows one kick per 250 ms per user', () => {
      const { world, ball, place, kick } = setup();
      const b = ball();
      place('a', 0, 0.6);
      expect(kick('a', { dirZ: 1, power: 0 })).toBe(true);
      // Put the ball back at the kicker's feet: only the cooldown can refuse now.
      b.x = 0;
      b.z = 0.6;
      jest.setSystemTime(T0 + KICK_COOLDOWN_MS - 1);
      expect(kick('a', { dirZ: 1, power: 0 })).toBe(false);
      jest.setSystemTime(T0 + KICK_COOLDOWN_MS);
      expect(kick('a', { dirZ: 1, power: 0 })).toBe(true);
      world.onModuleDestroy();
    });

    it('applies speed = 3 + 9 × power along the normalized direction, and a chip above 0.85', () => {
      const { world, ball, place, kick } = setup();
      const b = ball();
      place('a', 0, 0.5);
      expect(kick('a', { dirX: 0, dirZ: -1, power: 0.5 })).toBe(true);
      expect(Math.hypot(b.vx, b.vz)).toBeCloseTo(7.5, 6);
      expect(b.vz).toBeLessThan(0);
      expect(b.vy).toBe(0);
      jest.advanceTimersByTime(KICK_COOLDOWN_MS);
      b.x = 0;
      b.z = 0.5;
      b.y = BALL_RADIUS;
      expect(kick('a', { dirX: 0, dirZ: -1, power: 1 })).toBe(true);
      expect(b.vy).toBe(3);
      world.onModuleDestroy();
    });

    it('broadcasts the kick at once, non-volatile, with the kicker and their seq', () => {
      const { world, ball, place, kick, events } = setup();
      ball();
      place('a', 0, 0.5);
      kick('a', { seq: 42 });
      const [state] = events('lobby.ball.state');
      expect(state.volatile).toBe(false);
      expect(state.payload).toEqual(
        expect.objectContaining({ k: 'a', s: 42, m: 1, st: T0 }),
      );
      expect(state.payload.sq).toBe(SQUAD.slice(0, 8));
      expect(world.ballTicking).toBe(true);
      world.onModuleDestroy();
    });

    it('parseLobbyKick: normalizes the direction, clamps power, rejects junk', () => {
      const k = parseLobbyKick({
        squadId: 's1',
        seq: 3,
        dirX: 3,
        dirZ: 4,
        power: 7,
        px: 1e9,
        pz: -1e9,
      });
      expect(k).toEqual({
        squadId: 's1',
        seq: 3,
        dirX: 0.6,
        dirZ: 0.8,
        power: 1,
      });
      expect(
        parseLobbyKick({ squadId: 's1', seq: 1, dirX: 0, dirZ: 0, power: 1 }),
      ).toBeNull();
      expect(
        parseLobbyKick({ squadId: 's1', seq: 1, dirX: NaN, dirZ: 1, power: 1 }),
      ).toBeNull();
      expect(
        parseLobbyKick({ squadId: 's1', seq: 1, dirX: 1, dirZ: 0, power: '1' }),
      ).toBeNull();
      expect(
        parseLobbyKick({
          squadId: 'x'.repeat(65),
          seq: 1,
          dirX: 1,
          dirZ: 0,
          power: 1,
        }),
      ).toBeNull();
      expect(parseLobbyKick(null)).toBeNull();
      expect(
        parseLobbyKick({ squadId: 's1', seq: 1, dirX: 1, dirZ: 0, power: -2 })
          ?.power,
      ).toBe(0);
    });
  });

  describe('dribble (server-side, no client message)', () => {
    it('a walking member wakes a resting ball and pushes it ahead', () => {
      const { world, ball, place, events } = setup();
      const b = ball();
      expect(world.ballTicking).toBe(false);
      place('a', 0, -0.9, { vz: 2.2, m: 1 });
      expect(world.ballTicking).toBe(true);
      // Keep walking toward (and through) the ball for half a second.
      for (let i = 1; i <= 5; i++) {
        jest.advanceTimersByTime(100);
        place('a', 0, -0.9 + 0.22 * i, { vz: 2.2, m: 1 });
      }
      expect(b.z).toBeGreaterThan(0.05);
      expect(b.vz).toBeGreaterThan(0);
      expect(events('lobby.ball.state').length).toBeGreaterThan(0);
      world.onModuleDestroy();
    });

    it('credits the dribbler as the last toucher (a dribbled goal is theirs)', () => {
      const { world, ball, place, events } = setup();
      const b = ball();
      b.x = 0;
      b.z = GOAL_LINE_Z + 0.9;
      place('d', 0, GOAL_LINE_Z + 0.9 + 0.45, { vz: -4, m: 2 });
      for (let i = 1; i <= 15; i++) {
        jest.advanceTimersByTime(66);
        place(
          'd',
          0,
          Math.max(GOAL_LINE_Z + 0.2, GOAL_LINE_Z + 1.35 - 0.26 * i),
          {
            vz: -4,
            m: 2,
          },
        );
      }
      const [goal] = events('lobby.ball.goal');
      expect(goal?.payload.scorerId).toBe('d');
      world.onModuleDestroy();
    });

    it('a standing member does not wake the ball', () => {
      const { world, ball, place } = setup();
      ball();
      place('a', 0, -0.5, { m: 0 });
      expect(world.ballTicking).toBe(false);
      world.onModuleDestroy();
    });
  });

  describe('the shared 30 Hz interval', () => {
    it('broadcasts volatile states at 15 Hz while moving, one reliable state at rest, then sleeps', () => {
      const { world, ball, place, kick, out } = setup();
      const b = ball();
      place('a', 0, 0.5);
      kick('a', { dirX: 1, dirZ: 0, power: 0.2 });
      out.length = 0;
      jest.advanceTimersByTime(1000);
      const perSecond = out.filter(
        (o) => o.event === 'lobby.ball.state' && o.volatile,
      ).length;
      expect(perSecond).toBeGreaterThanOrEqual(14);
      expect(perSecond).toBeLessThanOrEqual(16);
      jest.advanceTimersByTime(10_000);
      expect(ballResting(b)).toBe(true);
      expect(world.ballTicking).toBe(false);
      const last = out[out.length - 1];
      expect(last.event).toBe('lobby.ball.state');
      expect(last.volatile).toBe(false);
      expect(last.payload.m).toBe(0);
      // Asleep: nothing more is sent, nothing is simulated.
      const sent = out.length;
      jest.advanceTimersByTime(30_000);
      expect(out.length).toBe(sent);
      expect(jest.getTimerCount()).toBe(1); // only the 1-min idle sweep
      world.onModuleDestroy();
    });

    it('wakes again on the next kick, and one interval serves every lobby', () => {
      const { world, ball, place, kick } = setup();
      ball();
      place('a', 0, 0.5);
      kick('a', { power: 0 });
      jest.advanceTimersByTime(10_000);
      expect(world.ballTicking).toBe(false);
      const b = world.ballState(SQUAD)!;
      place('a', b.x, b.z + 0.5);
      world.snapshot('other-squad', Date.now(), true);
      place('b', 0, 0.5, { squadId: 'other-squad' });
      const timersBefore = jest.getTimerCount();
      expect(kick('a', { power: 0 })).toBe(true);
      expect(
        world.kick(
          { squadId: 'other-squad', seq: 1, dirX: 1, dirZ: 0, power: 0 },
          'b',
          Date.now(),
        ),
      ).toBe(true);
      expect(world.activeBallCount).toBe(2);
      expect(jest.getTimerCount()).toBe(timersBefore + 1);
      world.onModuleDestroy();
    });

    it('keeps the in-motion payload ≤ 100 bytes', () => {
      const { world, ball, place, kick, out } = setup();
      const b = ball();
      b.x = -7.12;
      b.z = -3.45;
      place('a', -7.1, -2.8);
      kick('a', { dirX: -0.5, dirZ: -0.9, power: 1 });
      jest.advanceTimersByTime(300);
      const moving = out.filter((o) => o.volatile);
      expect(moving.length).toBeGreaterThan(0);
      for (const o of moving)
        expect(
          Buffer.byteLength(JSON.stringify(o.payload)),
        ).toBeLessThanOrEqual(100);
      world.onModuleDestroy();
    });
  });

  describe('goal → score → reset', () => {
    function shoot() {
      const t = setup();
      const b = t.ball();
      b.x = 0;
      b.z = -5;
      t.place('a', 0, -4.2);
      expect(t.kick('a', { dirX: 0, dirZ: -1, power: 0.6 })).toBe(true);
      return { ...t, b };
    }

    it('scores for the last toucher, freezes, and respawns at the centre after 2.5 s', () => {
      const { world, events, kick, b } = shoot();
      jest.advanceTimersByTime(1000);
      const goals = events('lobby.ball.goal');
      expect(goals).toHaveLength(1);
      expect(goals[0].volatile).toBe(false);
      expect(goals[0].payload).toEqual({
        type: 'lobby.ball.goal',
        squadId: SQUAD,
        scorerId: 'a',
        total: 1,
        byUser: { a: 1 },
      });
      // Frozen in the net: no kicks, no reset yet.
      expect(kick('a')).toBe(false);
      expect(b.z).toBeLessThan(GOAL_LINE_Z);
      expect(events('lobby.ball.reset')).toHaveLength(0);
      jest.advanceTimersByTime(GOAL_FREEZE_MS);
      const resets = events('lobby.ball.reset');
      expect(resets).toHaveLength(1);
      expect(resets[0].volatile).toBe(false);
      expect(resets[0].payload.b.slice(0, 3)).toEqual([0, 1.2, 0]);
      // The drop-bounce plays out and the ball settles on the spot.
      jest.advanceTimersByTime(5000);
      expect(ballResting(b)).toBe(true);
      expect([b.x, b.z]).toEqual([0, 0]);
      expect(world.ballTicking).toBe(false);
      expect(world.snapshot(SQUAD, Date.now(), true).score).toEqual({
        total: 1,
        byUser: { a: 1 },
      });
      world.onModuleDestroy();
    });

    it('the goal freeze is exactly GOAL_FREEZE_MS long', () => {
      const { world, events } = shoot();
      jest.advanceTimersByTime(1000);
      const [goal] = events('lobby.ball.goal');
      jest.advanceTimersByTime(GOAL_FREEZE_MS);
      const [reset] = events('lobby.ball.reset');
      expect(reset.at - goal.at).toBe(GOAL_FREEZE_MS);
      expect(reset.payload.st).toBe(reset.at);
      // No ball state is sent while it sits in the net.
      const frozen = events('lobby.ball.state').filter(
        (o) => o.at > goal.at && o.at < reset.at,
      );
      expect(frozen).toHaveLength(0);
      world.onModuleDestroy();
    });

    it('a keeper morph in the goal area saves with a 1.6× radius (easter egg)', () => {
      const run = (morph: string) => {
        const t = setup();
        const b = t.ball();
        b.x = 0.75;
        b.z = -5;
        t.place('k', 0, -6.7);
        t.world.setMorph('k', morph, true);
        t.place('a', 0.75, -4.3);
        expect(t.kick('a', { dirX: 0, dirZ: -1, power: 0.45 })).toBe(true);
        jest.advanceTimersByTime(1500);
        const goals = t.events('lobby.ball.goal').length;
        t.world.onModuleDestroy();
        return goals;
      };
      expect(run('classic')).toBe(1);
      expect(run('keeper')).toBe(0);
    });

    it('morph updates only touch users the lobby already knows', () => {
      const { world } = setup();
      world.setMorph('stranger', 'keeper');
      expect(world.hasMorph('stranger')).toBe(false);
      world.setMorph('member', 'classic', true);
      world.setMorph('member', 'keeper');
      expect(world.hasMorph('member')).toBe(true);
      world.onModuleDestroy();
    });
  });

  describe('cleanup', () => {
    it('drops the ball, the score and the timers when the squad empties', () => {
      const { world, ball, place, kick } = setup();
      ball();
      place('a', 0, 0.5);
      kick('a');
      expect(world.ballTicking).toBe(true);
      world.squadEmptied(SQUAD);
      expect(world.hasBall(SQUAD)).toBe(false);
      expect(world.ballTicking).toBe(false);
      expect(world.score(SQUAD)).toBeNull();
      // A fresh lobby starts from zero.
      expect(world.snapshot(SQUAD, Date.now(), true).score).toEqual({
        total: 0,
        byUser: {},
      });
      world.onModuleDestroy();
    });

    it('the last member leaving during the goal freeze cancels the reset', () => {
      const { world, ball, place, kick, events } = setup();
      const b = ball();
      b.z = -5;
      place('a', 0, -4.2);
      kick('a', { power: 0.6 });
      jest.advanceTimersByTime(1000);
      expect(events('lobby.ball.goal')).toHaveLength(1);
      world.memberLeft(SQUAD, 'a');
      expect(world.hasBall(SQUAD)).toBe(false);
      jest.advanceTimersByTime(GOAL_FREEZE_MS * 2);
      expect(events('lobby.ball.reset')).toHaveLength(0);
      expect(world.ballTicking).toBe(false);
      world.onModuleDestroy();
    });

    it('a member leaving mid-dribble stops pushing the ball', () => {
      const { world, ball, place } = setup();
      const b = ball();
      place('a', 0, -0.5, { vz: 2.2, m: 1 });
      place('b', 3, 3);
      world.memberLeft(SQUAD, 'a');
      jest.advanceTimersByTime(3000);
      expect(Math.hypot(b.x, b.z)).toBeLessThan(0.3);
      expect(world.ballTicking).toBe(false);
      world.onModuleDestroy();
    });

    it('sweeps a resting ball of a lobby nobody walks in any more', () => {
      const { world, ball } = setup();
      ball();
      world.setMorph('a', 'keeper', true);
      jest.advanceTimersByTime(LOBBY_IDLE_MS + LOBBY_SWEEP_MS);
      expect(world.hasBall(SQUAD)).toBe(false);
      expect(world.hasMorph('a')).toBe(false);
      expect(jest.getTimerCount()).toBe(0); // and the sweep stops itself
      world.onModuleDestroy();
    });
  });

  it('benchmark: 20 active lobbies, ≤ 0.2 ms per active ball per step', () => {
    jest.useRealTimers();
    const world = new LobbyWorldService();
    world.attachBallSink({ toRoom: () => undefined });
    const now0 = Date.now();
    const squads = Array.from({ length: 20 }, (_, i) => `bench-${i}`);
    const kickAll = (now: number) => {
      squads.forEach((sq, i) => {
        world.snapshot(sq, now, true);
        const b = world.ballState(sq)!;
        if (!ballResting(b)) return;
        // A fresh kicker at the ball each time (then gone), so the dribbling
        // walkers stay the only bodies on the floor.
        const u = `${sq}-kicker-${Math.round(now)}`;
        const m = parseLobbyMove({
          squadId: sq,
          seq: now,
          x: b.x,
          z: b.z + 0.4,
          vx: 0,
          vz: 0,
          h: 0,
          m: 0,
        })!;
        world.acceptMove(m, u, `s-${u}`, now);
        world.kick(
          {
            squadId: sq,
            seq: now,
            dirX: Math.cos(i),
            dirZ: Math.sin(i),
            power: 0.7,
          },
          u,
          now,
        );
        world.memberLeft(sq, u);
      });
    };
    // Six walking members per lobby (the ball collides with all of them).
    squads.forEach((sq) => {
      for (let p = 0; p < 6; p++) {
        const a = (p / 6) * Math.PI * 2;
        const m = parseLobbyMove({
          squadId: sq,
          seq: 1,
          x: Math.cos(a) * 3,
          z: Math.sin(a) * 3,
          vx: 1,
          vz: 1,
          h: 0,
          m: 1,
        })!;
        world.acceptMove(m, `${sq}-p${p}`, `s-${sq}-${p}`, now0);
      }
    });
    let now = now0;
    let steps = 0;
    let ns = 0n;
    for (let tick = 0; tick < 900; tick++) {
      now += 1000 / BALL_TICK_HZ;
      if (tick % 30 === 0) kickAll(now);
      const active = world.activeBallCount;
      const t = process.hrtime.bigint();
      world.tickBalls(now);
      const dt = process.hrtime.bigint() - t;
      if (tick >= 60) {
        ns += dt;
        steps += active;
      }
    }
    const msPerBallStep = Number(ns) / 1e6 / steps;
    if (process.env.LOBBY_BENCH_OUT)
      writeFileSync(
        process.env.LOBBY_BENCH_OUT,
        JSON.stringify(
          { lobbies: 20, membersPerLobby: 6, ballSteps: steps, msPerBallStep },
          null,
          1,
        ),
      );
    expect(steps).toBeGreaterThan(20 * 600);
    expect(msPerBallStep).toBeLessThanOrEqual(0.2);
    world.onModuleDestroy();
  });
});
