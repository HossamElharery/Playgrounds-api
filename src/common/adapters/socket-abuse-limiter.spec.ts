import { SocketAbuseLimiter } from './socket-abuse-limiter';

describe('SocketAbuseLimiter', () => {
  const limits = {
    connectionAttemptsPerMinute: 2,
    eventsPerSecond: 2,
    eventsPerTenSeconds: 3,
  };

  it('bounds connection storms per address and resets the window', () => {
    const limiter = new SocketAbuseLimiter(limits);
    expect(limiter.allowConnection('1.2.3.4', 0)).toBe(true);
    expect(limiter.allowConnection('1.2.3.4', 1)).toBe(true);
    expect(limiter.allowConnection('1.2.3.4', 2)).toBe(false);
    expect(limiter.allowConnection('1.2.3.4', 60_000)).toBe(true);
  });

  it('bounds event bursts and sustained socket spam independently', () => {
    const limiter = new SocketAbuseLimiter(limits);
    expect(limiter.allowEvent('socket', 0)).toBe(true);
    expect(limiter.allowEvent('socket', 1)).toBe(true);
    expect(limiter.allowEvent('socket', 2)).toBe(false);
    expect(limiter.allowEvent('socket', 1_001)).toBe(true);
    expect(limiter.allowEvent('socket', 1_002)).toBe(false); // ten-second budget exhausted
    expect(limiter.allowEvent('socket', 10_001)).toBe(true);
  });

  it('forgets disconnected socket state', () => {
    const limiter = new SocketAbuseLimiter(limits);
    limiter.allowEvent('socket', 0);
    limiter.allowEvent('socket', 1);
    limiter.forget('socket');
    expect(limiter.allowEvent('socket', 2)).toBe(true);
  });

  it('fails closed when connection-address cardinality reaches its bound', () => {
    const limiter = new SocketAbuseLimiter({
      ...limits,
      maxTrackedConnectionAddresses: 2,
    });
    expect(limiter.allowConnection('1.1.1.1', 0)).toBe(true);
    expect(limiter.allowConnection('2.2.2.2', 0)).toBe(true);
    expect(limiter.allowConnection('3.3.3.3', 0)).toBe(false);
    expect(limiter.allowConnection('1.1.1.1', 1)).toBe(true);
  });

  it('fails closed when tracked socket cardinality reaches its bound', () => {
    const limiter = new SocketAbuseLimiter({
      ...limits,
      maxTrackedSockets: 1,
    });
    expect(limiter.allowEvent('first', 0)).toBe(true);
    expect(limiter.allowEvent('second', 0)).toBe(false);
    limiter.forget('first');
    expect(limiter.allowEvent('second', 1)).toBe(true);
  });
});
