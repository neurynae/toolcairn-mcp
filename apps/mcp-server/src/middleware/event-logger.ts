/**
 * MCP Event Logger Middleware
 *
 * Wraps tool handlers to record timing, status, and metadata to:
 *   1. POST /v1/events on the ToolCairn API (queryable via DB — McpEvent table)
 *   2. TOOLCAIRN_EVENTS_PATH JSONL file (for standalone tracker.html)
 *
 * All writes are fire-and-forget — NEVER block a tool response.
 * If TOOLCAIRN_TRACKING_ENABLED=false (or unset), all logging is skipped.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { config } from '@toolcairn/config';
import { createMcpLogger } from '@toolcairn/errors';
import { loadCredentials } from '@toolcairn/remote';

const logger = createMcpLogger({ name: '@toolcairn/mcp-server:event-logger' });

function isTrackingEnabled(): boolean {
  return process.env.TOOLCAIRN_TRACKING_ENABLED !== 'false';
}

function getEventsPath(): string | null {
  return process.env.TOOLCAIRN_EVENTS_PATH ?? null;
}

interface McpEventRecord {
  id: string;
  tool_name: string;
  query_id: string | null;
  duration_ms: number;
  status: 'ok' | 'error';
  metadata: Record<string, unknown> | null;
  created_at: string;
}

function extractQueryId(args: Record<string, unknown>): string | null {
  if (typeof args.query_id === 'string') return args.query_id;
  return null;
}

function extractMetadata(toolName: string, result: CallToolResult): Record<string, unknown> | null {
  try {
    const text = result.content?.[0];
    if (text?.type !== 'text') return null;
    const parsed = JSON.parse(text.text) as Record<string, unknown>;
    const data = parsed.data as Record<string, unknown> | undefined;

    // Extract lightweight summary metadata — never store full results
    const meta: Record<string, unknown> = { tool: toolName };

    if (data) {
      if ('status' in data) meta.status = data.status;
      if ('total_confirmed' in data) meta.total_confirmed = data.total_confirmed;
      if ('staged' in data) meta.staged = data.staged;
      if ('auto_graduated' in data) meta.auto_graduated = data.auto_graduated;
      if ('is_two_option' in data) meta.is_two_option = data.is_two_option;
      if ('non_indexed_guidance' in data) meta.had_non_indexed_guidance = true;
      if ('credibility_warning' in data) meta.had_credibility_warning = true;
      if ('deprecation_warning' in data && data.deprecation_warning) {
        meta.had_deprecation_warning = true;
      }
      if ('recommendation' in data) meta.recommendation = data.recommendation;
      if ('compatibility_signal' in data) meta.compatibility_signal = data.compatibility_signal;
      if ('index_queued' in data) meta.index_queued = data.index_queued;
    }

    return meta;
  } catch {
    return null;
  }
}

async function writeToFile(eventsPath: string, event: McpEventRecord): Promise<void> {
  try {
    await mkdir(dirname(eventsPath), { recursive: true });
    await appendFile(eventsPath, `${JSON.stringify(event)}\n`, 'utf-8');
  } catch (e) {
    logger.warn({ err: e, path: eventsPath }, 'Failed to write event to JSONL file');
  }
}

async function sendToApi(event: McpEventRecord): Promise<void> {
  try {
    const creds = await loadCredentials();
    if (!creds) return;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (creds.access_token) headers.Authorization = `Bearer ${creds.access_token}`;
    if (creds.client_id) headers['X-ToolCairn-Key'] = creds.client_id;

    await fetch(`${config.TOOLPILOT_API_URL}/v1/events`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tool_name: event.tool_name,
        query_id: event.query_id,
        duration_ms: event.duration_ms,
        status: event.status,
        metadata: event.metadata,
      }),
    });
  } catch (e) {
    logger.debug({ err: e }, 'Failed to send event to API — non-fatal');
  }
}

type ToolHandler<TArgs> = (args: TArgs) => Promise<CallToolResult>;

/**
 * Wrap a tool handler with event logging.
 * The wrapper captures timing and status, then fires off async writes.
 */
export function withEventLogging<TArgs extends Record<string, unknown>>(
  toolName: string,
  handler: ToolHandler<TArgs>,
): ToolHandler<TArgs> {
  return async (args: TArgs): Promise<CallToolResult> => {
    if (!isTrackingEnabled()) {
      return handler(args);
    }

    const start = Date.now();
    let result: CallToolResult | undefined;
    let status: 'ok' | 'error' = 'ok';

    try {
      result = await handler(args);
      if (result.isError) status = 'error';
    } catch (e) {
      status = 'error';
      throw e;
    } finally {
      const duration_ms = Date.now() - start;
      const event: McpEventRecord = {
        id: crypto.randomUUID(),
        tool_name: toolName,
        query_id: extractQueryId(args),
        duration_ms,
        status,
        metadata: result ? extractMetadata(toolName, result) : null,
        created_at: new Date().toISOString(),
      };

      // Fire-and-forget: API + local file (never block the tool response)
      sendToApi(event).catch(() => {});

      const eventsPath = getEventsPath();
      if (eventsPath) {
        writeToFile(eventsPath, event).catch(() => {});
      }
    }

    // result is always assigned in the try block above; undefined path is unreachable
    return result ?? { content: [], isError: true };
  };
}
