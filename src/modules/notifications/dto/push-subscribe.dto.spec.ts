import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { PushSubscribeDto } from './device-token.dto';

describe('PushSubscribeDto endpoint validation', () => {
  const base = { keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(16) } };

  it('accepts a real push service endpoint', async () => {
    const dto = plainToInstance(PushSubscribeDto, { ...base, endpoint: 'https://fcm.googleapis.com/fcm/send/abc123' });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects a bare word, even with no TLD requirement relaxed elsewhere', async () => {
    const dto = plainToInstance(PushSubscribeDto, { ...base, endpoint: 'not-a-url' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'endpoint')).toBe(true);
  });

  it('rejects a non-https endpoint', async () => {
    const dto = plainToInstance(PushSubscribeDto, { ...base, endpoint: 'http://fcm.googleapis.com/fcm/send/abc123' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'endpoint')).toBe(true);
  });
});
