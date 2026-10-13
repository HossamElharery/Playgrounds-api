import { CallsGateway } from './calls.gateway';

function setup(peer: string | null = 'peer-1') {
  const calls = {
    relayPeer: jest.fn().mockResolvedValue(peer),
    markRinging: jest.fn().mockResolvedValue(undefined),
  };
  const emitter = { emitToUser: jest.fn() };
  const gateway = new CallsGateway(calls as never, emitter as never);
  const client = (userId: string | null = 'me') =>
    ({ data: { userId, authReady: Promise.resolve() } }) as never;
  return { gateway, calls, emitter, client };
}

describe('CallsGateway', () => {
  it('relays an offer, answer and ICE candidate to the other party with the sender stamped by the server', async () => {
    const { gateway, emitter, client, calls } = setup();
    const c = client();
    await gateway.offer(c, {
      callId: 'c1',
      sdp: { type: 'offer', sdp: 'v=0' },
    });
    await gateway.answer(c, {
      callId: 'c1',
      sdp: { type: 'answer', sdp: 'v=0' },
    });
    await gateway.ice(c, { callId: 'c1', candidate: { candidate: 'x' } });
    expect(calls.relayPeer).toHaveBeenCalledWith('me', 'c1');
    expect(
      emitter.emitToUser.mock.calls.map(([to, e]) => [
        to,
        e.type,
        e.fromUserId,
      ]),
    ).toEqual([
      ['peer-1', 'call.offer', 'me'],
      ['peer-1', 'call.answer', 'me'],
      ['peer-1', 'call.ice', 'me'],
    ]);
  });

  it('drops messages from sockets that are not authenticated, not in the call, or malformed', async () => {
    const { gateway, emitter, client } = setup(null);
    await gateway.offer(client(), { callId: 'c1', sdp: { type: 'offer' } });
    expect(emitter.emitToUser).not.toHaveBeenCalled();

    const live = setup('peer-1');
    await live.gateway.offer(live.client(null), {
      callId: 'c1',
      sdp: { type: 'offer' },
    });
    await live.gateway.offer(live.client(), {
      callId: 123,
      sdp: { type: 'offer' },
    });
    await live.gateway.offer(live.client(), {
      callId: 'c1',
      sdp: 'not-an-object',
    });
    await live.gateway.offer(live.client(), {
      callId: 'x'.repeat(100),
      sdp: { type: 'offer' },
    });
    await live.gateway.ice(live.client(), {
      callId: 'c1',
      candidate: { candidate: 'x'.repeat(30_000) },
    });
    expect(live.emitter.emitToUser).not.toHaveBeenCalled();
  });

  it("keeps one socket's messages in order even when an earlier lookup is slower", async () => {
    const { gateway, emitter, client, calls } = setup();
    let release!: () => void;
    calls.relayPeer.mockImplementationOnce(
      () => new Promise((r) => (release = () => r('peer-1'))),
    );
    const c = client();
    const first = gateway.offer(c, { callId: 'c1', sdp: { type: 'offer' } });
    const second = gateway.ice(c, {
      callId: 'c1',
      candidate: { candidate: 'x' },
    });
    await new Promise((r) => setImmediate(r));
    expect(emitter.emitToUser).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second]);
    expect(emitter.emitToUser.mock.calls.map(([, e]) => e.type)).toEqual([
      'call.offer',
      'call.ice',
    ]);
  });

  it('passes the native flag of a ringing confirmation to the service', async () => {
    const { gateway, calls, client } = setup();
    await gateway.ringing(client(), { callId: 'c1', native: true });
    await gateway.ringing(client(), { callId: 'c2' });
    expect(calls.markRinging.mock.calls).toEqual([
      ['me', 'c1', true],
      ['me', 'c2', false],
    ]);
  });
});
