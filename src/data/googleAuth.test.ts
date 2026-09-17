import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGoogleAccountIdentity } from "./googleAuth.ts";

describe("Google account identity", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads and normalizes verified email from Google's UserInfo response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      email: " DaiVQ@abigames.com.vn ",
      email_verified: true,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchGoogleAccountIdentity("token")).resolves.toEqual({
      email: "daivq@abigames.com.vn",
      emailVerified: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://openidconnect.googleapis.com/v1/userinfo",
      { headers: { Authorization: "Bearer token" } },
    );
  });

  it("rejects a UserInfo response without an email", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
    await expect(fetchGoogleAccountIdentity("token")).rejects.toThrow(/email address/);
  });
});
