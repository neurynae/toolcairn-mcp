import { homedir } from 'node:os';
import { join } from 'node:path';
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
 * In production the logger writes to two targets:
 * 1. stderr — all messages at the configured level (visible via `npx toolcairn-mcp 2>/dev/null`)
 * 2. ~/.toolcairn/logs/mcp-error-YYYY-MM-DD.log — warn+ messages for post-hoc debugging
 *
 * In development (NODE_ENV !== 'production') the file transport is omitted to
 * avoid cluttering the user's home directory during testing.
 */
export function createMcpLogger(opts: CreateLoggerOptions): Logger {
  const level =
    opts.level ?? process.env.LOG_LEVEL ?? (process.env.NODE_ENV !== 'production' ? 'debug' : 'info');

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

  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    // Dev: stderr only, no file pollution
    return pino({ ...pinoOpts, transport: { target: 'pino/file', options: { destination: 2 } } });
  }

  // Production: stderr + persistent error log file
  const logDir = join(homedir(), '.toolcairn', 'logs');
  const today = new Date().toISOString().slice(0, 10);
  const errorLogPath = join(logDir, `mcp-error-${today}.log`);

  const transport = pino.transport({
    targets: [
      { target: 'pino/file', options: { destination: 2 }, level },
      { target: 'pino/file', options: { destination: errorLogPath, mkdir: true }, level: 'warn' },
    ],
  });

  return pino(pinoOpts, transport);
}

/** Alias for convenience — use createMcpLogger as the standard factory in MCP packages */
export { createMcpLogger as createLogger };
