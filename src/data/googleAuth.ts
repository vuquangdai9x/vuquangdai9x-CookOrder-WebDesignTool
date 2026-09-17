// Google Identity Services (GIS) OAuth token flow for Sheets read+write
// access. No backend and no client secret: each user signs into their OWN
// Google account, grants the Sheets scope once, and Google enforces
// per-account Drive sharing on every subsequent API call (a 403 means "signed
// in, but this account isn't shared on that particular sheet" — see
// sheetSource.ts for reads, sheetWrite.ts for writes).
//
// The actual GIS token-client plumbing lives in googleOAuth.ts, shared with
// firebaseAuth.ts's independent Remote Config sign-in.

import { createGisTokenSource } from "./googleOAuth.ts";

// Sheets read/write plus verified account identity. The Remote Data author
// gate resolves email through Google's OIDC UserInfo endpoint after Load.
// Bump the key whenever scopes change so an older, narrower token is not reused.
const SCOPE = "openid email https://www.googleapis.com/auth/spreadsheets";
const TOKEN_STORAGE_KEY = "cookorder-gis-token-v3";

const tokenSource = createGisTokenSource(SCOPE, TOKEN_STORAGE_KEY);

export const getAccessTokenSilent = tokenSource.getAccessTokenSilent;
export const requestAccessTokenInteractive = tokenSource.requestAccessTokenInteractive;
export const clearStoredToken = tokenSource.clearStoredToken;

export interface GoogleAccountIdentity {
  email: string;
  emailVerified: boolean;
}

/** Resolve identity from the same access token used to load the sheet. */
export async function fetchGoogleAccountIdentity(token: string): Promise<GoogleAccountIdentity> {
  const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    clearStoredToken();
    throw new Error("Google identity token expired or is invalid");
  }
  if (!res.ok) throw new Error(`Google account lookup failed: ${res.status}`);
  const body = await res.json() as { email?: unknown; email_verified?: unknown };
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email) throw new Error("Google account did not provide an email address");
  return { email, emailVerified: body.email_verified === true };
}
