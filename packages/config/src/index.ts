import { z } from 'zod';

const configSchema = z.object({
  // ── MCP Server ────────────────────────────────────────────────────────────
  MCP_SERVER_PORT: z.coerce.number().int().positive().default(3001),
  MCP_SERVER_HOST: z.string().default('0.0.0.0'),

  // ── Deployment Mode ───────────────────────────────────────────────────────
  /** dev: direct Docker DB connections | production: HTTP client to remote API */
  TOOLPILOT_MODE: z.enum(['dev', 'staging', 'production']).default('dev'),
  /** URL of the ToolCairn HTTP API (used when TOOLPILOT_MODE=production) */
  TOOLPILOT_API_URL: z.string().default('https://api.neurynae.com'),

  // ── General ───────────────────────────────────────────────────────────────
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Config = z.infer<typeof configSchema>;

function loadConfig(): Config {
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Invalid environment configuration:');
    console.error(result.error.format());
    process.exit(1);
  }
  return result.data;
}

/** Validated, typed configuration loaded from environment variables. */
export const config: Config = loadConfig();
