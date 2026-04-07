import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export function okResult(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, data }) }],
  };
}

export function errResult(error: string, message: string): CallToolResult {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error, message }) }],
    isError: true,
  };
}
