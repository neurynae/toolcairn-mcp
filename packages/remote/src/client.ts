/**
 * ToolCairnClient — HTTP client used by the thin npm MCP package.
 *
 * Makes one POST request per remote tool call to the ToolCairn API
 * (sitting behind a Cloudflare Worker in production, or directly in dev).
 *
 * Returns CallToolResult so the MCP server can pass responses through unchanged.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode } from '@toolcairn/errors';
import type { DiscoveryWarning, Ecosystem, MatchMethod } from '@toolcairn/types';

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

  // ── Tool resolution ──────────────────────────────────────────────────────

  /**
   * Classify a batch of (ecosystem, name) tuples against the ToolCairn graph.
   *
   * Used by the discovery pipeline inside `toolcairn_init` — NOT exposed as an
   * MCP tool to the agent. Returns typed data, not CallToolResult.
   *
   * Graceful degradation:
   *   - HTTP 404 (endpoint not deployed yet): returns all inputs as unmatched,
   *     with a warning.
   *   - Network error / timeout: same.
   *   - HTTP 200 but malformed body: logs a warning, returns unmatched.
   *
   * Caller (scan-project) uses the unmatched results to classify tools as
   * `source: "non_oss"` and still returns a valid scan.
   */
  async batchResolve(
    items: Array<{
      name: string;
      ecosystem: Ecosystem;
      canonical_package_name?: string;
      github_url?: string;
    }>,
  ): Promise<{
    results: Array<{
      input: { name: string; ecosystem: Ecosystem };
      matched: boolean;
      match_method: MatchMethod;
      tool?: { canonical_name: string; github_url: string; categories: string[] };
    }>;
    warnings: DiscoveryWarning[];
    methods: Map<string, MatchMethod>;
    githubUrls: Map<string, string>;
  }> {
    const warnings: DiscoveryWarning[] = [];
    const methods = new Map<string, MatchMethod>();
    const githubUrls = new Map<string, string>();

    if (items.length === 0) {
      return { results: [], warnings, methods, githubUrls };
    }

    try {
      const res = await this.rawPost('/v1/tools/batch-resolve', {
        api_version: '1',
        tools: items,
      });

      if (res.status === 404) {
        warnings.push({
          scope: 'batch-resolve',
          message:
            '/v1/tools/batch-resolve not deployed on this engine — falling back to offline classification (source: non_oss).',
        });
        return {
          results: items.map((input) => ({ input, matched: false, match_method: 'none' })),
          warnings,
          methods,
          githubUrls,
        };
      }

      if (!res.ok) {
        warnings.push({
          scope: 'batch-resolve',
          message: `batch-resolve returned HTTP ${res.status} — all tools marked as non_oss.`,
        });
        return {
          results: items.map((input) => ({ input, matched: false, match_method: 'none' })),
          warnings,
          methods,
          githubUrls,
        };
      }

      const body = (await res.json()) as {
        resolved?: Array<{
          input: { name: string; ecosystem: Ecosystem };
          matched?: boolean;
          match_method?: MatchMethod;
          tool?: { canonical_name: string; github_url: string; categories: string[] };
        }>;
      };
      if (!Array.isArray(body.resolved)) {
        warnings.push({
          scope: 'batch-resolve',
          message: 'batch-resolve returned unexpected body shape — falling back.',
        });
        return {
          results: items.map((input) => ({ input, matched: false, match_method: 'none' })),
          warnings,
          methods,
          githubUrls,
        };
      }

      const results: Array<{
        input: { name: string; ecosystem: Ecosystem };
        matched: boolean;
        match_method: MatchMethod;
        tool?: { canonical_name: string; github_url: string; categories: string[] };
      }> = [];
      for (const entry of body.resolved) {
        const method = entry.match_method ?? (entry.matched ? 'tool_name_exact' : 'none');
        const matched = entry.matched ?? method !== 'none';
        const key = `${entry.input.ecosystem}:${entry.input.name}`;
        methods.set(key, method);
        if (entry.tool?.github_url) githubUrls.set(key, entry.tool.github_url);
        results.push({ input: entry.input, matched, match_method: method, tool: entry.tool });
      }
      return { results, warnings, methods, githubUrls };
    } catch (err) {
      warnings.push({
        scope: 'batch-resolve',
        message: `batch-resolve network failure: ${err instanceof Error ? err.message : String(err)}. Tools classified as non_oss.`,
      });
      return {
        results: items.map((input) => ({ input, matched: false, match_method: 'none' })),
        warnings,
        methods,
        githubUrls,
      };
    }
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
              error: ErrorCode.ERR_NETWORK_UNREACHABLE,
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
