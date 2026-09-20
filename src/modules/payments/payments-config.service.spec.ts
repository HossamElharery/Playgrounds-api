import { PaymentsConfigService } from './payments-config.service';
import { PAYMENT_PROVIDER } from './payment-provider.interface';
import { Test } from '@nestjs/testing';

describe('PaymentsConfigService', () => {
  it('reports mock provider as not live', async () => {
    const module = await Test.createTestingModule({
      providers: [
        PaymentsConfigService,
        { provide: PAYMENT_PROVIDER, useValue: { isLive: false } },
      ],
    }).compile();
    expect(module.get(PaymentsConfigService).isOnlinePaymentsLive()).toBe(false);
  });

  it('reports a live provider as live', async () => {
    const module = await Test.createTestingModule({
      providers: [
        PaymentsConfigService,
        { provide: PAYMENT_PROVIDER, useValue: { isLive: true } },
      ],
    }).compile();
    expect(module.get(PaymentsConfigService).isOnlinePaymentsLive()).toBe(true);
  });
});
