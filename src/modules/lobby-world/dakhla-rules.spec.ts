import { parseLobbyMove } from './lobby-move.util';
import { LobbyWorldService, type BallSink } from './lobby-world.service';
import {
  DAKHLA_CHANT_MS,
  DAKHLA_COUNTDOWN_MS,
  DAKHLA_GATHER_MS,
  DAKHLA_JOIN_UNTIL,
  DAKHLA_MAX_PLAYERS,
  DAKHLA_REPORT_MIN_MS,
  DAKHLA_RESULT_MS,
  DAKHLA_TAIL_MS,
  canJoin,
  createDakhla,
  finishDakhla,
  groupAccuracy,
  isChant,
  joinDakhla,
  leaveDakhla,
  parseLevel,
  parseReport,
  reportDakhla,
  type DakhlaView,
} from './dakhla-rules';

const T0 = 1_790_000_000_000;
const SQUAD = '0ebf99c6-c133-4038-ae21-845eaa0c7d61';
const rep = (
  perfect: number,
  good: number,
  miss: number,
  combo = 0,
  maxCombo = combo,
) => ({ perfect, good, miss, combo, maxCombo });

describe('dakhla rules', () => {
  it('validates chants, levels and reports', () => {
    expect(isChant('nafas')).toBe(true);
    expect(isChant('toString')).toBe(false);
    expect(parseLevel(3)).toBe(3);
    expect(parseLevel('3')).toBe(1);
    expect(parseReport(rep(10, 2, 1, 4, 6))).toEqual(rep(10, 2, 1, 4, 6));
    expect(parseReport({ ...rep(1, 0, 0), perfect: 1.5 })).toBeNull();
    expect(parseReport(rep(1, 0, 0, 3, 3))).toBeNull(); // combo above hits
    expect(parseReport(rep(300, 100, 50))).toBeNull(); // more notes than any chart
    expect(parseReport(null)).toBeNull();
  });

  it('alone, the song counts in at once; with friends, it gathers first', () => {
    const solo = createDakhla(SQUAD, 'a', 'nafas', 1, true, T0);
    expect(solo.phase).toBe('playing');
    expect(solo.startAt).toBe(T0 + DAKHLA_COUNTDOWN_MS);
    expect(solo.phaseUntil).toBe(
      solo.startAt + DAKHLA_CHANT_MS.nafas + DAKHLA_TAIL_MS,
    );
    const group = createDakhla(SQUAD, 'a', 'hamia', 2, false, T0);
    expect(group.phase).toBe('gathering');
    expect(group.phaseUntil).toBe(T0 + DAKHLA_GATHER_MS);
  });

  it('late joiners drop in until the raise, never past the player cap', () => {
    const s = createDakhla(SQUAD, 'a', 'nafas', 1, true, T0);
    const midway = s.startAt + s.songMs * 0.5;
    expect(joinDakhla(s, 'b', 2, midway)).toBe(true);
    expect(canJoin(s, s.startAt + s.songMs * DAKHLA_JOIN_UNTIL + 1)).toBe(
      false,
    );
    expect(joinDakhla(s, 'c', 1, s.startAt + s.songMs * 0.95)).toBe(false);
    for (let i = s.members.length; i < DAKHLA_MAX_PLAYERS; i++)
      joinDakhla(s, 'p' + i, 1, midway);
    expect(s.members.length).toBe(DAKHLA_MAX_PLAYERS);
    expect(joinDakhla(s, 'late', 1, midway)).toBe(false);
  });

  it('reports only grow, are rate limited and only count while playing', () => {
    const s = createDakhla(SQUAD, 'a', 'nafas', 1, true, T0);
    expect(reportDakhla(s, 'a', rep(1, 0, 0, 1), s.startAt - 10)).toBe(false);
    expect(reportDakhla(s, 'a', rep(5, 1, 0, 6), s.startAt + 1000)).toBe(true);
    expect(
      reportDakhla(
        s,
        'a',
        rep(6, 1, 0, 7),
        s.startAt + 1000 + DAKHLA_REPORT_MIN_MS - 1,
      ),
    ).toBe(false);
    expect(reportDakhla(s, 'a', rep(4, 1, 0, 5, 6), s.startAt + 2000)).toBe(
      false,
    ); // fewer notes than before
    expect(reportDakhla(s, 'a', rep(7, 1, 1, 0, 6), s.startAt + 2000)).toBe(
      true,
    );
    expect(reportDakhla(s, 'x', rep(1, 0, 0, 1), s.startAt + 3000)).toBe(false);
  });

  it('the result weighs everybody by notes played and crowns the next capo', () => {
    const s = createDakhla(SQUAD, 'a', 'nafas', 1, false, T0);
    joinDakhla(s, 'b', 3, T0 + 1000);
    joinDakhla(s, 'c', 1, T0 + 1000);
    s.phase = 'playing';
    s.startAt = T0;
    reportDakhla(s, 'a', rep(50, 10, 40, 2, 9), T0 + 5000);
    reportDakhla(s, 'b', rep(90, 10, 0, 100, 100), T0 + 5000);
    expect(groupAccuracy(s.members)).toBeCloseTo((50 + 6 + 90 + 6) / 200, 6);
    finishDakhla(s, T0 + 70_000);
    expect(s.result).toEqual({
      acc: 0.76,
      mvpId: 'b',
      comboId: 'b',
      nextCapoId: 'b',
      players: 2,
    });
    expect(s.phaseUntil).toBe(T0 + 70_000 + DAKHLA_RESULT_MS);
  });

  it('the capo leaving hands the call to the next player; the last one leaving cancels', () => {
    const s = createDakhla(SQUAD, 'a', 'nafas', 1, false, T0);
    joinDakhla(s, 'b', 1, T0);
    expect(leaveDakhla(s, 'a', T0 + 1)).toBe(true);
    expect(s.capoId).toBe('b');
    expect(leaveDakhla(s, 'b', T0 + 2)).toBe(false);
    expect(s.cancelled).toBe(true);
    expect(s.phase).toBe('ended');
  });
});

describe('dakhla in the lobby service', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
  });
  afterEach(() => jest.useRealTimers());

  function setup() {
    const world = new LobbyWorldService();
    const out: { event: string; payload: unknown }[] = [];
    const sink: BallSink = {
      toRoom: (_s, event, payload) => out.push({ event, payload }),
    };
    world.attachBallSink(sink);
    const enter = (userId: string) =>
      world.acceptMove(
        parseLobbyMove({
          squadId: SQUAD,
          seq: 1,
          x: 0,
          z: 0,
          vx: 0,
          vz: 0,
          h: 0,
          m: 0,
        })!,
        userId,
        'sock-' + userId,
        Date.now(),
      );
    const states = () =>
      out
        .filter((o) => o.event === 'lobby.dak.state')
        .map((o) => o.payload as DakhlaView);
    return { world, out, enter, states, last: () => states().at(-1)! };
  }

  it('runs a full song for a squad, broadcasting throttled scores and the result', () => {
    const { world, enter, states, last } = setup();
    enter('a');
    enter('b');
    expect(
      world.startDakhla(SQUAD, 'stranger', 'nafas', 1, Date.now()),
    ).toBeNull();
    const v = world.startDakhla(SQUAD, 'a', 'nafas', 1, Date.now())!;
    expect(v.phase).toBe('gathering');
    expect(world.startDakhla(SQUAD, 'b', 'hamia', 1, Date.now())).toBeNull(); // one at a time
    expect(world.joinDakhla(SQUAD, 'b', 2, Date.now())).toBe(true);
    expect(world.goDakhla(SQUAD, 'b', Date.now())).toBe(false); // only the capo counts in
    expect(world.goDakhla(SQUAD, 'a', Date.now())).toBe(true);
    const playing = last();
    expect(playing.phase).toBe('playing');
    expect(playing.members.map((m) => m.userId)).toEqual(['a', 'b']);
    expect(world.startPenalty(SQUAD, 'a', Date.now())).toBeNull(); // the pitch is busy

    jest.advanceTimersByTime(DAKHLA_COUNTDOWN_MS + 1000);
    const before = states().length;
    world.reportDakhla(SQUAD, 'a', rep(4, 0, 0, 4), Date.now());
    world.reportDakhla(SQUAD, 'b', rep(3, 1, 0, 4), Date.now());
    expect(states().length).toBe(before);
    jest.advanceTimersByTime(300);
    expect(states().length).toBe(before + 1);
    expect(last().acc).toBeCloseTo((7 + 0.6) / 8, 2);

    jest.advanceTimersByTime(DAKHLA_CHANT_MS.nafas + DAKHLA_TAIL_MS);
    expect(last().phase).toBe('ended');
    expect(last().result?.mvpId).toBe('a');
    const snap = world.snapshot(SQUAD, Date.now());
    expect(snap.dak?.phase).toBe('ended');
    jest.advanceTimersByTime(DAKHLA_RESULT_MS + 500);
    expect(world.snapshot(SQUAD, Date.now()).dak).toBeUndefined();
    world.onModuleDestroy();
  });

  it('a player leaving the lobby leaves the song too', () => {
    const { world, enter, last } = setup();
    enter('a');
    world.startDakhla(SQUAD, 'a', 'finala', 3, Date.now());
    expect(last().phase).toBe('playing'); // alone: straight in
    world.memberLeft(SQUAD, 'a');
    expect(last().cancelled).toBe(true);
    world.onModuleDestroy();
  });
});
