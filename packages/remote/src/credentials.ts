/**
 * Manages authentication credentials stored in ~/.toolcairn/credentials.json.
 * Authentication is required — there is no anonymous access.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CREDENTIALS_DIR = join(homedir(), '.toolcairn');
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, 'credentials.json');
const PENDING_AUTH_FILE = join(CREDENTIALS_DIR, 'pending-auth.json');

const isWindows = process.platform === 'win32';

/**
 * Atomic-enough write that also tightens filesystem permissions on POSIX.
 * 0600 means owner read/write only — other local users on a shared box
 * (CI runners, multi-user dev hosts, jump boxes) can no longer read the
 * file even if HOME is world-traversable. On Windows the OS already
 * defaults to user-profile ACLs, which are sufficient.
 *
 * The chmod is best-effort — read-only filesystems and exotic FS drivers
 * will throw, in which case we still wrote the secret (better than
 * failing the auth flow). We only break the contract if the write itself
 * fails.
 */
async function writeSecure(path: string, contents: string): Promise<void> {
  await mkdir(CREDENTIALS_DIR, {
    recursive: true,
    mode: isWindows ? undefined : 0o700,
  });
  await writeFile(path, contents, {
    encoding: 'utf-8',
    mode: isWindows ? undefined : 0o600,
  });
  if (!isWindows) {
    // writeFile only honors `mode` on file creation; tighten existing perms too.
    try {
      await chmod(path, 0o600);
    } catch {
      /* tolerate read-only / unsupported FS */
    }
    try {
      await chmod(CREDENTIALS_DIR, 0o700);
    } catch {
      /* tolerate */
    }
  }
}

export interface PendingAuth {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_at: string; // ISO timestamp
  api_url: string;
}

export async function savePendingAuth(data: PendingAuth): Promise<void> {
  await writeSecure(PENDING_AUTH_FILE, JSON.stringify(data, null, 2));
}

export async function loadPendingAuth(): Promise<PendingAuth | null> {
  try {
    const raw = await readFile(PENDING_AUTH_FILE, 'utf-8');
    const data = JSON.parse(raw) as PendingAuth;
    if (new Date(data.expires_at) < new Date()) {
      await clearPendingAuth();
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

export async function clearPendingAuth(): Promise<void> {
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(PENDING_AUTH_FILE);
  } catch {
    // file didn't exist — that's fine
  }
}

export interface Credentials {
  client_id: string;
  created_at: string;
  api_url?: string;
  access_token?: string;
  user_id?: string;
  user_email?: string;
  user_name?: string;
  authenticated_at?: string;
}

/**
 * Returns true if the credentials contain a valid, non-expired JWT access token.
 */
export function isTokenValid(creds: Credentials): boolean {
  if (!creds.access_token) return false;
  try {
    const parts = creds.access_token.split('.');
    if (parts.length !== 3) return false;
    // Decode payload without verifying signature — just check expiry client-side
    const payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf-8')) as {
      exp?: number;
    };
    // Treat token as expired 5 min early to avoid race conditions
    if (payload.exp && payload.exp < Date.now() / 1000 + 300) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Load credentials from disk. Returns null if the file doesn't exist or has no valid token.
 */
export async function loadCredentials(): Promise<Credentials | null> {
  try {
    const raw = await readFile(CREDENTIALS_FILE, 'utf-8');
    return JSON.parse(raw) as Credentials;
  } catch {
    return null;
  }
}

/**
 * Load or create a minimal credentials stub (client_id only, no token).
 * Used as a placeholder before authentication completes.
 */
export async function loadOrCreateCredentials(): Promise<Credentials> {
  const existing = await loadCredentials();
  if (existing) return existing;

  const creds: Credentials = {
    client_id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
  };
  await saveCredentials(creds);
  return creds;
}

export async function saveCredentials(creds: Credentials): Promise<void> {
  await writeSecure(CREDENTIALS_FILE, JSON.stringify(creds, null, 2));
}

export async function getApiKey(): Promise<string> {
  const creds = await loadOrCreateCredentials();
  return creds.client_id;
}

/**
 * Merge authentication data into the existing credentials file.
 * Called after a successful device auth flow.
 */
export async function upgradeToAuthenticated(
  accessToken: string,
  apiKey: string,
  user: { id: string; email?: string | null; name?: string | null },
): Promise<void> {
  const existing = await loadOrCreateCredentials();
  await saveCredentials({
    ...existing,
    client_id: apiKey,
    access_token: accessToken,
    user_id: user.id,
    user_email: user.email ?? undefined,
    user_name: user.name ?? undefined,
    authenticated_at: new Date().toISOString(),
  });
}

/**
 * Remove authentication data. Next startup will automatically trigger re-auth.
 */
export async function clearAuthentication(): Promise<void> {
  const existing = await loadOrCreateCredentials();
  await saveCredentials({
    client_id: existing.client_id,
    created_at: existing.created_at,
    api_url: existing.api_url,
  });
}
