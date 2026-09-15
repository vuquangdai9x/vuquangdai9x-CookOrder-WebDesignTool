import { describe, expect, it } from "vitest";
import { loadAgentLevels, parseAgentLevelIndex, parseAgentLevelProfile } from "./agentLevels.ts";

const level = {
  id: 17,
  name: "Amount Warmup",
  weather: "Sunny",
  levelTag: "Amount",
  featureUnlock: "",
  serveableSlots: 2,
  shuffleDistance: 0,
  queueString: "1*2%2",
  gridString: ",,,,,,,,,",
  customerString: "0(30,0)[1]",
};

const profile = {
  schemaVersion: 1,
  id: "mina-coffee",
  name: "Mina — Coffee",
  createdAt: "2026-09-15T00:00:00.000Z",
  updatedAt: "2026-09-15T01:00:00.000Z",
  levels: [{
    id: "coffee-amount-r4",
    mapId: "coffee",
    name: "Amount Warmup",
    weather: "Sunny",
    tag: "Amount",
    refinedInstruction: "Build an amount-focused Coffee level.",
    publishedAt: "2026-09-15T01:00:00.000Z",
    source: { sessionId: "coffee-amount", revision: 4 },
    level,
  }],
};

describe("Agent Design data", () => {
  it("parses a profile with browser-ready level data", () => {
    const parsed = parseAgentLevelProfile(profile);
    expect(parsed.name).toBe("Mina — Coffee");
    expect(parsed.levels[0].level.queueString).toBe("1*2%2");
  });

  it("rejects profile references that escape the static data directory", () => {
    expect(() => parseAgentLevelIndex({
      schemaVersion: 1,
      profiles: [{ id: "bad", name: "Bad", file: "../bad.json", levelCount: 1, updatedAt: "now" }],
    })).toThrow(/stay inside/);
  });

  it("keeps healthy profiles when another profile fails to load", async () => {
    const request = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("index.json")) {
        return Response.json({
          schemaVersion: 1,
          profiles: [
            { id: "mina-coffee", name: "Mina — Coffee", file: "profiles/mina.json", levelCount: 1, updatedAt: "now" },
            { id: "broken", name: "Broken", file: "profiles/broken.json", levelCount: 1, updatedAt: "now" },
          ],
        });
      }
      if (url.endsWith("mina.json")) return Response.json(profile);
      return new Response("missing", { status: 404 });
    };
    const loaded = await loadAgentLevels(new URL("https://example.test/agent-levels/"), request as typeof fetch);
    expect(loaded.profiles.map((item) => item.id)).toEqual(["mina-coffee"]);
    expect(loaded.warnings[0]).toMatch(/Broken/);
  });
});
