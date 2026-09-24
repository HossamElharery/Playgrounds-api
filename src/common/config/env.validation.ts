import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().default(3000),

  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgresql', 'postgres'] })
    .required(),

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

  CORS_ORIGINS: Joi.string().default('http://localhost:4200'),
  SITE_URL: Joi.string().uri().default('https://matchena.com'),
  INDEXNOW_KEY: Joi.string().allow('').optional(),
  INDEXNOW_ENDPOINT: Joi.string()
    .uri()
    .default('https://api.indexnow.org/indexnow'),

  /** Legacy, unused: Google shut the server-key FCM API down in 2024. */
  FCM_SERVER_KEY: Joi.string().allow('').optional(),
  /** Firebase service-account JSON (raw or base64) for native push over FCM HTTP v1. */
  FIREBASE_SERVICE_ACCOUNT: Joi.string().allow('').optional(),
  /** Sign in with Apple audiences, comma separated (default com.matchena.app). */
  APPLE_CLIENT_IDS: Joi.string().allow('').optional(),
  /** Lobby Morphs feature flag: exactly `true` enables it; anything else keeps it off. */
  LOBBY_MORPHS_ENABLED: Joi.string().allow('').optional(),
  /** Free morph rolls per Cairo day. Unset/empty = unlimited (current production behavior). */
  MORPH_DAILY_FREE_ROLLS: Joi.string().allow('').optional(),
  STUN_URLS: Joi.string().allow('').optional(),
  TURN_URLS: Joi.string().allow('').optional(),
  TURN_USERNAME: Joi.string().allow('').optional(),
  TURN_CREDENTIAL: Joi.string().allow('').optional(),

  GEMINI_API_KEY: Joi.string().allow('').optional(),
  GEMINI_MODEL: Joi.string().default('gemini-3.6-flash'),

  // --- OpenRouter (free-tier fallback for the AI provider layer) ---
  OPENROUTER_API_KEY: Joi.string().allow('').optional(),

  // TEST ONLY — simulates a Gemini failure to exercise the OpenRouter fallback
  // path without waiting for a real outage. Must be unset in production.
  AI_FORCE_FAILURE: Joi.string().allow('').optional(),
}).unknown(true);
