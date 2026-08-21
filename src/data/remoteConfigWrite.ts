// Firebase Remote Config REST API (v1) write path — used by the Remote Data
// tab's per-level "Push Remote Config" button (ui/remote/index.ts).
//
// Remote Config has no per-key write endpoint: every write GETs the whole
// current template (which comes back with an ETag), edits/creates exactly
// one parameter in place, and PUTs the whole template back with
// `If-Match: <etag>`. A stale ETag (something else changed the template
// between our GET and PUT) 409s — pushRemoteConfigParameter retries once by
// re-reading and reapplying, since two people pushing different levels
// moments apart is the expected case here, not a real conflict to surface.

import { clearStoredFirebaseToken, requestFirebaseAccessTokenInteractive } from "./firebaseAuth.ts";

export class FirebaseAuthRequiredError extends Error {
  constructor(detail: string) {
    super(`Google sign-in required for Firebase (${detail})`);
    this.name = "FirebaseAuthRequiredError";
  }
}

/** Thrown when the user IS signed in but their Google account lacks Remote Config write access on the project. */
export class FirebasePermissionError extends Error {
  constructor(detail: string) {
    super(`No access to this Firebase project's Remote Config (${detail})`);
    this.name = "FirebasePermissionError";
  }
}

interface RemoteConfigParameter {
  defaultValue?: { value?: string };
  [key: string]: unknown;
}

interface RemoteConfigTemplate {
  parameters?: Record<string, RemoteConfigParameter>;
  [key: string]: unknown;
}

function templateUrl(projectId: string): string {
  return `https://firebaseremoteconfig.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/remoteConfig`;
}

async function fetchTemplate(projectId: string, token: string): Promise<{ template: RemoteConfigTemplate; etag: string }> {
  const res = await fetch(templateUrl(projectId), { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    clearStoredFirebaseToken();
    throw new FirebaseAuthRequiredError("access token expired or invalid");
  }
  if (res.status === 403) {
    throw new FirebasePermissionError("this Google account can't read Remote Config on this project");
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Remote Config fetch failed: ${res.status}${detail ? ` — ${detail}` : ""}`);
  }
  const etag = res.headers.get("ETag") ?? "*";
  const template = (await res.json()) as RemoteConfigTemplate;
  return { template, etag };
}

/** Returns false (caller retries) on a 409 stale-ETag conflict; true once the write lands. */
async function putTemplate(projectId: string, token: string, template: RemoteConfigTemplate, etag: string): Promise<boolean> {
  const res = await fetch(templateUrl(projectId), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; UTF8",
      "If-Match": etag,
    },
    body: JSON.stringify(template),
  });
  if (res.status === 409) return false;
  if (res.status === 401) {
    clearStoredFirebaseToken();
    throw new FirebaseAuthRequiredError("access token expired or invalid");
  }
  if (res.status === 403) {
    throw new FirebasePermissionError("this Google account can't write Remote Config on this project");
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Remote Config write failed: ${res.status}${detail ? ` — ${detail}` : ""}`);
  }
  return true;
}

/**
 * Adds or updates exactly one Remote Config parameter's defaultValue,
 * leaving every other parameter in the template untouched.
 */
export async function pushRemoteConfigParameter(projectId: string, key: string, value: string): Promise<void> {
  const token = await requestFirebaseAccessTokenInteractive();
  for (let attempt = 0; attempt < 2; attempt++) {
    const { template, etag } = await fetchTemplate(projectId, token);
    const parameters = { ...(template.parameters ?? {}) };
    parameters[key] = { ...(parameters[key] ?? {}), defaultValue: { value } };
    const ok = await putTemplate(projectId, token, { ...template, parameters }, etag);
    if (ok) return;
  }
  throw new Error("Remote Config write conflicted twice — try again");
}
