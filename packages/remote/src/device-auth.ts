/**
 * Device authorization flow for the MCP CLI.
 * Implements the OAuth 2.0 Device Authorization Grant (RFC 8628).
 *
 * Survives MCP process restarts: the device_code is written to
 * ~/.toolcairn/pending-auth.json immediately on first request.
 * On every subsequent startup, if this file exists and hasn't expired,
 * polling resumes automatically — no need to re-open the browser.
 */
import {
  clearPendingAuth,
  loadPendingAuth,
  savePendingAuth,
  upgradeToAuthenticated,
} from './credentials.js';

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token: string;
  api_key: string;
  user: { id: string; email: string | null; name: string | null };
  error?: string;
}

/**
 * Open a URL in the default browser.
 * Uses spawn + detached so it works from stdio child processes (e.g. MCP server).
 * execSync blocks and fails silently in non-interactive contexts; spawn does not.
 */
async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  try {
    const platform = process.platform;
    let cmd: string;
    let args: string[];
    if (platform === 'win32') {
      cmd = 'cmd';
      args = ['/c', 'start', '', url];
    } else if (platform === 'darwin') {
      cmd = 'open';
      args = [url];
    } else {
      cmd = 'xdg-open';
      args = [url];
    }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: false });
    child.unref();
  } catch {
    // URL is printed to stderr as fallback
  }
}

/**
 * Request a new device code, persist it to ~/.toolcairn/pending-auth.json,
 * and open the browser automatically.
 *
 * Only call this on a FRESH start (no pending-auth.json). This is the only
 * place that opens the browser — the resume path in startDeviceAuth() never
 * opens the browser (prevents duplicate tabs on process restart).
 */
export async function requestDeviceCode(apiUrl: string): Promise<DeviceCodeResponse> {
  const res = await fetch(`${apiUrl}/v1/auth/device-code`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to start device auth. Check your internet connection.');
  const data = (await res.json()) as DeviceCodeResponse;

  // Persist immediately so polling can resume if this process is killed
  await savePendingAuth({
    device_code: data.device_code,
    user_code: data.user_code,
    verification_uri: data.verification_uri,
    expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    api_url: apiUrl,
  });

  // Open browser here (fresh start only — resume path skips this)
  process.stderr.write('\n──────────────────────────────────────────\n');
  process.stderr.write('  ToolCairn — Sign In Required\n');
  process.stderr.write('──────────────────────────────────────────\n');
  process.stderr.write('\n  Opening browser for authentication...\n\n');
  process.stderr.write(`  URL:  ${data.verification_uri}\n`);
  process.stderr.write(`  Code: ${data.user_code}\n\n`);
  await openBrowser(data.verification_uri);

  return data;
}

/**
 * Start the full device auth flow — request code (or resume pending), open browser, poll.
 * Returns user info on success, throws on failure.
 *
 * On restart: if ~/.toolcairn/pending-auth.json exists and hasn't expired,
 * polling resumes for the same code (browser already opened, user might already
 * have confirmed — poll will return the token immediately).
 */
export async function startDeviceAuth(
  apiUrl: string,
): Promise<{ userId: string; email: string; name: string | null }> {
  // Check for a pending auth from a previous (killed) process
  const pending = await loadPendingAuth();
  let codeData: DeviceCodeResponse;

  if (pending && pending.api_url === apiUrl) {
    // Resume from a previous (killed/restarted) process.
    // The browser was already opened — do NOT open it again (causes duplicate tabs).
    codeData = {
      device_code: pending.device_code,
      user_code: pending.user_code,
      verification_uri: pending.verification_uri,
      expires_in: Math.floor((new Date(pending.expires_at).getTime() - Date.now()) / 1000),
      interval: 5,
    };
    process.stderr.write('\n  ToolCairn: Waiting for sign-in confirmation...\n');
    process.stderr.write(`  URL:  ${codeData.verification_uri}\n`);
    process.stderr.write(`  Code: ${codeData.user_code}\n\n`);
    // No openBrowser() call here — browser already open from previous session
  } else {
    // Fresh start — requestDeviceCode() opens the browser (only place that does)
    codeData = await requestDeviceCode(apiUrl);
  }

  const result = await pollForToken(apiUrl, codeData.device_code, 5);

  // Clear pending auth — successfully authenticated
  await clearPendingAuth();
  await upgradeToAuthenticated(result.access_token, result.api_key, result.user);

  process.stderr.write(`\n  ✓ Signed in as ${result.user.email}\n\n`);

  return {
    userId: result.user.id,
    email: result.user.email ?? '',
    name: result.user.name,
  };
}

async function pollForToken(
  apiUrl: string,
  deviceCode: string,
  intervalSec: number,
): Promise<TokenResponse> {
  const intervalMs = Math.max(intervalSec, 5) * 1000;

  while (true) {
    await sleep(intervalMs);

    const res = await fetch(`${apiUrl}/v1/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: deviceCode, grant_type: 'device_code' }),
    });

    const data = (await res.json()) as TokenResponse;

    if (data.error === 'authorization_pending') continue;
    if (data.error === 'expired_token') {
      await clearPendingAuth();
      throw new Error('Device code expired. Please try again.');
    }
    if (data.error) throw new Error(`Authorization failed: ${data.error}`);
    if (data.access_token) return data;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
