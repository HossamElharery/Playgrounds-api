import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { BroadcastNotificationDto } from './broadcast-notification.dto';

describe('BroadcastNotificationDto', () => {
  const base = {
    audience: 'individual',
    recipientIds: ['user-1'],
    titleEn: 'Notice',
    titleAr: 'إشعار',
    bodyEn: 'Details for owners',
    bodyAr: 'تفاصيل للشركاء',
  };

  it('rejects a CTA that is not a path or http(s) URL', async () => {
    const dto = plainToInstance(BroadcastNotificationDto, {
      ...base,
      ctaLabelEn: 'Open',
      ctaLabelAr: 'افتح',
      ctaUrl: 'Facere cupidatat officia non aut aliquam',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'ctaUrl')).toBe(true);
  });

  it('accepts an in-app CTA path', async () => {
    const dto = plainToInstance(BroadcastNotificationDto, {
      ...base,
      ctaLabelEn: 'Open',
      ctaLabelAr: 'افتح',
      ctaUrl: '/en/venues/neon-arena',
    });
    expect(await validate(dto)).toEqual([]);
  });
});
