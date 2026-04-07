import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { config } from '@toolcairn/config';

export function createTransport(): Transport {
  if (process.env.MCP_TRANSPORT === 'http') {
    return new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });
  }
  return new StdioServerTransport();
}

export { config };
