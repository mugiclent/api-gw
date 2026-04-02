import Joi from 'joi';

const schema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').required(),
  PORT: Joi.number().default(3000),

  // JWT — EdDSA public key only (private key lives in user-service)
  JWT_PUBLIC_KEY: Joi.string().required(),

  // Routes file — raw URL to routes.yaml, polled for live config updates
  ROUTES_URL: Joi.string().uri().required(),
  ROUTES_TOKEN: Joi.string().allow('').default(''),
  ROUTES_POLL_INTERVAL_MS: Joi.number().default(30000),

  // User service (for JWKS proxy)
  USER_SERVICE_URL: Joi.string().uri().required(),
});

const { error, value } = schema.validate(process.env, { allowUnknown: true });
if (error) throw new Error(`Config validation error: ${error.message}`);

export const env = value as {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  JWT_PUBLIC_KEY: string;
  ROUTES_URL: string;
  ROUTES_TOKEN: string; // empty string when repo is public
  ROUTES_POLL_INTERVAL_MS: number;
  USER_SERVICE_URL: string;
};
