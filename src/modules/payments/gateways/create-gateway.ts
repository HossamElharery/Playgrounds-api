import type { ConfigService } from '@nestjs/config';
import { DisabledGateway } from './disabled.gateway';
import { PaymobGateway } from './paymob.gateway';
import type { PaymentGateway } from '../payment-gateway.interface';

/**
 * PAYMENT_GATEWAY=paymob needs PAYMOB_SECRET_KEY, PAYMOB_PUBLIC_KEY, PAYMOB_HMAC_SECRET and
 * PAYMOB_INTEGRATION_IDS (validated at boot in env.validation.ts). Anything else, including a
 * missing value, is the disabled gateway: no online payment is possible.
 */
export function createGateway(config: Pick<ConfigService, 'get'>): PaymentGateway {
  const name = (config.get<string>('PAYMENT_GATEWAY') ?? '').trim().toLowerCase();
  if (name !== 'paymob') return new DisabledGateway();
  return new PaymobGateway({
    secretKey: config.get<string>('PAYMOB_SECRET_KEY')!,
    publicKey: config.get<string>('PAYMOB_PUBLIC_KEY')!,
    hmacSecret: config.get<string>('PAYMOB_HMAC_SECRET')!,
    integrationIds: (config.get<string>('PAYMOB_INTEGRATION_IDS') ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0),
    baseUrl: config.get<string>('PAYMOB_BASE_URL') || undefined,
  });
}
