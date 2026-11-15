import { z } from 'zod';

// Blank / whitespace-only env values (e.g. `FLAG_SECRET=` in a .env file)
// mean "unset" rather than a validation error.
const optionalSecret = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().trim().min(1).optional(),
);

const schema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().default(1337),
  // No default: server.ts falls back to a random secret persisted in data/flag-secret.
  FLAG_SECRET: optionalSecret,
  AI_BACKEND: z.enum(['sim', 'ollama', 'byo']).default('sim'),
});

export type Config = z.infer<typeof schema>;

export function parseConfig(env: Record<string, string | undefined>): Config {
  return schema.parse(env);
}

export const config = parseConfig(process.env);
