// Shared Google Identity Services (GIS) token-client plumbing. Both
// googleAuth.ts (Sheets) and firebaseAuth.ts (Remote Config) build an
// independent token client from this — own scope, own consent screen, own
// stored token — via createGisTokenSource(), so the two integrations never
// share a grant even though they reuse the same public OAuth client id.

export const CLIENT_ID = "929291550627-g1ev8er3cqo12lv8mnbip4uu6o9kdk7t.apps.googleusercontent.com";

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

export interface GisTokenSource {
  getAccessTokenSilent(): Promise<string | null>;
  requestAccessTokenInteractive(): Promise<string>;
  clearStoredToken(): void;
}

/**
 * One independent OAuth token client for `scope`, cached under `storageKey`.
 * Kicks off the GIS script load (and token-client init) immediately at
 * module-eval time rather than on first request, so by the time a user
 * clicks a button, requesting a token is a microtask — not a network round
 * trip — which is what lets the resulting popup still count as
 * gesture-initiated. Guarded for Vitest's Node environment, where `window`
 * doesn't exist.
 */
export function createGisTokenSource(scope: string, storageKey: string): GisTokenSource {
  let tokenClientPromise: Promise<TokenClient> | null = null;
  let pending: { resolve: (token: string) => void; reject: (err: Error) => void } | null = null;

  function ensureTokenClient(): Promise<TokenClient> {
    if (!tokenClientPromise) {
      tokenClientPromise = loadGisScript().then(() =>
        window.google!.accounts.oauth2.initTokenClient({
          client_id: CLIENT_ID,
          scope,
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

  if (typeof window !== "undefined") void ensureTokenClient();

  function storeToken(accessToken: string, expiresInSeconds: number): void {
    const stored: StoredToken = {
      accessToken,
      // Renew a minute early so a call never starts with an about-to-expire token.
      expiresAt: Date.now() + (expiresInSeconds - 60) * 1000,
    };
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(stored));
    } catch {
      // sessionStorage unavailable (private mode, etc.) — token just won't survive a reload.
    }
  }

  function readStoredToken(): string | null {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (!raw) return null;
      const stored = JSON.parse(raw) as StoredToken;
      if (Date.now() >= stored.expiresAt) return null;
      return stored.accessToken;
    } catch {
      return null;
    }
  }

  function clearStoredToken(): void {
    try {
      sessionStorage.removeItem(storageKey);
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
  async function getAccessTokenSilent(): Promise<string | null> {
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
  function requestAccessTokenInteractive(): Promise<string> {
    const cached = readStoredToken();
    if (cached) return Promise.resolve(cached);
    return requestToken("consent");
  }

  return { getAccessTokenSilent, requestAccessTokenInteractive, clearStoredToken };
}
