import {
  LOBBY_IDLE_MS,
  LOBBY_MOVE_RATE,
  LOBBY_SWEEP_MS,
  LobbyWorldService,
} from './lobby-world.service';
import {
  LOBBY_MAX_SPEED,
  LOBBY_WALK_RADIUS,
  parseLobbyMove,
  type LobbyMove,
} from './lobby-move.util';

function move(
  over: Partial<LobbyMove> & Record<string, unknown> = {},
): LobbyMove {
  const parsed = parseLobbyMove({
    squadId: 's1',
    seq: 1,
    x: 0,
    z: 0,
    vx: 0,
    vz: 0,
    h: 0,
    m: 1,
    ...over,
  });
  if (!parsed) throw new Error('invalid test move');
  return parsed;
}

describe('LobbyWorldService', () => {
  let world: LobbyWorldService;
  const T0 = 1_000_000;

  beforeEach(() => {
    world = new LobbyWorldService();
  });
  afterEach(() => world.onModuleDestroy());

  describe('validation (parseLobbyMove)', () => {
    it('clamps positions to the walkable disc', () => {
      const m = move({ x: 30, z: 0 });
      expect(m.x).toBe(LOBBY_WALK_RADIUS);
      expect(m.z).toBe(0);
      const d = move({ x: 10, z: 10 });
      expect(Math.hypot(d.x, d.z)).toBeLessThanOrEqual(
        LOBBY_WALK_RADIUS + 0.01,
      );
    });

    it('clamps speed to 4.6 u/s and zeroes velocity on a stop', () => {
      const m = move({ vx: 30, vz: 40 });
      expect(Math.hypot(m.vx, m.vz)).toBeCloseTo(LOBBY_MAX_SPEED, 1);
      const stop = move({ vx: 2, vz: 2, m: 0 });
      expect([stop.vx, stop.vz]).toEqual([0, 0]);
    });

    it('rejects non-finite numbers, bad modes and bad ids', () => {
      const base = {
        squadId: 's1',
        seq: 1,
        x: 0,
        z: 0,
        vx: 0,
        vz: 0,
        h: 0,
        m: 1,
      };
      expect(parseLobbyMove({ ...base, x: NaN })).toBeNull();
      expect(parseLobbyMove({ ...base, z: Infinity })).toBeNull();
      expect(parseLobbyMove({ ...base, vx: '1' })).toBeNull();
      expect(parseLobbyMove({ ...base, m: 4 })).toBeNull();
      expect(parseLobbyMove({ ...base, squadId: '' })).toBeNull();
      expect(parseLobbyMove({ ...base, squadId: 'x'.repeat(65) })).toBeNull();
      expect(parseLobbyMove(null)).toBeNull();
      expect(parseLobbyMove('move')).toBeNull();
    });

    it('rounds to the wire format and wraps the heading', () => {
      const m = move({
        x: 1.23456,
        z: -2.34567,
        h: Math.PI * 3,
        tx: 1.111,
        tz: 2.229,
      });
      expect([m.x, m.z]).toEqual([1.23, -2.35]);
      expect(m.h).toBeCloseTo(Math.PI, 2);
      expect([m.tx, m.tz]).toEqual([1.11, 2.23]);
    });
  });

  describe('acceptMove', () => {
    it('stores and relays a legal move with the server timestamp', () => {
      const res = world.acceptMove(
        move({ x: 1, z: 1, vx: 2, m: 1 }),
        'u1',
        'sock',
        T0,
      );
      expect(res?.moved).toEqual(
        jasmineLike({
          type: 'lobby.moved',
          squadId: 's1',
          userId: 'u1',
          x: 1,
          z: 1,
          vx: 2,
          st: T0,
        }),
      );
      expect(res?.reliable).toBe(false);
      expect(res?.correction).toBeNull();
    });

    it('marks stops reliable (non-volatile)', () => {
      const res = world.acceptMove(move({ m: 0 }), 'u1', 'sock', T0);
      expect(res?.reliable).toBe(true);
    });

    it('corrects a teleport to the farthest legal point and sends it reliably', () => {
      world.acceptMove(move({ seq: 1, x: 0, z: 0 }), 'u1', 'sock', T0);
      // 100 ms later: legal travel ≈ 4.6 × 1.5 × 0.1 + what is left of the 7.4 u budget.
      world.acceptMove(move({ seq: 2, x: 7, z: 0 }), 'u1', 'sock', T0 + 100); // spends the burst budget
      const res = world.acceptMove(
        move({ seq: 3, x: -7, z: 0 }),
        'u1',
        'sock',
        T0 + 200,
      );
      expect(res?.correction).not.toBeNull();
      expect(res?.reliable).toBe(true);
      // Pulled back towards the previous point: 0.4 u of budget was left plus
      // 0.69 u earned in 100 ms, so it may only get 1.09 u away from x = 7.
      expect(res!.moved.x).toBeCloseTo(7 - 1.09, 1);
      expect(res!.moved.x).toEqual(res!.correction!.x);
    });

    it('accepts ordinary running without corrections, including bunched arrivals', () => {
      let x = -6;
      let t = T0;
      world.acceptMove(move({ seq: 0, x, z: 0 }), 'u1', 'sock', t);
      for (let seq = 1; seq <= 30; seq++) {
        x += 0.4; // 4 u/s at 10 Hz
        // Every third message arrives late, then two more arrive at the same instant.
        t += seq % 3 === 0 ? 300 : 0;
        const res = world.acceptMove(
          move({ seq, x, z: 0, vx: 4, m: 2 }),
          'u1',
          'sock',
          t,
        );
        expect(res?.correction).toBeNull();
      }
    });

    it('drops stale or duplicate sequence numbers from the same socket, but not from a new one', () => {
      world.acceptMove(move({ seq: 5 }), 'u1', 'sock', T0);
      expect(
        world.acceptMove(move({ seq: 5 }), 'u1', 'sock', T0 + 50),
      ).toBeNull();
      expect(
        world.acceptMove(move({ seq: 4 }), 'u1', 'sock', T0 + 60),
      ).toBeNull();
      expect(
        world.acceptMove(move({ seq: 0 }), 'u1', 'other-sock', T0 + 70),
      ).not.toBeNull();
    });

    it('handles uint32 sequence wraparound', () => {
      world.acceptMove(move({ seq: 0xffffffff }), 'u1', 'sock', T0);
      expect(
        world.acceptMove(move({ seq: 0 }), 'u1', 'sock', T0 + 100),
      ).not.toBeNull();
    });
  });

  describe('rate limiter', () => {
    it('allows a burst of 15 then drops, and refills over time', () => {
      let ok = 0;
      for (let i = 1; i <= 20; i++) {
        if (world.acceptMove(move({ seq: i }), 'u1', 'sock', T0)) ok++;
      }
      expect(ok).toBe(LOBBY_MOVE_RATE);
      // 200 ms later: 3 tokens back.
      let later = 0;
      for (let i = 21; i <= 30; i++) {
        if (world.acceptMove(move({ seq: i }), 'u1', 'sock', T0 + 200)) later++;
      }
      expect(later).toBe(3);
    });

    it('is per user, shared across that user’s sockets', () => {
      for (let i = 1; i <= 15; i++)
        world.acceptMove(move({ seq: i }), 'u1', 'a', T0);
      expect(world.acceptMove(move({ seq: 1 }), 'u1', 'b', T0)).toBeNull();
      expect(world.acceptMove(move({ seq: 1 }), 'u2', 'c', T0)).not.toBeNull();
    });
  });

  describe('snapshot and cleanup', () => {
    it('snapshots every member’s last state for one squad only', () => {
      world.acceptMove(
        move({ x: 1, z: 2, h: 0.5, vx: 1, m: 1 }),
        'u1',
        'a',
        T0,
      );
      world.acceptMove(move({ x: -1, z: 0, m: 0 }), 'u2', 'b', T0);
      world.acceptMove(move({ squadId: 's2', x: 3 }), 'u3', 'c', T0);
      const snap = world.snapshot('s1', T0 + 5);
      expect(snap.type).toBe('lobby.snapshot');
      expect(snap.st).toBe(T0 + 5);
      expect(snap.members).toEqual([
        { userId: 'u1', x: 1, z: 2, h: 0.5, m: 1, vx: 1, vz: 0 },
        { userId: 'u2', x: -1, z: 0, h: 0, m: 0, vx: 0, vz: 0 },
      ]);
      expect(world.snapshot('nope', T0).members).toEqual([]);
    });

    it('drops a member on leave/kick and the squad when it empties', () => {
      world.acceptMove(move(), 'u1', 'a', T0);
      world.acceptMove(move(), 'u2', 'b', T0);
      world.memberLeft('s1', 'u1');
      expect(world.snapshot('s1', T0).members.map((m) => m.userId)).toEqual([
        'u2',
      ]);
      world.memberLeft('s1', 'u2');
      expect((world as any).squads.has('s1')).toBe(false);
      world.acceptMove(move(), 'u1', 'a', T0 + 1000);
      world.squadEmptied('s1');
      expect(world.snapshot('s1', T0).members).toEqual([]);
    });

    it('keeps its sweep timer unref’d so it never holds the process open', () => {
      world.acceptMove(move(), 'u1', 'a', T0);
      const timer = (world as any).sweepTimer as NodeJS.Timeout;
      expect(timer).not.toBeNull();
      expect(timer.hasRef()).toBe(false);
    });

    it('sweeps members idle for more than 10 minutes, then stops its timer', () => {
      jest.useFakeTimers({ now: T0 });
      try {
        world.acceptMove(move(), 'u1', 'a', T0);
        world.acceptMove(move(), 'u2', 'b', T0 + LOBBY_IDLE_MS - 1000);
        world.sweep(T0 + LOBBY_IDLE_MS + 1);
        expect(world.snapshot('s1', 0).members.map((m) => m.userId)).toEqual([
          'u2',
        ]);
        world.sweep(T0 + 2 * LOBBY_IDLE_MS + LOBBY_SWEEP_MS);
        expect(world.snapshot('s1', 0).members).toEqual([]);
        // Nothing left to sweep: the timer stops itself.
        expect((world as any).sweepTimer).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    it('runs the sweep from its own timer every minute', () => {
      jest.useFakeTimers({ now: T0 });
      try {
        world.acceptMove(move(), 'u1', 'a', Date.now());
        jest.setSystemTime(T0 + LOBBY_IDLE_MS + 1);
        jest.advanceTimersByTime(LOBBY_SWEEP_MS);
        expect(world.snapshot('s1', 0).members).toEqual([]);
      } finally {
        jest.useRealTimers();
      }
    });
  });
});

/** Partial object match that reads like the payload. */
function jasmineLike<T extends object>(o: T) {
  return expect.objectContaining(o);
}
