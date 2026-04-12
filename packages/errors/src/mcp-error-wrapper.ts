import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from 'pino';
import { ErrorCode } from './error-codes.js';
import { AppError } from './errors.js';

/**
 * Wraps an MCP tool handler with structured error handling.
 *
 * Without this wrapper, an uncaught throw inside a tool handler crashes the
 * entire MCP server session. With it:
 * - AppError instances are caught, logged at appropriate severity, and returned
 *   as a proper MCP CallToolResult with isError=true
 * - Unknown errors are caught, logged at 'error', and returned with a generic
 *   ERR_MCP_HANDLER code
 *
 * The handler itself is responsible for returning CallToolResult on expected
 * failures (validation, not-found). This wrapper is a safety net for unexpected
 * exceptions that escape normal control flow.
 *
 * Compose with withEventLogging from event-logger.ts — this wrapper goes INSIDE
 * the event logger so errors are both logged and recorded as events:
 *
 *   withEventLogging('search_tools', withErrorHandling('search_tools', logger, handler))
 */
export function withErrorHandling<TArgs>(
  toolName: string,
  logger: Logger,
  handler: (args: TArgs) => Promise<CallToolResult>,
): (args: TArgs) => Promise<CallToolResult> {
  return async (args: TArgs): Promise<CallToolResult> => {
    try {
      return await handler(args);
    } catch (err) {
      if (err instanceof AppError) {
        const logLevel = err.severity === 'critical' || err.severity === 'high' ? 'error' : 'warn';

        logger[logLevel]({ err, tool: toolName }, `Tool ${toolName} failed: ${err.message}`);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: false,
                error: err.code,
                message: err.isOperational ? err.message : 'An internal error occurred',
              }),
            },
          ],
          isError: true,
        };
      }

      // Unknown/programmer error
      logger.error({ err, tool: toolName }, `Unexpected error in tool ${toolName}`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              error: ErrorCode.ERR_MCP_HANDLER,
              message: err instanceof Error ? err.message : String(err),
            }),
          },
        ],
        isError: true,
      };
    }
  };
}
