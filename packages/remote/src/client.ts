/**
 * ToolCairnClient — HTTP client used by the thin npm MCP package.
 *
 * Makes one POST request per remote tool call to the ToolCairn API
 * (sitting behind a Cloudflare Worker in production, or directly in dev).
 *
 * Returns CallToolResult so the MCP server can pass responses through unchanged.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export interface ToolCairnClientOptions {
  /** Base URL of the ToolCairn API, e.g. https://api.neurynae.com */
  baseUrl: string;
  /** Anonymous API key (UUID) sent in X-ToolCairn-Key header */
  apiKey: string;
  /** Optional JWT access token — sent as Authorization: Bearer when present */
  accessToken?: string;
  /** Request timeout in ms (default 30s) */
  timeoutMs?: number;
}

export class ToolCairnClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  private readonly accessToken?: string;

  constructor(opts: ToolCairnClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.accessToken = opts.accessToken;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // ── Core Search ──────────────────────────────────────────────────────────

  async searchTools(args: unknown): Promise<CallToolResult> {
    return this.post('/v1/search', args);
  }

  async searchToolsRespond(args: unknown): Promise<CallToolResult> {
    return this.post('/v1/search/respond', args);
  }

  // ── Graph ────────────────────────────────────────────────────────────────

  async checkCompatibility(args: unknown): Promise<CallToolResult> {
    return this.post('/v1/graph/compatibility', args);
  }

  async compareTools(args: unknown): Promise<CallToolResult> {
    return this.post('/v1/graph/compare', args);
  }

  async getStack(args: unknown): Promise<CallToolResult> {
    return this.post('/v1/graph/stack', args);
  }

  // ── Intelligence ─────────────────────────────────────────────────────────

  async refineRequirement(args: unknown): Promise<CallToolResult> {
    return this.post('/v1/intelligence/refine', args);
  }

  async verifySuggestion(args: unknown): Promise<CallToolResult> {
    return this.post('/v1/intelligence/verify', args);
  }

  async checkIssue(args: unknown): Promise<CallToolResult> {
    return this.post('/v1/intelligence/issue', args);
  }

  // ── Feedback ─────────────────────────────────────────────────────────────

  async reportOutcome(args: unknown): Promise<CallToolResult> {
    return this.post('/v1/feedback/outcome', args);
  }

  async suggestGraphUpdate(args: unknown): Promise<CallToolResult> {
    return this.post('/v1/feedback/suggest', args);
  }

  // ── Registration ─────────────────────────────────────────────────────────

  async register(clientId: string): Promise<{ ok: boolean; client_id: string }> {
    const res = await this.rawPost('/v1/register', { client_id: clientId });
    return res.json() as Promise<{ ok: boolean; client_id: string }>;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async post(path: string, body: unknown): Promise<CallToolResult> {
    try {
      const res = await this.rawPost(path, body);
      const data = (await res.json()) as CallToolResult;

      // API returns a CallToolResult directly — pass it through
      if (data && typeof data === 'object' && 'content' in data) {
        return data;
      }

      // Unexpected response shape — wrap it
      return {
        content: [{ type: 'text', text: JSON.stringify(data) }],
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              error: 'network_error',
              message: `ToolCairn API unreachable: ${msg}. Check your internet connection or try again later.`,
            }),
          },
        ],
        isError: true,
      };
    }
  }

  private rawPost(path: string, body: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-ToolCairn-Key': this.apiKey,
      'Accept-Encoding': 'gzip',
    };
    if (this.accessToken) {
      headers.Authorization = `Bearer ${this.accessToken}`;
    }
    return fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }
}
