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

// Full read+write scope — a superset of .readonly, so this also covers the
// existing "Load from Sheet" reads. Storage key bumped (v2) so a token
// cached under the old readonly-only scope doesn't get reused for a write.
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const TOKEN_STORAGE_KEY = "cookorder-gis-token-v2";

const tokenSource = createGisTokenSource(SCOPE, TOKEN_STORAGE_KEY);

export const getAccessTokenSilent = tokenSource.getAccessTokenSilent;
export const requestAccessTokenInteractive = tokenSource.requestAccessTokenInteractive;
export const clearStoredToken = tokenSource.clearStoredToken;
