# Security policy

We take the security of `@neurynae/toolcairn-mcp` and the ToolCairn API seriously. The MCP server runs locally in agent processes (Claude Code, Cursor, Claude Desktop, etc.) and forwards a small number of authenticated calls to `https://api.neurynae.com`, so a vulnerability here can affect every developer who installed the package.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.1.x   | ✅ Active — all security fixes shipped here |
| 1.0.x   | ⚠️ Critical fixes only |
| < 1.0   | ❌ Not supported — please upgrade |

We follow [Semantic Versioning](https://semver.org/). Security-relevant fixes ship as patch releases (e.g. `1.1.2 → 1.1.3`) and are surfaced in [CHANGELOG.md](./CHANGELOG.md).

## Reporting a vulnerability

**Please do not file a public GitHub issue for security problems.** Instead:

1. Email **[security@neurynae.com](mailto:security@neurynae.com)** with:
   - A description of the vulnerability and the impact you observed
   - Step-by-step reproduction (or a minimal proof-of-concept)
   - The affected version (`npm view @neurynae/toolcairn-mcp version` if unsure)
   - Whether the issue affects only the local CLI or also the hosted API at `api.neurynae.com`
2. We will acknowledge receipt within **2 business days**.
3. We aim to ship a fix or share a remediation plan within **14 days** for high-severity issues, and **30 days** for low / informational findings.
4. We coordinate disclosure: we'd like to publish an advisory after a fix is generally available — please give us the chance to ship before going public.

If your finding requires a CVE, we will request one through GitHub Security Advisories.

## What is in scope

- The `@neurynae/toolcairn-mcp` npm package — the published `dist/` and `bin/` contents, including the `scan` CLI.
- The MCP server's behaviour when launched by `npx @neurynae/toolcairn-mcp`, including stdio transport handling, tool registration, and credential storage in `~/.toolcairn/credentials.json`.
- The post-auth provisioning flow that writes `.toolcairn/config.json`, `.mcp.json`, `CLAUDE.md`, `.gitignore` (atomic writes under cross-process locks).
- Any path / command injection, prototype pollution, lock-bypass, or credential leakage in the above.
- Network calls to `https://api.neurynae.com` and `https://auth.neurynae.com`.

## What is out of scope

- Vulnerabilities in third-party MCP clients (Claude Code, Cursor, Windsurf, etc.). Report those to the respective vendors.
- Issues that require a malicious local user with shell access — local code execution is the trust boundary the package operates inside.
- Rate-limit bypass on the public API (`api.neurynae.com`) without proof of impact — please demonstrate the harm.
- Self-XSS or social-engineering scenarios.

## Hardening you can do today

- Pin the version in your MCP client config: `"args": ["@neurynae/toolcairn-mcp@1.1.2"]`.
- The server requires Node.js ≥ 22. Older Node versions may have unrelated security issues.
- The published package ships with `npm provenance` (Sigstore OIDC) — verify with `npm audit signatures`.
- Review `~/.toolcairn/credentials.json` permissions periodically; the file is created with `0600` on first auth.

## Contact

- Security: security@neurynae.com
- General: support@neurynae.com
- Issues (non-sensitive only): https://github.com/neurynae/toolcairn-mcp/issues
