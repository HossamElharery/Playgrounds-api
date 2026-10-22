import { CamoHost, type CamoUser, type HostSink } from './camo-host';

describe('camo host voice fan-out', () => {
  afterEach(() => jest.clearAllTimers());
  it('keeps sending the voice map through reveal, prep and hunt', () => {
    let t = 10_000_000;
    const sent: Array<{ userId: string; event: string; payload: any }> = [];
    const sink: HostSink = { emit: (userId, event, payload) => void sent.push({ userId, event, payload }) };
    const host = new CamoHost({ maxMatches: 2, now: () => t, sink });
    const u = (n: number): CamoUser => ({ userId: `u${n}`, name: `P${n}`, morphId: 'potato', guest: false });
    host.createPrivate(u(1), { bots: 3 });
    const code = host.matchOf('u1')!.code!;
    host.joinPrivate(u(2), code);
    host.joinPrivate(u(3), code);
    host.hostStart('u1');
    const phases = new Set<string>();
    for (let i = 0; i < 1200; i++) {
      t += 100;
      for (const p of host.matchOf('u1')!.players) if (!p.isBot) p.lastInputAt = t;
      host.tick(t);
      phases.add(host.matchOf('u1')!.phase);
    }
    const byPhase = new Map<string, number>();
    for (const s of sent) if (s.event === 'camo.voice' && s.userId === 'u1') byPhase.set(s.payload.phase, (byPhase.get(s.payload.phase) ?? 0) + 1);
    console.log([...phases], [...byPhase]);
    expect(byPhase.get('prep') ?? 0).toBeGreaterThan(10);
  });
});
