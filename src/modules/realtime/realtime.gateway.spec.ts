import { RealtimeGateway } from './realtime.gateway';

describe('RealtimeGateway voice relay ordering', () => {
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function setup(lookupMs: (call: number) => number) {
    let call = 0;
    const prisma: any = {
      squadMember: {
        findUnique: jest.fn(async () => {
          await delay(lookupMs(call++));
          return { id: 'm' };
        }),
      },
    };
    const gateway = new RealtimeGateway({} as any, {} as any, prisma, {} as any);
    const sent: string[] = [];
    gateway.server = {
      to: () => ({ emit: (type: string) => sent.push(type) }),
    } as any;
    const client: any = { data: { userId: 'a' } };
    return { gateway, client, sent };
  }

  it('relays an ICE candidate only after the offer it belongs to', async () => {
    // The offer does two slow membership lookups, the candidate one fast one.
    // Unordered, the candidate reached the peer first and was dropped.
    const { gateway, client, sent } = setup((n) => (n < 2 ? 30 : 0));
    const offer = gateway.voiceOffer(client, { squadId: 's', toUserId: 'b', sdp: {} });
    const ice = gateway.voiceIce(client, { squadId: 's', toUserId: 'b', candidate: {} });
    await Promise.all([offer, ice]);
    expect(sent).toEqual(['voice.offer', 'voice.ice']);
  });

  it('keeps relaying after one message fails', async () => {
    const { gateway, client, sent } = setup(() => 0);
    const prisma = (gateway as any).prisma;
    prisma.squadMember.findUnique.mockRejectedValueOnce(new Error('db down'));
    await gateway.voiceIce(client, { squadId: 's', toUserId: 'b', candidate: {} });
    await gateway.voiceIce(client, { squadId: 's', toUserId: 'b', candidate: {} });
    expect(sent).toEqual(['voice.ice']);
  });

  it('ignores a candidate with no recipient', async () => {
    const { gateway, client, sent } = setup(() => 0);
    await gateway.voiceIce(client, { squadId: 's', toUserId: '', candidate: {} });
    expect(sent).toEqual([]);
  });
});
