import { LobbyKioskGateway } from './lobby-kiosk.gateway';
import { LobbyKioskService } from './lobby-kiosk.service';

function setup(opts: { enabled?: boolean; rooms?: string[]; userId?: string | null } = {}) {
  const config: any = {
    get: (k: string) => (k === 'LOBBY_KIOSK_ENABLED' && opts.enabled !== false ? 'true' : undefined),
  };
  const kiosk = {
    allow: jest.fn(() => true),
    state: jest.fn(() => ({ proposal: null, busy: [], nextMatch: null })),
    setBusy: jest.fn(),
    propose: jest.fn(async () => null),
    vote: jest.fn(async () => false),
    cancel: jest.fn(async () => false),
    booked: jest.fn(async () => false),
    broadcaster: null as any,
  };
  const gateway = new LobbyKioskGateway(config, kiosk as unknown as LobbyKioskService);
  const sent: { event: string; payload: any }[] = [];
  gateway.server = { to: () => ({ emit: () => undefined }) } as any;
  const client: any = {
    data: opts.userId === null ? {} : { userId: opts.userId ?? 'a' },
    rooms: new Set(opts.rooms ?? ['sock', 'squad:s1']),
    emit: (event: string, payload: any) => sent.push({ event, payload }),
  };
  return { gateway, kiosk, client, sent };
}

describe('LobbyKioskGateway', () => {
  it('answers state only to the sender', () => {
    const { gateway, client, sent, kiosk } = setup();
    gateway.state(client, { squadId: 's1' });
    expect(kiosk.state).toHaveBeenCalledWith('s1');
    expect(sent).toEqual([{ event: 'lobby.kiosk.state', payload: { proposal: null, busy: [], nextMatch: null } }]);
  });

  it('ignores every message when the flag is off', () => {
    const { gateway, client, kiosk } = setup({ enabled: false });
    gateway.state(client, { squadId: 's1' });
    gateway.busy(client, { squadId: 's1', busy: true });
    expect(kiosk.allow).not.toHaveBeenCalled();
    expect(kiosk.state).not.toHaveBeenCalled();
    expect(kiosk.setBusy).not.toHaveBeenCalled();
  });

  it('ignores a socket that is not in the squad room', () => {
    const { gateway, kiosk } = setup({ rooms: ['sock'] });
    const client: any = {
      data: { userId: 'a' },
      rooms: new Set(['sock']),
      emit: () => undefined,
    };
    gateway.state(client, { squadId: 's1' });
    expect(kiosk.state).not.toHaveBeenCalled();
  });

  it('ignores a guest socket', () => {
    const { gateway, kiosk } = setup({ userId: null });
    const client: any = { data: {}, rooms: new Set(['squad:s1']), emit: () => undefined };
    gateway.busy(client, { squadId: 's1', busy: true });
    expect(kiosk.setBusy).not.toHaveBeenCalled();
  });

  it('drops a message over the rate limit', () => {
    const { gateway, client, kiosk } = setup();
    kiosk.allow.mockReturnValue(false);
    gateway.busy(client, { squadId: 's1', busy: true });
    expect(kiosk.setBusy).not.toHaveBeenCalled();
  });

  it('forwards a proposal and a booking only after the guard', async () => {
    const { gateway, client, kiosk } = setup();
    await gateway.propose(client, {
      squadId: 's1',
      venueId: 'v1',
      date: '2026-09-26',
      startTime: '21:00',
      durationMin: 60,
    });
    expect(kiosk.propose).toHaveBeenCalled();
    await gateway.booked(client, { squadId: 's1', proposalId: 'p1', bookingId: 'bk1' });
    expect(kiosk.booked).toHaveBeenCalledWith('a', 's1', 'p1', 'bk1');
  });
});
