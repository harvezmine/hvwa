import { z } from 'zod';
const schema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().default(1337),
  SESSION_SECRET: z.string().default('dev-only-not-secret'),
  FLAG_SECRET: z.string().default('dev-flag-secret'),
  AI_BACKEND: z.enum(['sim', 'ollama', 'byo']).default('sim'),
});
export const config = schema.parse(process.env);
