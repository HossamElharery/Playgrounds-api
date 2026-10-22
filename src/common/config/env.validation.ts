import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().default(3000),

  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgresql', 'postgres'] })
    .required(),
  PRISMA_CONNECTION_LIMIT: Joi.number().integer().min(1).max(20).default(10),
  PRISMA_POOL_TIMEOUT_SECONDS: Joi.number().integer().min(1).max(60).default(15),

  JWT_ACCESS_SECRET: Joi.string().min(32).required(),
  JWT_ACCESS_EXPIRES_IN: Joi.string().default('15m'),
  JWT_REFRESH_SECRET: Joi.string().min(32).required(),
  JWT_REFRESH_EXPIRES_IN: Joi.string().default('7d'),
  SALT_ROUNDS: Joi.number().default(10),

  GOOGLE_CLIENT_ID: Joi.string().allow('').optional(),
  GOOGLE_CLIENT_SECRET: Joi.string().allow('').optional(),
  FACEBOOK_APP_ID: Joi.string().allow('').optional(),
  FACEBOOK_APP_SECRET: Joi.string().allow('').optional(),
  WEBAUTHN_RP_ID: Joi.string().allow('').optional(),
  WEBAUTHN_RP_NAME: Joi.string().allow('').optional(),
  WEBAUTHN_ORIGINS: Joi.string().allow('').optional(),

  OTP_PROVIDER: Joi.string()
    .valid('console', 'twilio_verify')
    .default('console'),
  OTP_TTL_SECONDS: Joi.number().default(300),
  TWILIO_ACCOUNT_SID: Joi.when('OTP_PROVIDER', {
    is: 'twilio_verify',
    then: Joi.string()
      .pattern(/^AC[0-9a-fA-F]{32}$/)
      .required(),
    otherwise: Joi.string().allow('').optional(),
  }),
  TWILIO_AUTH_TOKEN: Joi.when('OTP_PROVIDER', {
    is: 'twilio_verify',
    then: Joi.string().min(16).required(),
    otherwise: Joi.string().allow('').optional(),
  }),
  TWILIO_VERIFY_SERVICE_SID: Joi.when('OTP_PROVIDER', {
    is: 'twilio_verify',
    then: Joi.string()
      .pattern(/^VA[0-9a-fA-F]{32}$/)
      .required(),
    otherwise: Joi.string().allow('').optional(),
  }),

  STORAGE_PROVIDER: Joi.string().valid('local', 's3').default('local'),
  STORAGE_LOCAL_PUBLIC_BASE: Joi.string().default('/uploads'),
  AWS_REGION: Joi.string().allow('').optional(),
  AWS_ACCESS_KEY_ID: Joi.string().allow('').optional(),
  AWS_SECRET_ACCESS_KEY: Joi.string().allow('').optional(),
  S3_BUCKET: Joi.string().allow('').optional(),
  S3_PUBLIC_BASE: Joi.string().allow('').optional(),

  SMTP_HOST: Joi.string().allow('').optional(),
  SMTP_PORT: Joi.number().default(587),
  SMTP_USER: Joi.string().allow('').optional(),
  SMTP_PASS: Joi.string().allow('').optional(),
  MAIL_FROM: Joi.string().default('no-reply@matchena.com'),
  MAIL_REPLY_TO: Joi.string().email().allow('').optional(),

  QR_SIGNING_SECRET: Joi.string().min(32).required(),

  // Card payments. Empty = disabled: every booking is pay-at-venue. `paymob` needs its keys, or boot fails.
  PAYMENT_GATEWAY: Joi.string().valid('', 'paymob').default(''),
  PAYMOB_SECRET_KEY: Joi.when('PAYMENT_GATEWAY', { is: 'paymob', then: Joi.string().min(8).required(), otherwise: Joi.string().allow('').optional() }),
  PAYMOB_PUBLIC_KEY: Joi.when('PAYMENT_GATEWAY', { is: 'paymob', then: Joi.string().min(8).required(), otherwise: Joi.string().allow('').optional() }),
  PAYMOB_HMAC_SECRET: Joi.when('PAYMENT_GATEWAY', { is: 'paymob', then: Joi.string().min(8).required(), otherwise: Joi.string().allow('').optional() }),
  PAYMOB_INTEGRATION_IDS: Joi.when('PAYMENT_GATEWAY', { is: 'paymob', then: Joi.string().pattern(/^\d+(,\s*\d+)*$/).required(), otherwise: Joi.string().allow('').optional() }),
  PAYMOB_BASE_URL: Joi.string().uri().allow('').optional(),
  PAYMENT_RETURN_BASE_URL: Joi.string().uri().allow('').optional(),
  API_PUBLIC_URL: Joi.when('PAYMENT_GATEWAY', { is: 'paymob', then: Joi.string().uri().required(), otherwise: Joi.string().uri().allow('').optional() }),

  CORS_ORIGINS: Joi.string().default('http://localhost:4200'),
  SITE_URL: Joi.string().uri().default('https://matchena.com'),
  INDEXNOW_KEY: Joi.string().allow('').optional(),
  INDEXNOW_ENDPOINT: Joi.string()
    .uri()
    .default('https://api.indexnow.org/indexnow'),
  SENTRY_DSN: Joi.string().uri().allow('').optional(),

  FCM_SERVER_KEY: Joi.string().allow('').optional(),
  FIREBASE_SERVICE_ACCOUNT: Joi.string().allow('').optional(),
  APPLE_CLIENT_IDS: Joi.string().allow('').optional(),
  LOBBY_MORPHS_ENABLED: Joi.string().allow('').optional(),
  MORPH_DAILY_FREE_ROLLS: Joi.string().allow('').optional(),
  LOBBY_MOVEMENT_ENABLED: Joi.string().allow('').optional(),
  LOBBY_BALL_ENABLED: Joi.string().allow('').optional(),
  CAMO_ENABLED: Joi.string().allow('').optional(),
  CAMO_PUBLIC_MATCH_ENABLED: Joi.string().allow('').optional(),
  CAMO_VOICE_ENABLED: Joi.string().allow('').optional(),
  CAMO_DAILY_ENABLED: Joi.string().allow('').optional(),
  CAMO_DRAIN: Joi.string().allow('').optional(),
  LOBBY_KIOSK_ENABLED: Joi.string().allow('').optional(),
  LOBBY_SOCIAL_ENABLED: Joi.string().valid('true', 'false', '').default('false'),
  LOBBY_SOCIAL_ALLOW_DRAFT_CONTENT: Joi.string().valid('true', 'false', '').default('false'),
  STAFF_CALLS_ENABLED: Joi.string().allow('').optional(),
  STUN_URLS: Joi.string().allow('').optional(),
  TURN_URLS: Joi.string().allow('').optional(),
  TURN_USERNAME: Joi.string().allow('').optional(),
  TURN_CREDENTIAL: Joi.string().allow('').optional(),
  TURN_SECRET: Joi.string().allow('').optional(),
  TURN_TTL_SECONDS: Joi.string().allow('').optional(),
  TURN_FORCE_RELAY: Joi.string().allow('').optional(),

  GEMINI_API_KEY: Joi.string().allow('').optional(),
  GEMINI_MODEL: Joi.string().default('gemini-3.8-flash'),

  OPENROUTER_API_KEY: Joi.string().allow('').optional(),
  AI_OWNER_MODELS: Joi.string().allow('').optional(),
  AI_PUBLIC_MODELS: Joi.string().allow('').optional(),
  AI_OWNER_REASONING: Joi.string().allow('').optional(),
  AI_PUBLIC_REASONING: Joi.string().allow('').optional(),
  AI_OWNER_DAILY_BUDGET_USD: Joi.string().allow('').optional(),
  AI_PUBLIC_DAILY_BUDGET_USD: Joi.string().allow('').optional(),
  CAPTAIN_GUEST_PER_DAY: Joi.string().allow('').optional(),
  CAPTAIN_GUEST_PER_MINUTE: Joi.string().allow('').optional(),
  CAPTAIN_GUEST_IP_PER_DAY: Joi.string().allow('').optional(),
  CAPTAIN_GUEST_IP_PER_MINUTE: Joi.string().allow('').optional(),
  CAPTAIN_USER_PER_DAY: Joi.string().allow('').optional(),
  CAPTAIN_USER_PER_MINUTE: Joi.string().allow('').optional(),
  AI_HASH_SALT: Joi.string().allow('').optional(),
  TURNSTILE_SECRET_KEY: Joi.string().allow('').optional(),

  AI_FORCE_FAILURE: Joi.string().allow('').optional(),
}).unknown(true);
