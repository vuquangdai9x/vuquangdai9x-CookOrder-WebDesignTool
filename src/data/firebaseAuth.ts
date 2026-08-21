// Google OAuth token flow for Firebase Remote Config write access — an
// independent sign-in from googleAuth.ts's Sheets one (own scope, own
// consent screen, own stored token via googleOAuth.ts's shared plumbing) so
// connecting Firebase never bundles onto — or requires — the Sheets grant.
//
// No backend, no service-account key: each user signs into their OWN Google
// account, and Firebase/GCP IAM enforces per-account write access on every
// request (a 403 means "signed in, but this account isn't a Remote Config
// Admin/Editor/Owner on that project" — see remoteConfigWrite.ts).

import { createGisTokenSource } from "./googleOAuth.ts";

const SCOPE = "https://www.googleapis.com/auth/firebase.remoteconfig";
const TOKEN_STORAGE_KEY = "cookorder-gis-token-firebase-v1";

const tokenSource = createGisTokenSource(SCOPE, TOKEN_STORAGE_KEY);

export const getFirebaseAccessTokenSilent = tokenSource.getAccessTokenSilent;
export const requestFirebaseAccessTokenInteractive = tokenSource.requestAccessTokenInteractive;
export const clearStoredFirebaseToken = tokenSource.clearStoredToken;
