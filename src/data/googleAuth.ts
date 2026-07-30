// Google Identity Services (GIS) OAuth token flow for read-only Sheets
// access. No backend and no client secret: each user signs into their OWN
// Google account, grants the readonly-Sheets scope once, and Google enforces
// per-account Drive sharing on every subsequent API call (a 403 means "signed
// in, but this account isn't on the Sheet's share list" — see sheetSource.ts).

const CLIENT_ID = "929291550627-g1ev8er3cqo12lv8mnbip4uu6o9kdk7t.apps.googleusercontent.com";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const TOKEN_STORAGE_KEY = "cookorder-gis-token";

interface StoredToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
}

interface TokenClient {
  requestAccessToken(overrideConfig?: { prompt?: string }): void;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(config: {
            client_id: string;
            scope: string;
            callback: (resp: TokenResponse) => void;
          }): TokenClient;
        };
      };
    };
  }
}

let scriptLoadPromise: Promise<void> | null = null;

function loadGisScript(): Promise<void> {
  if (scriptLoadPromise) return scriptLoadPromise;
  scriptLoadPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Google Identity Services script"));
    document.head.append(script);
  });
  return scriptLoadPromise;
}

let tokenClientPromise: Promise<TokenClient> | null = null;
/** Set for the duration of exactly one in-flight requestAccessToken() call. */
let pending: { resolve: (token: string) => void; reject: (err: Error) => void } | null = null;

function ensureTokenClient(): Promise<TokenClient> {
  if (!tokenClientPromise) {
    tokenClientPromise = loadGisScript().then(() =>
      window.google!.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPE,
        callback: (resp) => {
          const p = pending;
          pending = null;
          if (!p) return;
          if (resp.error || !resp.access_token) {
            p.reject(new Error(resp.error ?? "No access token returned"));
            return;
          }
          storeToken(resp.access_token, resp.expires_in ?? 3600);
          p.resolve(resp.access_token);
        },
      }),
    );
  }
  return tokenClientPromise;
}

// Kick the script load off immediately (module init) rather than waiting for
// the first token request — by the time the user actually clicks "Sign in",
// ensureTokenClient() below only needs a microtask, not a network round trip,
// which is what lets the resulting popup still count as gesture-initiated.
// Guarded because this module is also imported under Vitest's Node
// environment (via sheetSource.ts), where `window` doesn't exist.
if (typeof window !== "undefined") void ensureTokenClient();

function storeToken(accessToken: string, expiresInSeconds: number): void {
  const stored: StoredToken = {
    accessToken,
    // Renew a minute early so a call never starts with an about-to-expire token.
    expiresAt: Date.now() + (expiresInSeconds - 60) * 1000,
  };
  try {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // sessionStorage unavailable (private mode, etc.) — token just won't survive a reload.
  }
}

function readStoredToken(): string | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as StoredToken;
    if (Date.now() >= stored.expiresAt) return null;
    return stored.accessToken;
  } catch {
    return null;
  }
}

export function clearStoredToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // ignore
  }
}

function requestToken(prompt: string): Promise<string> {
  return ensureTokenClient().then(
    (client) =>
      new Promise<string>((resolve, reject) => {
        pending = { resolve, reject };
        client.requestAccessToken({ prompt });
      }),
  );
}

/**
 * Silent-only: resolves null instead of throwing/popping anything up if the
 * user has no active Google session or hasn't granted this scope yet. Safe
 * to call on page load.
 *
 * GIS's silent (`prompt: ""`) request can simply hang forever rather than
 * calling back — observed when third-party storage access is blocked (some
 * browsers' default privacy settings, or a sandboxed embed) so its hidden
 * iframe never gets a verdict either way. A timeout keeps that from wedging
 * the whole startup flow: no answer in time reads the same as "no session".
 */
export async function getAccessTokenSilent(): Promise<string | null> {
  const cached = readStoredToken();
  if (cached) return cached;
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000));
  try {
    return await Promise.race([requestToken(""), timeout]);
  } catch {
    return null;
  }
}

/**
 * Interactive: shows Google's account picker / consent screen. Must be
 * called directly from a user-gesture event handler (a click), not after an
 * intervening await — see the comment on ensureTokenClient() above.
 */
export function requestAccessTokenInteractive(): Promise<string> {
  const cached = readStoredToken();
  if (cached) return Promise.resolve(cached);
  return requestToken("consent");
}
