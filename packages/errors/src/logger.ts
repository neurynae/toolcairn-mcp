import pino, { type Logger, type LoggerOptions } from 'pino';
import { errorSerializer } from './serializers.js';

const REDACT_PATHS = [
  'password',
  'token',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'apiKey',
  'api_key',
  'secret',
  'TOOLPILOT_API_KEY',
  'authorization',
  'cookie',
  '*.password',
  '*.token',
  '*.secret',
  '*.apiKey',
  '*.api_key',
];

export interface CreateLoggerOptions {
  /** Module name used in every log line, e.g. '@toolcairn/mcp-server' */
  name: string;
  /** Override the environment-driven log level */
  level?: string;
  /** Additional fields merged into every log line's base object */
  defaultFields?: Record<string, unknown>;
}

/**
 * Creates a pino logger for use inside the MCP server.
 *
 * IMPORTANT: The MCP JSON-RPC protocol communicates over stdout.
 * All logging MUST go to stderr (fd=2) to avoid corrupting the protocol stream.
 *
 * Implementation note (v0.10.16+):
 * The logger writes synchronously to `process.stderr`. We deliberately do NOT
 * use `pino.transport({...})` (which spawns a worker thread loading
 * `pino/file` at runtime) because the worker entry can't be statically
 * bundled by tsup — that path forced npx to install pino's transitive
 * tree on every fresh `@latest` resolve, blowing past Claude Code's MCP
 * startup window. Synchronous stderr writes are bundle-safe and faster.
 */
export function createMcpLogger(opts: CreateLoggerOptions): Logger {
  const level =
    opts.level ??
    process.env.LOG_LEVEL ??
    (process.env.NODE_ENV !== 'production' ? 'debug' : 'info');

  const pinoOpts: LoggerOptions = {
    name: opts.name,
    level,
    serializers: {
      err: errorSerializer,
      error: errorSerializer,
    },
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: {
      pid: process.pid,
      ...opts.defaultFields,
    },
  };

  // Sync write to stderr — no worker thread, no dynamic loader.
  return pino(pinoOpts, process.stderr);
}

/** Alias for convenience — use createMcpLogger as the standard factory in MCP packages */
export { createMcpLogger as createLogger };
