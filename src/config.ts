import { z } from 'zod';
const schema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().default(1337),
  SESSION_SECRET: z.string().default('dev-only-not-secret'),
  // No default: the server falls back to a random secret persisted in data/flag-secret.
  FLAG_SECRET: z.string().min(1).optional(),
  AI_BACKEND: z.enum(['sim', 'ollama', 'byo']).default('sim'),
});
export const config = schema.parse(process.env);
