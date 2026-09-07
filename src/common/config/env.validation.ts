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
  APPLE_CLIENT_ID: Joi.string().allow('').optional(),
  APPLE_TEAM_ID: Joi.string().allow('').optional(),
  APPLE_KEY_ID: Joi.string().allow('').optional(),

  OTP_PROVIDER: Joi.string().valid('console').default('console'),
  OTP_TTL_SECONDS: Joi.number().default(300),

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
  MAIL_FROM: Joi.string().default('no-reply@mal3ab.app'),

  QR_SIGNING_SECRET: Joi.string().min(32).required(),

  CORS_ORIGINS: Joi.string().default('http://localhost:4200'),

  FCM_SERVER_KEY: Joi.string().allow('').optional(),
  STUN_URLS: Joi.string().allow('').optional(),
  TURN_URLS: Joi.string().allow('').optional(),
  TURN_USERNAME: Joi.string().allow('').optional(),
  TURN_CREDENTIAL: Joi.string().allow('').optional(),
}).unknown(true);
